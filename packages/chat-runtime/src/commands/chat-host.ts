import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { ConversationId, Cursor, Harness } from '@earendil-works/pi-durable';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Option,
  RcMap,
  Ref,
  Semaphore,
  type FileSystem,
  type PubSub,
} from 'effect';
import {
  ChatAccessError,
  ChatStoreMismatchError,
  ChatUnavailableError,
  type ChatError,
} from '@moonbase/contracts/chat-errors';
import { UncertainError } from '@moonbase/contracts/errors';
import type {
  ChatCommand,
  ChatInput,
  ChatOutput,
  ChatSession,
  ChatSummary,
  ChatTarget,
} from '@moonbase/contracts/chat';
import { isCancellableChatRead, isSameChatHost } from '@moonbase/contracts/chat-validation';
import { isChatMutation } from '@moonbase/contracts/chat-rpc';
import { summarizeConversation } from '../chat-list/list-chats.ts';
import { getSettings, readOwnedMetadata, type ChatSettings } from '../documents.ts';
import type { FindSubtreeCache } from '../transcript/find-transcript.ts';
import type { EntryTranscriptCache } from '../transcript/entry-transcript.ts';
import type { ChatFileIndex } from '../files.ts';
import type { LocalPiRuntimeConfiguration, RetainedWork } from '../runtime-types.ts';
import { callHarness } from './harness-call.ts';
import { runCheck, safeError } from './safe-error.ts';

/** How many watches one host serves at once. */
const maximumObservers = 64;

/** Whether new mutations are admitted, and how many admitted ones have not finished. */
type Admissions = { open: boolean; mutations: number };

/** What the host is made of; `makeHost` adds the gates. */
export type HostParts = {
  config: LocalPiRuntimeConfiguration;
  harness: Harness;
  identity: string;
  files: ChatFileIndex;
  /** The platform's file system, for the folder checks reads and creates make. */
  fileSystem: FileSystem.FileSystem;
  /** Conversations Pi reported a status change for without a commit (a parked task). */
  statuses: PubSub.PubSub<ConversationId>;
  /** Root-owned command work; closing it is closing the host. */
  work: FiberSet.FiberSet<unknown, ChatError>;
  aborts: RetainedWork;
  waiters: RetainedWork;
  /** Built transcripts of saved entries, which never change. */
  entryTranscripts: EntryTranscriptCache;
  /** Serialized JSON subtrees Find resumes inside, for saved entries. */
  findSubtrees: FindSubtreeCache;
};

/**
 * An open chat store and the gates each command runs through: the session check, owned work,
 * per-chat Send admission and cancellable reads. The commands beside it take it as their first
 * argument.
 */
export type Host = Effect.Success<ReturnType<typeof makeHost>>;

