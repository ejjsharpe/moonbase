import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context, withCancel } from '@earendil-works/chord/context';
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
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { Models } from '@earendil-works/pi-ai/models';
import {
  Context,
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import { normalizeApplicationError } from '@moonbase/effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import type {
  ChatCreationSettings,
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
} from '@moonbase/contracts/chat';
import { releaseResource } from '@moonbase/effect';
import { ChatService, type ChatServiceShape } from '@moonbase/contracts/services';
import * as V from './validation.ts';
import * as S from './private-schema.ts';

export type PiRuntimeConfiguration = ChatSession & {
  databasePath: string;
  cwd: string;
  model: ModelRef;
  models: Models;
  registry?: Registry;
};
export type LocalPiRuntimeConfiguration = ChatSession & {
  databasePath: string;
  models: Models;
  registry?: Registry;
  approveCreation?: (settings: ChatCreationSettings) => Promise<void>;
};
type RuntimeConfiguration =
  | PiRuntimeConfiguration
  | (LocalPiRuntimeConfiguration & { mode: 'local' });
/** Privileged shutdown control; it grants no renderer capability. */
export class LocalPiControl extends Context.Service<
  LocalPiControl,
  {
    setAdmissionsOpen(open: boolean): void;
    hasActiveWork(): Effect.Effect<boolean, ApplicationError>;
  }
