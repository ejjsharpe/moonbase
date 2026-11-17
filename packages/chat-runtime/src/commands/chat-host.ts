import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { ConversationId, Cursor, Harness } from '@earendil-works/pi-durable';
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  RcMap,
  Ref,
  Semaphore,
  type PubSub,
  type Scope,
} from 'effect';
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
import type { ChatFileIndex } from '../files.ts';
import type { LocalPiRuntimeConfiguration, RetainedWork } from '../runtime-types.ts';
import { callHarness } from './harness-call.ts';
import { safeError } from './safe-error.ts';

/** How many watches one host serves at once. */
const maximumObservers = 64;

/** Whether new mutations are admitted, and how many admitted ones have not finished. */
type Admissions = { open: boolean; mutations: number };

/** What the host is made of; `Host.make` adds the gates. */
export type HostParts = {
  config: LocalPiRuntimeConfiguration;
  harness: Harness;
  identity: string;
  files: ChatFileIndex;
  /** Conversations Pi reported a status change for without a commit (a parked task). */
  statuses: PubSub.PubSub<ConversationId>;
  /** Root-owned command work; closing it is closing the host. */
  work: FiberSet.FiberSet<unknown, ChatError>;
  aborts: RetainedWork;
  waiters: RetainedWork;
};

/**
 * An open chat store and the gates each command runs through: the session check, owned work,
 * per-chat Send admission and cancellable reads. The commands beside it take it as their first
 * argument.
 */