export const makeHost = (parts: HostParts) =>
  Effect.gen(function* () {
    const { config, harness, identity, work } = parts;
    /** One Send at a time per conversation; held while any Send for it waits or runs. */
    const sends = yield* RcMap.make({
      lookup: (_conversationId: string) => Semaphore.make(1),
    });
    /** One permit per watch. */
    const observers = yield* Semaphore.make(maximumObservers);
    const admissions = yield* Ref.make<Admissions>({ open: true, mutations: 0 });

    const checkSession = (value: ChatSession): Effect.Effect<void, ChatError> => {
      if (!isSameChatHost(value.host, config.host))
        return Effect.fail(new ChatStoreMismatchError({ mismatch: 'other-host' }));
      if (value.actorId !== config.actorId)
        return Effect.fail(new ChatAccessError({ refusal: 'other-actor' }));
      return Effect.void;
    };
    /** An owned chat's metadata. */
    const metadata = (target: ChatTarget) =>
      Effect.andThen(
        Effect.suspend(() => checkSession(target)),
        readOwnedMetadata(harness, identity, target),
      );
    /** A chat as listings show it; fails when its saved settings are missing. */
    const summary = (
      conversationId: string,
      meta: { title: string; createdAt: string; settings?: ChatSettings; settledAt?: string },
    ): Effect.Effect<ChatSummary, ChatError> =>
      runCheck(() =>
        summarizeConversation(
          { host: config.host, actorId: config.actorId },
          conversationId,
          meta,
          getSettings(meta),
        ),
      );
    /**
     * Runs `effect` as the host's own work: a caller that stops waiting leaves it running, and
     * closing the host waits for it. Work the closing host interrupted, or refused because it had
     * closed, fails as the store's, unless its `body` had already ended: closing interrupts at the
     * first boundary after an uninterruptible body, which would discard what it committed, so the
     * body's own result is returned instead.
     */
    const own = <A>(
      effect: Effect.Effect<A, ChatError>,
      body?: Deferred.Deferred<A, ChatError>,
    ): Effect.Effect<A, ChatError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const fiber = yield* FiberSet.run(work, effect);
          const exit = yield* restore(Fiber.await(fiber)).pipe(
            Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe())),
          );
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
            const ended = body ? yield* Deferred.poll(body) : Option.none();
            return yield* Option.isSome(ended) ? ended.value : Effect.fail(safeError(null));
          }
          return yield* exit;
        }),
      );
    /**
     * Admits one mutation, refused as `quitting` once admissions close, and counts it until it
     * ends. The check and the count are one step, so Quit never misses a mutation it let in. Runs
     * inside `own`, so the count lasts as long as the work does.
     */
    const admitMutation = <A>(effect: Effect.Effect<A, ChatError>): Effect.Effect<A, ChatError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(
          Ref.modify(admissions, (current): [boolean, Admissions] =>
            current.open
              ? [true, { ...current, mutations: current.mutations + 1 }]
              : [false, current],
          ),
          (admitted) =>
            admitted
              ? restore(effect).pipe(
                  Effect.ensuring(
                    Ref.update(admissions, (current) => ({
                      ...current,
                      mutations: current.mutations - 1,
                    })),
                  ),
                )
              : Effect.fail(new ChatUnavailableError({ reason: 'quitting' })),
        ),
      );
    /**
     * Runs a mutation's committing `body` as owned, admitted work; see `own` for its result.
     * `prepare` runs what must come first inside the admission, such as a Send's turn.
     */
    const ownMutation = <A>(
      body: Effect.Effect<A, ChatError>,
      prepare: (body: Effect.Effect<A, ChatError>) => Effect.Effect<A, ChatError> = (body) => body,
    ): Effect.Effect<A, ChatError> =>
      Effect.flatMap(Deferred.make<A, ChatError>(), (ended) =>
        own(
          admitMutation(
            prepare(
              Effect.uninterruptible(
                body.pipe(Effect.onExit((exit) => Deferred.done(ended, exit))),
              ),
            ),
          ),
          ended,
        ),
      );
    const setAdmissionsOpen = (open: boolean): Effect.Effect<void> =>
      Ref.update(admissions, (current) => ({ ...current, open }));
    /** Runs one Send for a conversation at a time; its body can't be interrupted once it starts. */
    const admitSend = <A>(conversationId: string, effect: Effect.Effect<A, ChatError>) =>
      Effect.scoped(
        Effect.flatMap(RcMap.get(sends, conversationId), (semaphore) =>
          semaphore.withPermit(Effect.uninterruptible(effect)),
        ),
      );
    const run = <K extends ChatCommand>(
      operation: K,
      data: ChatInput<K>,
      handle: (data: ChatInput<K>) => Effect.Effect<ChatOutput<K>, ChatError>,
    ): Effect.Effect<ChatOutput<K>, ChatError> => {
      const mutation = isChatMutation(operation);
      // A defect stays hidden as the store's, or for a mutation, which it may have followed, uncertain
      // even when it is a chat error.
      const invoke = Effect.suspend(() => handle(data)).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(
            mutation ? new UncertainError({ operation: 'The chat request' }) : safeError(defect),
          ),
        ),
      );
      if (!mutation)
        return own(isCancellableChatRead(operation) ? invoke : Effect.uninterruptible(invoke));
      // Counted inside the owned work, so Quit still sees a mutation whose caller stopped waiting.
      if (operation !== 'sendChat') return ownMutation(invoke);
      const { target } = data as ChatInput<'sendChat'>;
      // The metadata check runs to completion, then the Send waits its turn for the conversation;
      // a Send still waiting when the store closes never started, so it fails as the store's.
      return ownMutation(invoke, (body) =>
        Effect.andThen(
          Effect.uninterruptible(metadata(target)),
          admitSend(target.conversationId, body),
        ),
      );
    };
    const hasActiveWork = (): Effect.Effect<boolean, ChatError> =>
      Effect.gen(function* () {
        const busy = Effect.map(
          Effect.all([Ref.get(admissions), RcMap.keys(sends)]),
          ([current, running]) => current.mutations > 0 || [...running].length > 0,
        );
        if (yield* busy) return true;
        let scan: Cursor | undefined;
        do {
          const page = yield* callHarness(() =>
            harness.commit((tx) => tx.scanTasks({}, 32, scan), context),
          );
          if (page.items.some((task) => task.state.status !== 'terminal')) return true;
          scan = page.next;
        } while (scan);
        scan = undefined;
        do {
          const page = yield* callHarness(() =>
            harness.commit((tx) => tx.scanConversations({}, 32, scan), context),
          );
          for (const conversation of page.items) {
            const meta = yield* metadata({ ...config, conversationId: String(conversation.id) });
            if (meta.pending) return true;
          }
          scan = page.next;
        } while (scan);
        return yield* busy;
      });
    return {
      ...parts,
      sends,
      observers,
      checkSession,
      metadata,
      summary,
      own,
      ownMutation,
      setAdmissionsOpen,
      run,
      hasActiveWork,
    };
  });
