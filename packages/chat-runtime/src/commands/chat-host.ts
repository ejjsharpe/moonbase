import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { ConversationId, Cursor, Harness } from '@earendil-works/pi-durable';
import { Effect, Exit, Fiber, FiberSet, Semaphore, type Scope } from 'effect';
import {
  ChatAccessError,
  ChatStoreMismatchError,
  ChatUnavailableError,
  type ChatError,
} from '@moonbase/contracts/chat-errors';
import type {
  ChatCommand,
  ChatInput,
  ChatOutput,
  ChatSession,
  ChatSummary,
  ChatTarget,
} from '@moonbase/contracts/chat';
import {
  isCancellableChatRead,
  isChatMutation,
  isSameChatHost,
} from '@moonbase/contracts/chat-validation';
import { summarizeConversation } from '../chat-list/list-chats.ts';
import { getSettings, readOwnedMetadata, type ChatSettings } from '../documents.ts';
import { ChatFileIndex } from '../files.ts';
import type { LocalPiRuntimeConfiguration, RetainedWork } from '../runtime-types.ts';
import { listedChanges } from './publications.ts';
import { safeError } from './safe-error.ts';

/**
 * An open chat store and the gates each command runs through: the session check, owned work,
 * per-chat Send admission and cancellable reads. The commands beside it take it as their first
 * argument.
 */
export class Host {
  readonly admissions = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  closed = false;
  observers = 0;
  admissionsOpen = true;
  mutations = 0;
  readonly config: LocalPiRuntimeConfiguration;
  readonly harness: Harness;
  readonly identity: string;
  readonly work: FiberSet.FiberSet<unknown, ChatError>;
  readonly aborts: RetainedWork;
  readonly waiters: RetainedWork;
  readonly observations: Scope.Closeable;
  readonly statusListeners = new Set<(conversationId: ConversationId) => void>();
  readonly files: ChatFileIndex;
  constructor(
    config: LocalPiRuntimeConfiguration,
    harness: Harness,
    identity: string,
    work: FiberSet.FiberSet<unknown, ChatError>,
    aborts: RetainedWork,
    waiters: RetainedWork,
    observations: Scope.Closeable,
  ) {
    this.config = config;
    this.files = new ChatFileIndex({
      ripgrepExecutable: config.ripgrepExecutable,
      timing: config.fileListingTiming,
    });
    this.harness = harness;
    this.identity = identity;
    this.work = work;
    this.aborts = aborts;
    this.waiters = waiters;
    this.observations = observations;
  }
  /**
   * Calls `listener` with the chats a commit or status report may have changed the listing of.
   */
  subscribeChatList(listener: (conversationIds: readonly string[]) => void): () => void {
    const off = this.harness.subscribeCommits((publication) => {
      const changed = listedChanges(publication);
      if (changed.length) listener(changed);
    });
    const notify = (conversationId: ConversationId) => listener([String(conversationId)]);
    this.statusListeners.add(notify);
    return () => {
      off();
      this.statusListeners.delete(notify);
    };
  }
  session(value: ChatSession) {
    if (!isSameChatHost(value.host, this.config.host))
      throw new ChatStoreMismatchError({ mismatch: 'other-host' });
    if (value.actorId !== this.config.actorId)
      throw new ChatAccessError({ refusal: 'other-actor' });
  }
  async metadata(target: ChatTarget) {
    this.session(target);
    return readOwnedMetadata(this.harness, this.identity, target);
  }
  summary(
    conversationId: string,
    meta: { title: string; createdAt: string; settings?: ChatSettings; settledAt?: string },
  ): ChatSummary {
    return summarizeConversation(
      { host: this.config.host, actorId: this.config.actorId },
      conversationId,
      meta,
      getSettings(meta),
    );
  }
  own<A>(effect: Effect.Effect<A, ChatError>) {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const fiber = yield* FiberSet.run(this.work, effect);
        return yield* restore(Fiber.join(fiber)).pipe(
          Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe())),
        );
      }),
    );
  }
  admission<A>(conversationId: string, effect: Effect.Effect<A, ChatError>) {
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
    data: ChatInput<K>,
    handle: (
      data: ChatInput<K>,
    ) => Promise<ChatOutput<K>> | Effect.Effect<ChatOutput<K>, ChatError>,
  ): Effect.Effect<ChatOutput<K>, ChatError> {
    const mutation = isChatMutation(operation);
    return Effect.gen({ self: this }, function* () {
      if (this.closed) return yield* Effect.fail(safeError(null));
      if (mutation && !this.admissionsOpen)
        return yield* Effect.fail(new ChatUnavailableError({ reason: 'quitting' }));
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
      });
      if (mutation) this.mutations++;
      let admission = invoke;
      if (operation === 'sendChat')
        admission = this.admission((data as ChatInput<'sendChat'>).target.conversationId, invoke);
      else if (!isCancellableChatRead(operation)) admission = Effect.uninterruptible(invoke);
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
  read<A>(handle: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, ChatError> {
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
}
