import { realpath, stat } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context, withCancel } from '@earendil-works/chord/context';
import {
  LiveDoc,
  NestedCallDoc,
  configure,
  ConversationBusy,
  type Harness,
  type TaskId,
  type Cursor,
  type CommitPublication,
  type ConversationId,
} from '@earendil-works/pi-durable';
import { Effect, Exit, Fiber, FiberSet, Option, Queue, Scope, Semaphore, Stream } from 'effect';
import { normalizeApplicationError, releaseResource } from '@moonbase/effect';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
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
} from '@moonbase/contracts/chat';
import {
  Request,
  Store,
  Metadata,
  key,
  cid,
  sid,
  tid,
  readOwnedMetadata,
  getSettings,
} from './documents.ts';
import {
  listConversations,
  readHistory,
  readHistoryAround,
  projectSnapshot,
  summarizeConversation,
  type SnapshotCache,
} from './history.ts';
import type { RuntimeConfiguration, RetainedWork } from './runtime-types.ts';
import { findTranscript } from './find.ts';
import { NestedSourceRetired, readTranscriptContent } from './transcript.ts';
import * as V from './validation.ts';
import * as S from './private-schema.ts';

const unknownOutcome = () =>
  new ApplicationError({
    code: 'Uncertain',
    message:
      'Chat operation may have committed. Preserve its exact request and query before retrying.',
  });