>()('moonbase/LocalPiControl') {}
const Request = defineDocFamily({
  kind: 'moonbase.chat.request',
  version: 1,
  scope: 'session',
  family: true,
  initial: (binding: string) => {
    const input = S.savedBinding(binding);
    return {
      binding,
      conversationId: input.operation === 'sendChat' ? input.target.conversationId : null,
      submissionId: null as string | null,
      pending: false as boolean,
    };
  },
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
  initial: (value: {
    title: string;
    createdAt: string;
    identity: string;
    settings?: ChatCreationSettings;
  }) => ({
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
  try {
    if (error instanceof ConversationBusy)
      return new ApplicationError({
        code: 'Conflict',
        message: 'Conversation is busy; retain this request and retry explicitly.',
      });
  } catch {
    /* Unknown SDK diagnostics remain private. */
  }
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
    const decoded = S.cursorEnvelope(
      JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(V.cursor(value), 'base64url')),
      ),
    );
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
  readonly admissions = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  closed = false;
  observers = 0;
  get cursorIdentity() {
    return createHash('sha256').update(this.identity).digest('hex');
  }
  admissionsOpen = true;
  mutations = 0;
  readonly config: RuntimeConfiguration;
  readonly harness: Harness;
  readonly identity: string;
  readonly work: FiberSet.FiberSet<unknown, ApplicationError>;
  readonly aborts: RetainedWork;
  readonly waiters: RetainedWork;
  readonly observations: Scope.Closeable;
  constructor(
    config: RuntimeConfiguration,
    harness: Harness,
    identity: string,
    work: FiberSet.FiberSet<unknown, ApplicationError>,
    aborts: RetainedWork,
    waiters: RetainedWork,
    observations: Scope.Closeable,
  ) {
    this.config = config;
    this.harness = harness;
    this.identity = identity;
    this.work = work;
    this.aborts = aborts;
    this.waiters = waiters;
    this.observations = observations;
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
    const saved = S.savedMetadata(meta);
    if ('mode' in this.config && !saved.settings)
      return V.fail(
        'Persistence',
        'Stored local conversation settings are missing; preserve this store.',
      );
    if (!('mode' in this.config) && saved.settings)
      return V.fail(
        'Persistence',
        'Remote conversation has incompatible settings; preserve this store.',
      );
    return saved;
  }
  getSettings(meta: { settings?: ChatCreationSettings }): ChatCreationSettings {
    if ('mode' in this.config) {
      if (!meta.settings)
        return V.fail('Persistence', 'Stored local conversation settings are missing.');
      return meta.settings;
    }
    if (meta.settings)
      return V.fail(
        'Persistence',
        'Remote conversation has incompatible settings; preserve this store.',
      );
    return { cwd: this.config.cwd, model: this.config.model };
  }
  summary(
    conversationId: string,
    meta: { title: string; createdAt: string; settings?: ChatCreationSettings },
  ): ChatSummary {
    const settings = this.getSettings(meta);
    return {
      target: { host: { ...this.config.host }, actorId: this.config.actorId, conversationId },
      title: meta.title,
      createdAt: meta.createdAt,
      cwd: settings.cwd,
      model: `${settings.model.provider}/${settings.model.modelId}`,
    };
  }
  own<A>(effect: Effect.Effect<A, ApplicationError>) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const fiber = yield* FiberSet.run(this.work, effect);
        return yield* restore(Fiber.join(fiber)).pipe(
          Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe())),
        );
      }),
    );
  }
  admission<A>(conversationId: string, effect: Effect.Effect<A, ApplicationError>) {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        let gate = this.admissions.get(conversationId);
        if (!gate) {
          gate = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          this.admissions.set(conversationId, gate);
        }
        gate.users++;
        return gate;
      }),
      (gate) =>
        gate.semaphore.withPermit(
          Effect.uninterruptible(
            Effect.suspend(() => (this.closed ? Effect.fail(safeError(null)) : effect)),
          ),
        ),
      (gate) =>
        Effect.sync(() => {
          if (--gate.users === 0) this.admissions.delete(conversationId);
        }),
    );
  }
  run<K extends ChatCommand>(
    operation: K,
    value: ChatInput<K>,
    handle: (
      data: ChatInput<K>,
    ) => Promise<ChatOutput<K>> | Effect.Effect<ChatOutput<K>, ApplicationError>,
  ): Effect.Effect<ChatOutput<K>, ApplicationError> {
    const mutation =
      operation === 'createChat' || operation === 'sendChat' || operation === 'stopChat';
    return Effect.gen({ self: this }, function* () {
      const data = yield* Effect.try({
        try: () => V.input(operation, value),
        catch: normalizeApplicationError,
      });
      if (this.closed) return yield* Effect.fail(safeError(null));
      if (mutation && !this.admissionsOpen)
        return yield* Effect.fail(
          new ApplicationError({
            code: 'Unavailable',
            message: 'Local chat is preparing to quit.',
          }),
        );
      const preflight =
        operation === 'sendChat'
          ? Effect.uninterruptible(
              Effect.tryPromise({
                try: () => this.metadata((data as ChatInput<'sendChat'>).target),
                catch: safeError,
              }),
            )
          : Effect.void;
      const invoke = Effect.suspend(() => {
        const result = handle(data);
        return Effect.isEffect(result)
          ? result
          : Effect.tryPromise({ try: () => result, catch: (error) => safeError(error, mutation) });
      }).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: () => V.output(operation, result, data),
            catch: (error) => (mutation ? unknownOutcome() : safeError(error)),
          }),
        ),
      );
      if (mutation) this.mutations++;
      const admission =
        operation === 'sendChat'
          ? this.admission((data as ChatInput<'sendChat'>).target.conversationId, invoke)
          : Effect.uninterruptible(invoke);
      return yield* this.own(
        preflight.pipe(
          Effect.andThen(admission),
          Effect.ensuring(
            Effect.sync(() => {
              if (mutation) this.mutations--;
            }),
          ),
        ),
      );
    });
  }
  async getHost(d: ChatInput<'getChatHost'>): Promise<ChatOutput<'getChatHost'>> {
    if (!V.sameHost(d.host, this.config.host))
      V.fail('Incompatible', 'Chat host/store does not match this host.');
    S.savedStore(await this.harness.snapshot(Store, 'identity', context));
    if ('mode' in this.config)
      return { host: { ...this.config.host }, actorId: this.config.actorId, mode: 'local' };
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
        const summary = this.summary(String(row.id), S.savedMetadata(meta));
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
    if ('mode' in this.config !== (d.settings !== undefined))
      V.fail('InvalidInput', 'Choose folder/model settings for local chats only.');
    const binding = JSON.stringify({ operation: 'createChat', ...d });
    const existing =
      'mode' in this.config
        ? await this.harness.snapshot(Request, key(d.session.actorId, d.requestId), context)
        : undefined;
    if (existing) {
      S.savedRequest(existing, d.session.actorId, d.requestId);
      if (existing.binding !== binding)
        V.fail('InvalidInput', 'Request ID is already bound to different chat input.');
      if (existing.conversationId)
        return {
          requestId: d.requestId,
          conversation: this.summary(
            existing.conversationId,
            await this.metadata({ ...d.session, conversationId: existing.conversationId }),
          ),
        };
    }
    let settings: ChatCreationSettings;
    if ('mode' in this.config) {
      const cwd = await realpath(d.settings!.cwd).catch(() =>
        V.fail('InvalidInput', 'Choose an existing local working folder.'),
      );
      if (cwd !== d.settings!.cwd || !(await stat(cwd)).isDirectory())
        V.fail('InvalidInput', 'Choose a canonical local working folder.');
      if (!this.config.models.getModel(d.settings!.model.provider, d.settings!.model.modelId))
        V.fail('InvalidInput', 'Choose an installed model from the local catalog.');
      settings = d.settings!;
      await this.config.approveCreation?.(settings);
    } else settings = { cwd: this.config.cwd, model: this.config.model };
    let conversationId: string, definiteRejection: ApplicationError | undefined;
    try {
      conversationId = await this.harness.commit(async (tx) => {
        const request = await tx.doc(Request, key(d.session.actorId, d.requestId), binding);
        try {
          S.savedRequest(request, d.session.actorId, d.requestId);
        } catch (error) {
          definiteRejection = normalizeApplicationError(error);
          throw definiteRejection;
        }
        if (request.binding !== binding) {
          definiteRejection = new ApplicationError({
            code: 'InvalidInput',
            message: 'Request ID is already bound to different chat input.',
          });
          throw definiteRejection;
        }
        if (request.conversationId) return request.conversationId;
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        await configure(tx, conversation.id, settings);
        await tx.doc(Metadata, conversation.id, 'metadata', {
          identity: this.identity,
          title: d.title,
          createdAt: new Date().toISOString(),
          ...('mode' in this.config ? { settings } : {}),
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
    const binding = JSON.stringify({ operation: 'sendChat', ...d }),
      requestKey = key(d.target.actorId, d.requestId);
    await this.harness.commit(async (tx) => {
      const request = await tx.doc(Request, requestKey, binding);
      S.savedRequest(request, d.target.actorId, d.requestId);
      if (request.binding !== binding)
        V.fail('InvalidInput', 'Request ID is already bound to different chat input.');
      const meta = await tx.doc(Metadata, cid(d.target.conversationId), 'metadata', {
        identity: this.identity,
        title: '',
        createdAt: '',
      });
      S.savedMetadata(meta);
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
    S.savedRequest(old, target.actorId, requestId);
    const value = S.savedBinding(old.binding);
    if (value.operation !== 'sendChat' || !V.sameTarget(value.target, target))
      return V.fail('InvalidInput', 'Request ID is bound to another operation or target.');
    if (old.conversationId !== target.conversationId)
      V.fail('Persistence', 'Stored request conversation is invalid.');
    const submissionId = await this.harness.commit(async (tx) => {
      const found = await tx.submissionByRequest(cid(target.conversationId), requestKey);
      const request = await tx.doc(Request, requestKey, old.binding);
      S.savedRequest(request, target.actorId, requestId);
      if (request.submissionId && (!found || String(found.id) !== request.submissionId))
        V.fail('Persistence', 'Stored admission identity is invalid.');
      if (found && found.type !== 'input')
        V.fail('Persistence', 'Stored admission has an incompatible type.');
      if (found && !request.submissionId) {
        request.submissionId = String(found.id);
        const meta = await tx.doc(Metadata, cid(target.conversationId), 'metadata', {
          identity: this.identity,
          title: '',
          createdAt: '',
        });
        S.savedMetadata(meta);
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
    if ('mode' in this.config) {
      const cwd = this.getSettings(meta).cwd;
      const available = await realpath(cwd)
        .then(async (canonical) => canonical === cwd && (await stat(cwd)).isDirectory())
        .catch(() => false);
      if (!available)
        message = [
          message,
          'The saved local working folder is unavailable. Restore its original path, or create another conversation with a new folder.',
        ]
          .filter(Boolean)
          .join(' ');
    }
    const base = {
      conversation: this.summary(target.conversationId, meta),
      run,
      state,
      ...(message === undefined ? {} : { message }),
    };
    return { ...base, ...(await this.history(target, undefined, base)) };
  }
  async hasActiveWork(): Promise<boolean> {
    if (this.mutations || this.admissions.size) return true;
    let scan: Cursor | undefined;
    do {
      const page = await this.harness.commit((tx) => tx.scanTasks({}, 32, scan), context);
      if (page.items.some((task) => task.state.status !== 'terminal')) return true;
      scan = page.next;
    } while (scan);
    scan = undefined;
    do {
      const page = await this.harness.commit((tx) => tx.scanConversations({}, 32, scan), context);
      for (const conversation of page.items) {
        const meta = await this.metadata({
          ...this.config,
          conversationId: String(conversation.id),
        });
        if (meta.pending) return true;
      }
      scan = page.next;
    } while (scan);
    return this.mutations > 0;
  }
  stop(d: ChatInput<'stopChat'>): Effect.Effect<ChatOutput<'stopChat'>, ApplicationError> {
    return Effect.gen({ self: this }, function* () {
      const captured = yield* Effect.tryPromise({
        try: async () => {
          await this.metadata(d.stop.target);
          const binding = JSON.stringify({ operation: 'stopChat', ...d }),
            requestKey = key(d.stop.target.actorId, d.requestId);
          await this.harness.commit(async (tx) => {
            const request = await tx.doc(Request, requestKey, binding);
            S.savedRequest(request, d.stop.target.actorId, d.requestId);
            if (request.binding !== binding)
              V.fail('InvalidInput', 'Request ID is already bound to different chat input.');
          }, context);
          const submission = await this.harness.submission(sid(d.stop.submissionId), context),
            record = await submission?.status(context);
          if (!record || record.conversationId !== cid(d.stop.target.conversationId))
            V.fail('InvalidInput', 'Stop submission does not belong to this conversation.');
          if (d.stop.taskId === null) {
            const result = await this.harness.abortSubmission(
              sid(d.stop.submissionId),
              context,
              cid(d.stop.target.conversationId),
            );
            if (result === 'aborted') return 'stopped';
            return result === 'settled' ? 'terminal' : 'superseded';
          }
          const live = await this.harness.snapshot(
              LiveDoc,
              cid(d.stop.target.conversationId),
              context,
            ),
            task = await this.harness.getTask(tid(d.stop.taskId), context);
          if (!task || task.conversationId !== cid(d.stop.target.conversationId))
            V.fail('InvalidInput', 'Stop task does not belong to this conversation.');
          if (task!.state.status === 'terminal') return 'terminal';
          if (
            live?.run?.taskId !== tid(d.stop.taskId) ||
            !live.run.inputs.includes(sid(d.stop.submissionId))
          )
            return 'superseded';
          return null;
        },
        catch: (error) => safeError(error, true),
      });
      let outcome: ChatOutput<'stopChat'>['outcome'] = captured ?? 'pending';
      if (captured === null) {
        // The deadline owns only this join; the abort request stays with the host through settlement.
        const joined = yield* Effect.interruptible(
          Effect.gen({ self: this }, function* () {
            const abort = yield* this.aborts.run(
              Effect.tryPromise({
                try: () => this.harness.abortTask(tid(d.stop.taskId!), context),
                catch: safeError,
              }),
            );
            yield* Fiber.join(abort);
            const waiter = yield* this.waiters.run(this.terminal(tid(d.stop.taskId!)));
            return yield* Fiber.join(waiter).pipe(Effect.ensuring(Fiber.interrupt(waiter)));
          }).pipe(Effect.timeoutOption('1 second')),
        );
        outcome = Option.isSome(joined) ? 'stopped' : 'pending';
      }
      return { stop: d.stop, requestId: d.requestId, outcome };
    });
  }
  terminal(taskId: TaskId) {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const waiter = withCancel(context);
        const cancellation = new DOMException('Chat terminal wait closed.', 'AbortError');
        const settled = this.harness.waitForTask(taskId, waiter.context).then(
          () => Exit.void,
          (error) => (error === cancellation ? Exit.void : Exit.fail(safeError(error))),
        );
        return { ...waiter, cancellation, settled };
      }),
      ({ settled }) => Effect.promise(() => settled).pipe(Effect.flatMap((exit) => exit)),
      ({ cancel, cancellation, settled }) =>
        Effect.sync(() => cancel(cancellation)).pipe(
          Effect.andThen(Effect.promise(() => settled)),
          Effect.flatMap((exit) => exit.pipe(Effect.orDie)),
        ),
    );
  }
  watch(target: ChatTarget) {
    return Stream.unwrap(
      Effect.gen({ self: this }, function* () {
        const queue = yield* Queue.sliding<void>(1);
        const scope = yield* Effect.acquireRelease(Scope.fork(this.observations), (scope) =>
          Scope.close(scope, Exit.void),
        );
        yield* Scope.provide(scope)(
          Effect.gen({ self: this }, function* () {
            yield* Effect.addFinalizer(() => Queue.shutdown(queue));
            yield* Effect.acquireRelease(
              Effect.try({
                try: () => {
                  V.target(target);
                  this.session(target);
                  if (this.closed || this.observers >= 64)
                    V.fail('Unavailable', 'Chat observation is unavailable.');
                  this.observers++;
                },
                catch: normalizeApplicationError,
              }),
              () =>
                Effect.sync(() => {
                  this.observers--;
                }),
            );
            const refresh = () => Queue.offerUnsafe(queue, undefined);
            yield* Effect.acquireRelease(
              Effect.try({
                try: () => this.harness.subscribeCommits(refresh),
                catch: normalizeApplicationError,
              }),
              (off) => releaseResource(off),
            );
            yield* Effect.acquireRelease(
              Effect.try({
                try: () => this.harness.subscribeClose(refresh),
                catch: normalizeApplicationError,
              }),
              (off) => releaseResource(off),
            );
            refresh();
          }),
        );
        return Stream.fromQueue(queue).pipe(
          Stream.mapEffect(() => this.run('getChat', { target }, (d) => this.snapshot(d.target))),
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
type RetainedWork = {
  run<A>(
    effect: Effect.Effect<A, ApplicationError>,
  ): Effect.Effect<Fiber.Fiber<A, ApplicationError>>;
};
// Abort requests and terminal cleanup failures remain observable after a caller's deadline.
function retainedWork(kind: 'abort' | 'waiter'): Effect.Effect<RetainedWork, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const work = yield* Scope.provide(scope)(FiberSet.make<unknown, ApplicationError>());
    const failures = yield* Ref.make<Cause.Cause<ApplicationError>>(Cause.empty);
    yield* Effect.addFinalizer(() =>
      FiberSet.clear(work).pipe(
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.ensuring(
          Ref.get(failures).pipe(
            Effect.flatMap((cause) =>
              cause.reasons.length
                ? Effect.failCause(
                    Cause.fromReasons<never>(
                      cause.reasons.map((reason) =>
                        Cause.isFailReason(reason) ? Cause.makeDieReason(reason.error) : reason,
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
        ),
      ),
    );
    return {
      run: <A>(effect: Effect.Effect<A, ApplicationError>) => {
        const observed = effect.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Ref.update(failures, (cause) => Cause.combine(cause, exit.cause))
              : Effect.void,
          ),
        );
        // Capture abort failure before restoring interruption after the noncancelable SDK call.
        return FiberSet.run(work, kind === 'abort' ? Effect.uninterruptible(observed) : observed);
      },
    };
  });
}

function open(config: RuntimeConfiguration) {
  return Effect.gen(function* () {
    const validated = yield* Effect.tryPromise({
      try: async () => {
        const [major, minor] = process.versions.node.split('.').map(Number);
        const local = 'mode' in config;
        const qualifiedElectron =
          process.versions.electron === '45.1.0' && process.versions.node === '24.22.1';
        if (
          local
            ? !qualifiedElectron && (major < 26 || (major === 26 && minor < 13))
            : major < 26 || (major === 26 && minor < 13)
        )
          V.fail(
            'Incompatible',
            'The Pi host requires qualified Node 26.13 or newer. The remote client has its own runtime boundary.',
          );
        if (local) return S.localConfiguration(config);
        const data = S.runtimeConfiguration(config),
          cwd = await realpath(data.cwd);
        if (!(await stat(cwd)).isDirectory())
          V.fail('InvalidInput', 'Chat working directory must exist.');
        if (!data.models.getModel(data.model.provider, data.model.modelId))
          V.fail(
            'InvalidInput',
            'Configured Pi model is not installed in the host model registry.',
          );
        return { ...data, cwd };
      },
      catch: safeError,
    });
    const session = { host: validated.host, actorId: validated.actorId },
      identity = JSON.stringify(
        'mode' in validated
          ? { ...session, mode: 'local' }
          : { ...session, cwd: validated.cwd, model: validated.model },
      );
    const environments = new Map<string, NodeExecutionEnv>();
    yield* Effect.addFinalizer(() =>
      Effect.all(
        [...environments.values()].map((env) =>
          Effect.exit(releaseResource(() => env.cleanup(context))),
        ),
        { concurrency: 'unbounded' },
      ).pipe(
        Effect.flatMap((exits) => {
          const cause = exits.reduce(
            (cause, exit) => (Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause),
            Cause.empty,
          );
          return cause.reasons.length ? Effect.failCause(cause) : Effect.void;
        }),
      ),
    );
    if (!('mode' in validated))
      environments.set(validated.cwd, new NodeExecutionEnv({ cwd: validated.cwd }));
    const getToolEnvironment = async (target: { conversationId: ConversationId; cwd?: string }) => {
      let cwd: string;
      if ('mode' in validated) {
        const meta = await host.metadata({
          ...session,
          conversationId: String(target.conversationId),
        });
        cwd = host.getSettings(meta).cwd;
        if (target.cwd !== cwd || (await realpath(cwd)) !== cwd || !(await stat(cwd)).isDirectory())
          V.fail(
            'Unavailable',
            'The saved local working folder is unavailable. Restore it before retrying.',
          );
      } else cwd = validated.cwd;
      let env = environments.get(cwd);
      if (!env) {
        env = new NodeExecutionEnv({ cwd });
        environments.set(cwd, env);
      }
      return env;
    };
    let databaseOwned = true,
      storageOwned = true;
    const database = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => openNodeSqliteDatabase(validated.databasePath, { busyTimeoutMs: 30 }),
        catch: safeError,
      }),
      (database) => releaseResource(() => (databaseOwned ? database.close() : undefined)),
    );
    yield* Effect.tryPromise({
      try: async () => {
        await database.exec('PRAGMA locking_mode=EXCLUSIVE');
        await database.transaction(async (tx) => {
          await tx.exec(
            'CREATE TABLE IF NOT EXISTS moonbase_owner_lock (singleton INTEGER PRIMARY KEY)',
          );
          await tx.run('INSERT OR REPLACE INTO moonbase_owner_lock VALUES (1)');
        });
      },
      catch: safeError,
    });
    const storage = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => SqliteStorage.open(database), catch: safeError }),
      (storage) => releaseResource(() => (storageOwned ? storage.close(context) : undefined)),
    );
    databaseOwned = false;
    const aborts = yield* retainedWork('abort');
    const harness = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          Harness.open(
            storage,
            {
              models: validated.models,
              registry: validated.registry ?? createRegistry(),
              env: getToolEnvironment,
              settings: {
                retry: { enabled: false },
                compaction: { enabled: false },
                restartLimit: 5,
              },
            },
            context,
          ),
        catch: safeError,
      }),
      (harness) => releaseResource(() => harness.close(context)),
    );
    storageOwned = false;
    yield* Effect.tryPromise({
      try: async () => {
        const existing = await harness.snapshot(Store, 'identity', context);
        if (existing) S.savedStore(existing);
        await harness.commit(async (tx) => {
          if (!existing && (await tx.scanConversations({}, 1)).items.length)
            V.fail(
              'Incompatible',
              'This store contains data without Moonbase ownership metadata; no import is authorized.',
            );
          const store = await tx.doc(Store, 'identity', identity);
          S.savedStore(store);
          if (store.identity !== identity)
            V.fail(
              'Incompatible',
              'Store is already bound to another host, actor, working directory or model.',
            );
        }, context);
      },
      catch: safeError,
    });
    const workScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      ),
      work = yield* Scope.provide(workScope)(FiberSet.make<unknown, ApplicationError>()),
      waiters = yield* retainedWork('waiter'),
      observations = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      ),
      host = new Host(validated, harness, identity, work, aborts, waiters, observations);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        host.closed = true;
      }),
    );
    harness.resume();
    return host;
  });
}

function makeChatService(host: Host): ChatServiceShape {
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
  };
}
export const PiRuntimeLive = (
  config: PiRuntimeConfiguration,
): Layer.Layer<ChatService, ApplicationError> =>
  Layer.effect(
    ChatService,
    Effect.gen(function* () {
      const host = yield* open(config);
      return makeChatService(host);
    }),
  );

export const LocalPiRuntimeLive = (
  config: LocalPiRuntimeConfiguration,
): Layer.Layer<ChatService | LocalPiControl, ApplicationError> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const registry = config.registry ?? createRegistry();
      if (!config.registry) registry.install(CodingTools);
      const host = yield* open({ ...config, registry, mode: 'local' });
      return Context.make(ChatService, makeChatService(host)).pipe(
        Context.add(LocalPiControl, {
          setAdmissionsOpen: (open) => {
            host.admissionsOpen = open;
          },
          hasActiveWork: () =>
            Effect.tryPromise({ try: () => host.hasActiveWork(), catch: safeError }),
        }),
      );
    }),
  );
