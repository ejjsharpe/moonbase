import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import {
  Harness,
  LiveDoc,
  configure,
  createRegistry,
  defineDocFamily,
  ConversationBusy,
  type ModelRef,
  type Registry,
  type ConversationId,
  type SubmissionId,
  type TaskId,
  type Cursor,
  type EntryRecord,
} from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { Models } from '@earendil-works/pi-ai/models';
import { Effect, Layer, Queue, Stream } from 'effect';
import { ApplicationError } from '@moonbase/application/client';
import type {
  ChatCommand,
  ChatInput,
  ChatOutput,
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
  ChatSession,
  ChatHistoryPage,
  ChatSendReceipt,
  ChatRun,
} from '@moonbase/application/chat-client';
import {
  ChatService,
  releaseResource,
  type ChatServiceShape,
} from '@moonbase/application/services';
import * as V from './validation.ts';

export type PiRuntimeConfiguration = ChatSession & {
  databasePath: string;
  cwd: string;
  model: ModelRef;
  models: Models;
  registry?: Registry;
};
const Request = defineDocFamily({
  kind: 'moonbase.chat.request',
  version: 1,
  scope: 'session',
  family: true,
  initial: (binding: string) => ({
    binding,
    conversationId: null as string | null,
    submissionId: null as string | null,
    pending: false as boolean,
  }),
  checkpointWhen: () => true,
});
const Store = defineDocFamily({
  kind: 'moonbase.chat.store',
  version: 1,
  scope: 'session',
  family: true,
  initial: (identity: string) => ({ identity }),
  checkpointWhen: () => true,
});
const Metadata = defineDocFamily({
  kind: 'moonbase.chat.metadata',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  family: true,
  initial: (value: { title: string; createdAt: string; identity: string }) => ({
    ...value,
    pending: 0,
  }),
  checkpointWhen: () => true,
});
const key = (actorId: string, requestId: string) => JSON.stringify([actorId, requestId]);
function numeric(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    return V.fail('InvalidInput', 'Invalid Pi record identity.');
  return Number(value);
}
const cid = (value: string) => numeric(value) as ConversationId;
const sid = (value: string) => numeric(value) as SubmissionId;
const tid = (value: string) => numeric(value) as TaskId;
const unknownOutcome = () =>
  new ApplicationError({
    code: 'Uncertain',
    message:
      'Chat operation may have committed. Preserve its exact request and query before retrying.',
  });
const safeError = (error: unknown, uncertain = false): ApplicationError => {
  if (ApplicationError.is(error)) return error;
  if (error instanceof ConversationBusy)
    return new ApplicationError({
      code: 'Conflict',
      message: 'Conversation is busy; retain this request and retry explicitly.',
    });
  if (uncertain) return unknownOutcome();
  return new ApplicationError({
    code: 'Persistence',
    message:
      'Pi storage or execution is unavailable. Reopen this explicit store after resolving its failure.',
  });
};
const readCursor = (
  value: string | undefined,
  kind: string,
  conversationId?: string,
): Cursor | undefined => {
  if (value === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(V.cursor(value), 'base64url').toString('utf8'));
    if (decoded.kind !== kind || decoded.conversationId !== conversationId) throw Error();
    return decoded.scan === null || decoded.scan?.start === true
      ? undefined
      : (V.object(decoded.scan) as Cursor);
  } catch {
    return V.fail('InvalidInput', 'This history cursor belongs to another view or is invalid.');
  }
};
const writeCursor = (scan: Cursor | undefined, kind: string, conversationId?: string) =>
  scan === undefined
    ? null
    : V.cursor(Buffer.from(JSON.stringify({ kind, conversationId, scan })).toString('base64url'));