export const safeError = (error: unknown, uncertain = false): ApplicationError => {
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
export class Host {
  readonly admissions = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  closed = false;
  observers = 0;
  admissionsOpen = true;
  mutations = 0;
  readonly config: RuntimeConfiguration;
  readonly harness: Harness;
  readonly identity: string;
  readonly work: FiberSet.FiberSet<unknown, ApplicationError>;
  readonly aborts: RetainedWork;
  readonly waiters: RetainedWork;
  readonly observations: Scope.Closeable;
  readonly statusListeners = new Set<(conversationId: ConversationId) => void>();
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
  get fixedSettings(): ChatCreationSettings | undefined {
    return 'mode' in this.config ? undefined : { cwd: this.config.cwd, model: this.config.model };
  }
  async metadata(target: ChatTarget) {
    this.session(target);
    return readOwnedMetadata(this.harness, this.identity, target, 'mode' in this.config);
  }
  summary(
    conversationId: string,
    meta: { title: string; createdAt: string; settings?: ChatCreationSettings },
  ): ChatSummary {
    return summarizeConversation(
      { host: this.config.host, actorId: this.config.actorId },
      conversationId,
      meta,
      getSettings(meta, this.fixedSettings),
    );
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
      let admission = invoke;
      if (operation === 'sendChat')
        admission = this.admission((data as ChatInput<'sendChat'>).target.conversationId, invoke);
      else if (
        operation !== 'getChatTranscriptContent' &&
        operation !== 'getChatHistoryAround' &&
        operation !== 'findChatTranscript'
      )
        admission = Effect.uninterruptible(invoke);
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
  read<A>(handle: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, ApplicationError> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const controller = new AbortController();
        const settled = handle(controller.signal).then(Exit.succeed, (error) =>
          Exit.fail(safeError(error)),
        );
        return { controller, settled };
      }),
      ({ settled }) => Effect.promise(() => settled).pipe(Effect.flatMap((exit) => exit)),
      ({ controller, settled }) =>
        Effect.sync(() => controller.abort()).pipe(
          // Caller cancellation ends its join; root work retains the actual SDK Promise until settlement.
          Effect.andThen(Effect.promise(() => settled)),
        ),
    );
  }
  getTranscriptContent(d: ChatInput<'getChatTranscriptContent'>) {
    return this.read(async (signal) => {
      await this.metadata(d.source.target);
      signal.throwIfAborted();
      return readTranscriptContent(this.harness, d, signal);
    });
  }
  findTranscript(d: ChatInput<'findChatTranscript'>) {
    return this.read(async (signal) => {
      await this.metadata(d.target);
      signal.throwIfAborted();
      return findTranscript(this.harness, d, signal);
    });
  }
  getHistoryAround(d: ChatInput<'getChatHistoryAround'>) {
    return this.read(async (signal) => {
      await this.metadata(d.target);
      signal.throwIfAborted();
      return readHistoryAround(this.harness, d, signal);
    });
  }
  async getHost(d: ChatInput<'getChatHost'>): Promise<ChatOutput<'getChatHost'>> {
    if (!V.sameHost(d.host, this.config.host))
      V.fail('Incompatible', 'Chat host/store does not match this host.');
    S.savedStore(await this.harness.snapshot(Store, 'identity', context));
    if ('mode' in this.config)
      return {
        host: { ...this.config.host },
        actorId: this.config.actorId,
        mode: 'local',
        features: ['transcript-v1', 'transcript-find-v1'],
      };
    return {
      host: { ...this.config.host },
      actorId: this.config.actorId,
      features: ['transcript-v1', 'transcript-find-v1'],
      cwd: this.config.cwd,
      model: `${this.config.model.provider}/${this.config.model.modelId}`,
    };
  }
  async list(d: ChatInput<'listChats'>): Promise<ChatOutput<'listChats'>> {
    this.session(d.session);
    return listConversations(this.harness, d.session, this.identity, this.fixedSettings, d.cursor);
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
      const model =
        this.config.models.getModel(d.settings!.model.provider, d.settings!.model.modelId) ??
        V.fail('InvalidInput', 'Choose an installed model from the local catalog.');
      if (
        d.settings!.reasoningEffort &&
        !getSupportedThinkingLevels(model).includes(d.settings!.reasoningEffort)
      )
        V.fail('InvalidInput', 'Choose a reasoning effort supported by this model.');
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
        await configure(tx, conversation.id, {
          cwd: settings.cwd,
          model: settings.model,
          ...(settings.reasoningEffort ? { thinkingLevel: settings.reasoningEffort } : {}),
        });
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
    return readHistory(this.harness, {
      identity: this.identity,
      target: d.target,
      cursor: d.cursor,
    });
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
  async snapshot(
    target: ChatTarget,
    cache?: SnapshotCache,
    signal?: AbortSignal,
  ): Promise<ChatSnapshot> {
    const meta = await this.metadata(target);
    signal?.throwIfAborted();
    const owner = S.savedStore(await this.harness.snapshot(Store, 'identity', context));
    if (owner.identity !== this.identity)
      V.fail('Unauthorized', 'Chat store authority changed. Preserve this store.');
    if (cache && cache.boundary === undefined) {
      if (!(await this.harness.snapshot(LiveDoc, cid(target.conversationId), context)))
        V.fail('Persistence', 'Pi live state is unavailable. Reopen this conversation.');
    }
    return projectSnapshot(this.harness, {
      identity: this.identity,
      target,
      conversation: this.summary(target.conversationId, meta),
      pending: meta.pending,
      local: 'mode' in this.config,
      cache,
      signal,
    });
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
        const cache: SnapshotCache = { statusVersion: 0 };
        let revision = 0,
          active = true,
          ended = false;
        const scope = yield* Effect.acquireRelease(Scope.fork(this.observations), (scope) =>
          Scope.close(scope, Exit.void),
        );
        yield* Scope.provide(scope)(
          Effect.gen({ self: this }, function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                active = false;
              }).pipe(Effect.andThen(Queue.shutdown(queue))),
            );
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
            const refresh = (invalidatesCapture = true) => {
              if (invalidatesCapture) revision++;
              Queue.offerUnsafe(queue, undefined);
            };
            const invalidateStatus = () => {
              cache.statusVersion++;
              cache.status = undefined;
            };
            const invalidate = (publication: CommitPublication) => {
              let relevant = false,
                invalidatesCapture = false;
              let liveRetired = false,
                livePresent = false;
              for (const change of publication.changes) {
                if (change.type === 'document' || change.type === 'document.copy') {
                  const kind = change.record.kind;
                  if (change.conversationId === cid(target.conversationId)) {
                    if (
                      kind !== LiveDoc.definition.kind &&
                      kind !== Metadata.definition.kind &&
                      kind !== NestedCallDoc.definition.kind
                    )
                      continue;
                    relevant = true;
                    // Progress can outpace projection without invalidating its captured source/control.
                    const progressOnly =
                      kind === LiveDoc.definition.kind &&
                      change.type === 'document' &&
                      change.value !== null &&
                      change.ops.length !== 0 &&
                      change.ops.every((op) => {
                        if (op[0] === 'r') return false;
                        const path = op[1];
                        return (
                          (path[0] === 'generation' && path[1] === 'message') ||
                          ((path[0] === 'tools' || path[0] === 'nestedTools') &&
                            typeof path[1] === 'number' &&
                            [
                              'output',
                              'details',
                              'diagnostics',
                              'droppedBytes',
                              'droppedLines',
                            ].includes(String(path[2])))
                        );
                      });
                    invalidatesCapture ||= !progressOnly;
                    if (kind === LiveDoc.definition.kind) {
                      if (change.type === 'document' && change.value === null) liveRetired = true;
                      else livePresent = true;
                    }
                    if (
                      change.type === 'document.copy' ||
                      (change.type === 'document' && (!change.ops.length || change.value === null))
                    ) {
                      cache.boundary = undefined;
                      cache.history = undefined;
                      invalidateStatus();
                    }
                  } else if (
                    kind === Store.definition.kind &&
                    change.record.scope.kind === 'session'
                  ) {
                    relevant = true;
                    invalidatesCapture = true;
                    cache.boundary = undefined;
                    cache.history = undefined;
                    invalidateStatus();
                  }
                } else {
                  const conversationId =
                    change.type === 'conversation' ? change.value.id : change.value.conversationId;
                  if (conversationId !== cid(target.conversationId)) continue;
                  relevant = true;
                  invalidatesCapture = true;
                  if (change.type === 'entry' || change.type === 'conversation') {
                    cache.boundary = undefined;
                    cache.history = undefined;
                  }
                  if (change.type === 'task' || change.type === 'conversation') invalidateStatus();
                }
              }
              if (liveRetired || livePresent) cache.retired = liveRetired && !livePresent;
              if (relevant) refresh(invalidatesCapture);
            };
            yield* Effect.acquireRelease(
              Effect.try({
                try: () => this.harness.subscribeCommits(invalidate),
                catch: normalizeApplicationError,
              }),
              (off) => releaseResource(off),
            );
            yield* Effect.acquireRelease(
              Effect.try({
                try: () =>
                  this.harness.subscribeClose(() => {
                    ended = true;
                    refresh();
                  }),
                catch: normalizeApplicationError,
              }),
              (off) => releaseResource(off),
            );
            yield* Effect.acquireRelease(
              Effect.try({
                try: () =>
                  this.config.registry!.subscribe(() => {
                    invalidateStatus();
                    refresh();
                  }),
                catch: normalizeApplicationError,
              }),
              (off) => releaseResource(off),
            );
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const notify = (conversationId: ConversationId) => {
                  if (conversationId === cid(target.conversationId)) {
                    invalidateStatus();
                    refresh();
                  }
                };
                this.statusListeners.add(notify);
                return () => {
                  this.statusListeners.delete(notify);
                };
              }),
              (off) => releaseResource(off),
            );
            refresh();
          }),
        );
        return Stream.fromQueue(queue).pipe(
          Stream.mapEffect(() => {
            const version = revision;
            if (ended || this.closed) return Effect.fail(safeError(null));
            return this.own(this.read((signal) => this.snapshot(target, cache, signal))).pipe(
              Effect.flatMap((snapshot) =>
                Effect.try({
                  try: () =>
                    active && version === revision
                      ? Option.some(V.output('getChat', snapshot, { target }))
                      : Option.none(),
                  catch: safeError,
                }),
              ),
              Effect.catch((error) =>
                error instanceof NestedSourceRetired && version !== revision
                  ? Effect.succeed(Option.none())
                  : Effect.fail(error),
              ),
            );
          }),
          Stream.filter(Option.isSome),
          Stream.map((snapshot) => snapshot.value),
        );
      }),
    );
  }
}