export class Host {
  readonly config: LocalPiRuntimeConfiguration;
  readonly harness: Harness;
  readonly identity: string;
  readonly files: ChatFileIndex;
  readonly statuses: PubSub.PubSub<ConversationId>;
  readonly work: FiberSet.FiberSet<unknown, ChatError>;
  readonly aborts: RetainedWork;
  readonly waiters: RetainedWork;
  /** One Send at a time per conversation; held while any Send for it waits or runs. */
  readonly sends: RcMap.RcMap<string, Semaphore.Semaphore>;
  /** One permit per watch. */
  readonly observers: Semaphore.Semaphore;
  readonly admissions: Ref.Ref<Admissions>;
  private constructor(
    parts: HostParts,
    sends: RcMap.RcMap<string, Semaphore.Semaphore>,
    observers: Semaphore.Semaphore,
    admissions: Ref.Ref<Admissions>,
  ) {
    this.config = parts.config;
    this.harness = parts.harness;
    this.identity = parts.identity;
    this.files = parts.files;
    this.statuses = parts.statuses;
    this.work = parts.work;
    this.aborts = parts.aborts;
    this.waiters = parts.waiters;
    this.sends = sends;
    this.observers = observers;
    this.admissions = admissions;
  }
  static make(parts: HostParts): Effect.Effect<Host, never, Scope.Scope> {
    return Effect.gen(function* () {
      const sends = yield* RcMap.make({ lookup: (_conversationId: string) => Semaphore.make(1) });
      return new Host(
        parts,
        sends,
        yield* Semaphore.make(maximumObservers),
        yield* Ref.make<Admissions>({ open: true, mutations: 0 }),
      );
    });
  }
  checkSession(value: ChatSession): Effect.Effect<void, ChatError> {
    return Effect.suspend((): Effect.Effect<void, ChatError> => {
      if (!isSameChatHost(value.host, this.config.host))
        return Effect.fail(new ChatStoreMismatchError({ mismatch: 'other-host' }));
      if (value.actorId !== this.config.actorId)
        return Effect.fail(new ChatAccessError({ refusal: 'other-actor' }));
      return Effect.void;
    });
  }
  /** An owned chat's metadata; `uncertain` inside a mutation, where an unknown failure may follow a commit. */
  metadata(target: ChatTarget, uncertain = false) {
    return Effect.andThen(
      this.checkSession(target),
      callHarness(() => readOwnedMetadata(this.harness, this.identity, target), uncertain),
    );
  }
  /** A chat as listings show it; fails when its saved settings are missing. */
  summary(
    conversationId: string,
    meta: { title: string; createdAt: string; settings?: ChatSettings; settledAt?: string },
  ): Effect.Effect<ChatSummary, ChatError> {
    return Effect.try({
      try: () =>
        summarizeConversation(
          { host: this.config.host, actorId: this.config.actorId },
          conversationId,
          meta,
          getSettings(meta),
        ),
      catch: safeError,
    });
  }
  /**
   * Runs `effect` as the host's own work: a caller that stops waiting leaves it running, and
   * closing the host waits for it. Work the closing host interrupted, or refused because it had
   * closed, fails as the store's.
   */
  own<A>(effect: Effect.Effect<A, ChatError>): Effect.Effect<A, ChatError> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        const fiber = yield* FiberSet.run(this.work, effect);
        const exit = yield* restore(Fiber.await(fiber)).pipe(
          Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe())),
        );
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
          return yield* Effect.fail(safeError(null));
        return yield* exit;
      }),
    );
  }
  /**
   * Admits one mutation, refused as `quitting` once admissions close, and counts it until it ends.
   * The check and the count are one step, so Quit never misses a mutation it let in. Runs inside
   * `own`, so the count lasts as long as the work does.
   */
  admitMutation<A>(effect: Effect.Effect<A, ChatError>): Effect.Effect<A, ChatError> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(
        Ref.modify(this.admissions, (admissions): [boolean, Admissions] =>
          admissions.open
            ? [true, { ...admissions, mutations: admissions.mutations + 1 }]
            : [false, admissions],
        ),
        (admitted) =>
          admitted
            ? restore(effect).pipe(
                Effect.ensuring(
                  Ref.update(this.admissions, (admissions) => ({
                    ...admissions,
                    mutations: admissions.mutations - 1,
                  })),
                ),
              )
            : Effect.fail(new ChatUnavailableError({ reason: 'quitting' })),
      ),
    );
  }
  setAdmissionsOpen(open: boolean): Effect.Effect<void> {
    return Ref.update(this.admissions, (admissions) => ({ ...admissions, open }));
  }
  /** Runs one Send for a conversation at a time; its body can't be interrupted once it starts. */
  private admitSend<A>(conversationId: string, effect: Effect.Effect<A, ChatError>) {
    return Effect.scoped(
      Effect.flatMap(RcMap.get(this.sends, conversationId), (semaphore) =>
        semaphore.withPermit(Effect.uninterruptible(effect)),
      ),
    );
  }
  run<K extends ChatCommand>(
    operation: K,
    data: ChatInput<K>,
    handle: (data: ChatInput<K>) => Effect.Effect<ChatOutput<K>, ChatError>,
  ): Effect.Effect<ChatOutput<K>, ChatError> {
    const invoke = Effect.suspend(() => handle(data));
    if (!isChatMutation(operation))
      return this.own(isCancellableChatRead(operation) ? invoke : Effect.uninterruptible(invoke));
    // Counted inside the owned work, so Quit still sees a mutation whose caller stopped waiting.
    if (operation !== 'sendChat')
      return this.own(this.admitMutation(Effect.uninterruptible(invoke)));
    const { target } = data as ChatInput<'sendChat'>;
    // The metadata check runs to completion, then the Send waits its turn for the conversation.
    return this.own(
      this.admitMutation(
        Effect.andThen(
          Effect.uninterruptible(this.metadata(target)),
          this.admitSend(target.conversationId, invoke),
        ),
      ),
    );
  }
  /** Reads Pi with the signal that aborts it when the caller stops waiting. */
  read<A>(handle: (signal: AbortSignal) => Promise<A>): Effect.Effect<A, ChatError> {
    return callHarness(handle);
  }
  hasActiveWork(): Effect.Effect<boolean, ChatError> {
    return Effect.gen({ self: this }, function* () {
      const busy = Effect.map(
        Effect.all([Ref.get(this.admissions), RcMap.keys(this.sends)]),
        ([admissions, sends]) => admissions.mutations > 0 || [...sends].length > 0,
      );
      if (yield* busy) return true;
      let scan: Cursor | undefined;
      do {
        const page = yield* callHarness(() =>
          this.harness.commit((tx) => tx.scanTasks({}, 32, scan), context),
        );
        if (page.items.some((task) => task.state.status !== 'terminal')) return true;
        scan = page.next;
      } while (scan);
      scan = undefined;
      do {
        const page = yield* callHarness(() =>
          this.harness.commit((tx) => tx.scanConversations({}, 32, scan), context),
        );
        for (const conversation of page.items) {
          const meta = yield* this.metadata({
            ...this.config,
            conversationId: String(conversation.id),
          });
          if (meta.pending) return true;
        }
        scan = page.next;
      } while (scan);
      return yield* busy;
    });
  }
}