class Host {
  readonly pending = new Set<Promise<unknown>>();
  readonly admissions = new Map<string, Promise<unknown>>();
  closed = false;
  observers = 0;
  get cursorIdentity() {
    return createHash('sha256').update(this.identity).digest('hex');
  }
  readonly config: PiRuntimeConfiguration;
  readonly harness: Harness;
  readonly env: NodeExecutionEnv;
  readonly identity: string;
  constructor(
    config: PiRuntimeConfiguration,
    harness: Harness,
    env: NodeExecutionEnv,
    identity: string,
  ) {
    this.config = config;
    this.harness = harness;
    this.env = env;
    this.identity = identity;
  }
  session(value: ChatSession) {
    if (!V.sameHost(value.host, this.config.host))
      V.fail('Incompatible', 'Chat host/store does not match this host.');
    if (value.actorId !== this.config.actorId)
      V.fail('Unauthorized', 'This personal chat belongs to another actor.');
  }
  async metadata(target: ChatTarget) {
    this.session(target);
    const meta = await this.harness.snapshot(
      Metadata,
      cid(target.conversationId),
      'metadata',
      context,
    );
    if (!meta || meta.identity !== this.identity)
      return V.fail('Unauthorized', 'Conversation does not belong to this configured actor/store.');
    return meta;
  }
  summary(conversationId: string, meta: { title: string; createdAt: string }): ChatSummary {
    return {
      target: { host: { ...this.config.host }, actorId: this.config.actorId, conversationId },
      title: meta.title,
      createdAt: meta.createdAt,
      cwd: this.config.cwd,
      model: `${this.config.model.provider}/${this.config.model.modelId}`,
    };
  }
  track<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(safeError(null));
    const promise = Promise.resolve().then(fn);
    this.pending.add(promise);
    promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  serial<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.admissions.get(conversationId) ?? Promise.resolve();
    const promise = previous.catch(() => {}).then(fn);
    this.admissions.set(conversationId, promise);
    promise
      .finally(() => {
        if (this.admissions.get(conversationId) === promise) this.admissions.delete(conversationId);
      })
      .catch(() => {});
    return promise;
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.pending);
    try {
      await this.harness.close(context);
    } finally {
      await this.env.cleanup(context);
    }
  }
  run<K extends ChatCommand>(
    operation: K,
    value: ChatInput<K>,
    handle: (data: ChatInput<K>) => Promise<ChatOutput<K>>,
  ): Effect.Effect<ChatOutput<K>, ApplicationError> {
    const mutation =
      operation === 'createChat' || operation === 'sendChat' || operation === 'stopChat';
    return Effect.tryPromise({
      try: () =>
        this.track(async () => {
          const data = V.input(operation, value);
          const result = await handle(data);
          try {
            return V.output(operation, result, data);
          } catch (error) {
            if (mutation) throw unknownOutcome();
            throw error;
          }
        }),
      catch: (error) => safeError(error, mutation),
    });
  }
  async getHost(d: ChatInput<'getChatHost'>): Promise<ChatOutput<'getChatHost'>> {
    if (!V.sameHost(d.host, this.config.host))
      V.fail('Incompatible', 'Chat host/store does not match this host.');
    await this.harness.snapshot(Store, 'identity', context);
    return {
      host: { ...this.config.host },
      actorId: this.config.actorId,
      cwd: this.config.cwd,
      model: `${this.config.model.provider}/${this.config.model.modelId}`,
    };
  }
  async list(d: ChatInput<'listChats'>): Promise<ChatOutput<'listChats'>> {
    this.session(d.session);
    let scan = readCursor(d.cursor, 'list', this.cursorIdentity),
      scanned = 0;
    const conversations: ChatSummary[] = [];
    do {
      const page = await this.harness.commit(
          (tx) => tx.scanConversations({ order: 'descending' }, 1, scan),
          context,
        ),
        row = page.items[0];
      if (!row) {
        scan = undefined;
        break;
      }
      const meta = await this.harness.snapshot(Metadata, row.id, 'metadata', context);
      if (meta?.identity === this.identity) {
        const summary = this.summary(String(row.id), meta);
        if (
          Buffer.byteLength(JSON.stringify({ conversations: [...conversations, summary] })) >
          240 * 1024
        )
          break;
        conversations.push(summary);
      }
      scan = page.next;
    } while (scan && ++scanned < 32);
    return { conversations, nextCursor: writeCursor(scan, 'list', this.cursorIdentity) };
  }
  async create(d: ChatInput<'createChat'>): Promise<ChatOutput<'createChat'>> {
    this.session(d.session);
    const binding = JSON.stringify({ operation: 'createChat', ...d });
    let conversationId: string, definiteRejection: ApplicationError | undefined;
    try {
      conversationId = await this.harness.commit(async (tx) => {
        const request = await tx.doc(Request, key(d.session.actorId, d.requestId), binding);
        if (request.binding !== binding) {
          definiteRejection = new ApplicationError({
            code: 'InvalidInput',
            message: 'Request ID is already bound to different chat input.',
          });
          throw definiteRejection;
        }
        if (request.conversationId) return request.conversationId;
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        await configure(tx, conversation.id, { model: this.config.model, cwd: this.config.cwd });
        await tx.doc(Metadata, conversation.id, 'metadata', {
          identity: this.identity,
          title: d.title,
          createdAt: new Date().toISOString(),
        });
        request.conversationId = String(conversation.id);
        return String(conversation.id);
      }, context);
    } catch (error) {
      if (definiteRejection && error === definiteRejection) throw error;
      throw unknownOutcome();
    }
    try {
      return {
        requestId: d.requestId,
        conversation: this.summary(
          conversationId,
          await this.metadata({ ...d.session, conversationId }),
        ),
      };
    } catch {
      throw unknownOutcome();
    }
  }
  async send(d: ChatInput<'sendChat'>): Promise<ChatSendReceipt> {
    await this.metadata(d.target);
    return this.serial(d.target.conversationId, async () => {
      const binding = JSON.stringify({ operation: 'sendChat', ...d }),
        requestKey = key(d.target.actorId, d.requestId);
      await this.harness.commit(async (tx) => {
        const request = await tx.doc(Request, requestKey, binding);
        if (request.binding !== binding)
          V.fail('InvalidInput', 'Request ID is already bound to different chat input.');
        const meta = await tx.doc(Metadata, cid(d.target.conversationId), 'metadata', {
          identity: this.identity,
          title: '',
          createdAt: '',
        });
        if (!request.submissionId && !request.pending) {
          if (
            !Number.isSafeInteger(meta.pending) ||
            meta.pending < 0 ||
            meta.pending === Number.MAX_SAFE_INTEGER
          )
            V.fail('Persistence', 'Stored pending-intent metadata is invalid.');
          meta.pending++;
          request.pending = true;
        }
        request.conversationId = d.target.conversationId;
      }, context);
      const existing = await this.lookup(d.target, d.requestId);
      if (existing?.admission === 'admitted') return existing;
      const conversation = await this.harness.conversation(cid(d.target.conversationId), context);
      if (!conversation) return V.fail('InvalidInput', 'Unknown conversation.');
      await conversation.submit(
        { type: 'input', requestId: requestKey, content: d.text, whenBusy: 'reject' },
        context,
      );
      return (await this.lookup(d.target, d.requestId))!;
    });
  }
  async getHistory(d: ChatInput<'getChatHistory'>): Promise<ChatHistoryPage> {
    await this.metadata(d.target);
    return this.history(d.target, d.cursor);
  }
  async getSend(d: ChatInput<'getChatSend'>): Promise<ChatSendReceipt | null> {
    await this.metadata(d.target);
    return this.lookup(d.target, d.requestId);
  }
  async lookup(target: ChatTarget, requestId: string): Promise<ChatSendReceipt | null> {
    const requestKey = key(target.actorId, requestId),
      old = await this.harness.snapshot(Request, requestKey, context);
    if (!old) return null;
    let bound: unknown;
    try {
      bound = JSON.parse(old.binding);
    } catch {
      return V.fail('Persistence', 'Stored request binding is invalid.');
    }
    const value = V.object(bound);
    if (value.operation !== 'sendChat' || !V.sameTarget(V.target(value.target), target))
      return V.fail('InvalidInput', 'Request ID is bound to another operation or target.');
    const submissionId = await this.harness.commit(async (tx) => {
      const found = await tx.submissionByRequest(cid(target.conversationId), requestKey);
      const request = await tx.doc(Request, requestKey, old.binding);
      if (found && !request.submissionId) {
        if (found.type !== 'input')
          V.fail('Persistence', 'Stored admission has an incompatible type.');
        request.submissionId = String(found.id);
        const meta = await tx.doc(Metadata, cid(target.conversationId), 'metadata', {
          identity: this.identity,
          title: '',
          createdAt: '',
        });
        if (request.pending) {
          if (!Number.isSafeInteger(meta.pending) || meta.pending < 1)
            V.fail('Persistence', 'Stored pending-intent metadata is invalid.');
          meta.pending--;
          request.pending = false;
        }
      }
      return request.submissionId;
    }, context);
    return submissionId
      ? { target, requestId, admission: 'admitted', submissionId }
      : { target, requestId, admission: 'reserved', submissionId: null };
  }
  async history(
    target: ChatTarget,
    encoded?: string,
    base: unknown = {},
  ): Promise<ChatHistoryPage> {
    let scan = readCursor(encoded, 'history', this.cursorIdentity + ':' + target.conversationId);
    const entries: ChatHistoryPage['entries'] = [];
    let scanned = 0;
    do {
      const page = await this.harness.commit(
        (tx) =>
          tx.scanEntries(
            { conversationId: cid(target.conversationId), order: 'descending' },
            1,
            scan,
          ),
        context,
      );
      const row = page.items[0];
      if (!row) {
        scan = undefined;
        break;
      }
      const entry = entryPreview(row);
      const candidate = {
        ...(base as object),
        entries: entry ? [...entries, entry] : entries,
        olderCursor: writeCursor(
          page.next,
          'history',
          this.cursorIdentity + ':' + target.conversationId,
        ),
      };
      if (Buffer.byteLength(JSON.stringify(candidate)) > 250 * 1024)
        return {
          entries,
          olderCursor: writeCursor(
            scan ?? { start: true },
            'history',
            this.cursorIdentity + ':' + target.conversationId,
          ),
        };
      if (entry) entries.push(entry);
      scan = page.next;
    } while (scan && ++scanned < 32);
    return {
      entries,
      olderCursor: writeCursor(
        scan ?? undefined,
        'history',
        this.cursorIdentity + ':' + target.conversationId,
      ),
    };
  }
  async snapshot(target: ChatTarget): Promise<ChatSnapshot> {
    const meta = await this.metadata(target),
      live = await this.harness.snapshot(LiveDoc, cid(target.conversationId), context);
    let run: ChatRun | null = null,
      parked = false;
    if (live?.run) {
      const task = await this.harness.getTask(live.run.taskId, context),
        submissionId = live.run.inputs[0];
      parked = (task?.restarts ?? 0) >= 5;
      const tools = await Promise.all(
        (live.tools ?? []).slice(0, 8).map(async (tool) => {
          const entry = tool.entry
            ? await this.harness.commit((tx) => tx.entry(tool.entry!), context)
            : undefined;
          const result = entry?.model?.find((message) => message.role === 'toolResult');
          const text =
            result?.role === 'toolResult'
              ? result.content
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text)
                  .join('')
              : (tool.output ?? '');
          let toolState: 'running' | 'completed' | 'failed' = 'running';
          if (tool.status === 'done')
            toolState = result?.role === 'toolResult' && !result.isError ? 'completed' : 'failed';
          return {
            taskId: String(tool.taskId ?? live.run!.taskId),
            name: V.preview(tool.name, 128).text,
            state: toolState,
            ...V.preview(text),
          };
        }),
      );
      let runState: ChatRun['state'] = 'running';
      if (task?.abortRequested) runState = 'stopping';
      else if (live.generation?.deferred) runState = 'deferred';
      if (submissionId)
        run = {
          stop: { target, submissionId: String(submissionId), taskId: String(live.run.taskId) },
          state: runState,
          ...V.preview(
            live.generation?.message?.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('') ?? '',
          ),
          tools,
        };
    }
    const latest = (
      await this.harness.commit(
        (tx) =>
          tx.scanTasks(
            {
              conversationId: cid(target.conversationId),
              kind: 'pi.generation',
              order: 'descending',
            },
            1,
          ),
        context,
      )
    ).items[0];
    let state: ChatSnapshot['state'];
    if (parked) state = 'failed';
    else if (run) state = 'running';
    else if (meta.pending) state = 'uncertain';
    else if (latest?.state.status === 'terminal' && latest.state.outcome.status === 'aborted')
      state = 'stopped';
    else if (latest?.state.status === 'terminal' && latest.state.outcome.status !== 'completed')
      state = 'failed';
    else state = 'idle';
    let message: string | undefined;
    if (parked)
      message =
        'Pi parked this task after repeated interruption. Preserve its receipt and resolve the host failure.';
    else if (meta.pending)
      message = 'Pending Send intent is retained; query or retry its original request explicitly.';
    else if (state === 'failed') message = 'Pi could not complete the last submission.';
    const base = {
      conversation: this.summary(target.conversationId, meta),
      run,
      state,
      ...(message === undefined ? {} : { message }),
    };
    return { ...base, ...(await this.history(target, undefined, base)) };
  }
  async stop(d: ChatInput<'stopChat'>): Promise<ChatOutput<'stopChat'>> {
    await this.metadata(d.stop.target);
    const binding = JSON.stringify({ operation: 'stopChat', ...d }),
      requestKey = key(d.stop.target.actorId, d.requestId);
    await this.harness.commit(async (tx) => {
      const request = await tx.doc(Request, requestKey, binding);
      if (request.binding !== binding)
        V.fail('InvalidInput', 'Request ID is already bound to different chat input.');
    }, context);
    const submission = await this.harness.submission(sid(d.stop.submissionId), context);
    const record = await submission?.status(context);
    if (!record || record.conversationId !== cid(d.stop.target.conversationId))
      V.fail('InvalidInput', 'Stop submission does not belong to this conversation.');
    let outcome: ChatOutput<'stopChat'>['outcome'];
    if (d.stop.taskId === null) {
      const result = await this.harness.abortSubmission(
        sid(d.stop.submissionId),
        context,
        cid(d.stop.target.conversationId),
      );
      if (result === 'aborted') outcome = 'stopped';
      else if (result === 'settled') outcome = 'terminal';
      else outcome = 'superseded';
    } else {
      const live = await this.harness.snapshot(LiveDoc, cid(d.stop.target.conversationId), context),
        task = await this.harness.getTask(tid(d.stop.taskId), context);
      if (!task || task.conversationId !== cid(d.stop.target.conversationId))
        V.fail('InvalidInput', 'Stop task does not belong to this conversation.');
      if (task!.state.status === 'terminal') outcome = 'terminal';
      else if (
        live?.run?.taskId !== tid(d.stop.taskId) ||
        !live.run.inputs.includes(sid(d.stop.submissionId))
      )
        outcome = 'superseded';
      else {
        const abort = this.harness
          .abortTask(tid(d.stop.taskId), context)
          .then(() => this.harness.waitForTask(tid(d.stop.taskId!), context));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          outcome = await Promise.race([
            abort.then(() => 'stopped' as const),
            new Promise<'pending'>((resolve) => {
              timer = setTimeout(() => resolve('pending'), 1000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    }
    return { stop: d.stop, requestId: d.requestId, outcome };
  }
  watch(target: ChatTarget) {
    // oxlint-disable-next-line no-this-alias -- The Effect generator retains the host owner.
    const self = this;
    return Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.sliding<void>(1);
        yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              V.target(target);
              self.session(target);
              if (self.observers >= 64) V.fail('Unavailable', 'Too many chat observers.');
              self.observers++;
              const refresh = () => Queue.offerUnsafe(queue, undefined);
              let off = () => {};
              try {
                off = self.harness.subscribeCommits(refresh);
                const close = self.harness.subscribeClose(refresh);
                refresh();
                return () => {
                  try {
                    off();
                  } finally {
                    try {
                      close();
                    } finally {
                      self.observers--;
                    }
                  }
                };
              } catch (error) {
                try {
                  off();
                } finally {
                  self.observers--;
                }
                throw error;
              }
            },
            catch: ApplicationError.fromUnknown,
          }),
          (off) => releaseResource(off),
        );
        return Stream.fromQueue(queue).pipe(
          Stream.mapEffect(() => self.run('getChat', { target }, (d) => self.snapshot(d.target))),
        );
      }),
    );
  }
}
function entryPreview(entry: EntryRecord): ChatHistoryPage['entries'][number] | null {
  const message = entry.model?.[0];
  if (!message) return null;
  const role = message.role === 'toolResult' ? 'tool' : message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') return null;
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join('');
  const failed = message.role === 'assistant' && message.stopReason === 'error';
  return {
    id: String(entry.id),
    role,
    ...V.preview(failed ? 'Model response failed.' : text),
    ...(message.role === 'toolResult'
      ? { toolName: V.preview(message.toolName, 128).text, isError: message.isError }
      : {}),
  };
}
async function open(config: PiRuntimeConfiguration): Promise<Host> {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 26 || (major === 26 && minor < 13))
    V.fail(
      'Incompatible',
      'The Pi host requires qualified Node 26.13 or newer. The remote client has its own runtime boundary.',
    );
  const session = V.session({ host: config.host, actorId: config.actorId });
  if (!isAbsolute(config.databasePath) || !isAbsolute(config.cwd))
    V.fail('InvalidInput', 'Configure explicit absolute store and working-directory paths.');
  const cwd = await realpath(config.cwd);
  if (!(await stat(cwd)).isDirectory())
    V.fail('InvalidInput', 'Chat working directory must exist.');
  const model = {
    provider: V.id(config.model.provider),
    modelId: V.string(config.model.modelId, 256),
  };
  if (!config.models.getModel(model.provider, model.modelId))
    V.fail('InvalidInput', 'Configured Pi model is not installed in the host model registry.');
  const validated = { ...config, ...session, cwd, model };
  const identity = JSON.stringify({ ...session, cwd, model });
  const database = await openNodeSqliteDatabase(config.databasePath, { busyTimeoutMs: 30 });
  let storage: SqliteStorage | undefined, harness: Harness | undefined;
  const env = new NodeExecutionEnv({ cwd });
  try {
    await database.exec('PRAGMA locking_mode=EXCLUSIVE');
    await database.transaction(async (tx) => {
      await tx.exec(
        'CREATE TABLE IF NOT EXISTS moonbase_owner_lock (singleton INTEGER PRIMARY KEY)',
      );
      await tx.run('INSERT OR REPLACE INTO moonbase_owner_lock VALUES (1)');
    });
    storage = await SqliteStorage.open(database);
    harness = await Harness.open(
      storage,
      {
        models: config.models,
        registry: config.registry ?? createRegistry(),
        env: () => env,
        settings: { retry: { enabled: false }, compaction: { enabled: false }, restartLimit: 5 },
      },
      context,
    );
    const existing = await harness.snapshot(Store, 'identity', context);
    await harness.commit(async (tx) => {
      if (!existing && (await tx.scanConversations({}, 1)).items.length)
        V.fail(
          'Incompatible',
          'This store contains data without Moonbase ownership metadata; no import is authorized.',
        );
      const store = await tx.doc(Store, 'identity', identity);
      if (store.identity !== identity)
        V.fail(
          'Incompatible',
          'Store is already bound to another host, actor, working directory or model.',
        );
    }, context);
    const host = new Host(validated, harness, env, identity);
    harness.resume();
    return host;
  } catch (error) {
    if (harness) await harness.close(context);
    else if (storage) await storage.close(context);
    else await database.close();
    await env.cleanup(context);
    throw error;
  }
}
export const PiRuntimeLive = (
  config: PiRuntimeConfiguration,
): Layer.Layer<ChatService, ApplicationError> =>
  Layer.effect(
    ChatService,
    Effect.gen(function* () {
      const host = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => open(config), catch: safeError }),
        (host) => releaseResource(() => host.close()),
      );
      return {
        getChatHost: (d) => host.run('getChatHost', d, (input) => host.getHost(input)),
        listChats: (d) => host.run('listChats', d, (input) => host.list(input)),
        createChat: (d) => host.run('createChat', d, (input) => host.create(input)),
        getChat: (d) => host.run('getChat', d, (input) => host.snapshot(input.target)),
        getChatHistory: (d) => host.run('getChatHistory', d, (input) => host.getHistory(input)),
        sendChat: (d) => host.run('sendChat', d, (input) => host.send(input)),
        getChatSend: (d) => host.run('getChatSend', d, (input) => host.getSend(input)),
        stopChat: (d) => host.run('stopChat', d, (input) => host.stop(input)),
        watch: ({ target }) => host.watch(target),
      } satisfies ChatServiceShape;
    }),
  );
