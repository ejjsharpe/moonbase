import { Context, Effect, Exit, Fiber, FiberSet, Layer, Scope, SubscriptionRef } from 'effect';
import type { ChatHostConfiguration } from '@moonbase/contracts/chat';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import { ChatConfig } from '../chat-config.ts';
import { ChatRefusedError } from '../chat-errors.ts';

export type LinkState = {
  /** Whether the host is reached through a connection that is connected explicitly. */
  remote: boolean;
  connection: ConnectionSnapshot | null;
  /** The host refresh verified over the open link. */
  host: ChatHostConfiguration | null;
  ready: boolean;
};

/** One connected host's lifetime: closing it interrupts everything that ran over it. */
export type Link = {
  readonly scope: Scope.Scope;
  readonly fibers: FiberSet.FiberSet<unknown, unknown>;
};

export type ChatLinkShape = {
  readonly state: SubscriptionRef.SubscriptionRef<LinkState>;
  readonly get: Effect.Effect<LinkState>;
  readonly update: (f: (state: LinkState) => LinkState) => Effect.Effect<void>;
  /** The open link; fails `not-connected` without one. */
  readonly current: Effect.Effect<Link, ChatRefusedError>;
  /** Whether a link is open. */
  readonly isOpen: Effect.Effect<boolean>;
  /** Closes the open link, if any, and opens a new one. */
  readonly open: Effect.Effect<void>;
  /** Closes the open link, interrupting its work, and forgets the verified host. */
  readonly close: Effect.Effect<void>;
  /**
   * Runs `work` for as long as both the caller and the open link live: either ending interrupts
   * it. Fails `not-connected` without an open link.
   */
  readonly run: <A, E, R>(
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ChatRefusedError, R>;
};

/** The link to the chat host: the connected host's lifetime and what refresh verified over it. */
export class ChatLink extends Context.Service<ChatLink, ChatLinkShape>()('moonbase/chat/ChatLink') {
  static readonly layer = Layer.effect(
    ChatLink,
    Effect.gen(function* () {
      const config = yield* ChatConfig;
      const root = yield* Effect.scope;
      const state = yield* SubscriptionRef.make<LinkState>({
        remote: !!config.connection,
        connection: null,
        host: null,
        ready: false,
      });
      const link = yield* SubscriptionRef.make<{ link: Link; scope: Scope.Closeable } | undefined>(
        undefined,
      );
      const close = Effect.gen(function* () {
        const open = yield* SubscriptionRef.getAndSet(link, undefined);
        yield* SubscriptionRef.update(state, (s) => ({ ...s, host: null, ready: false }));
        if (open) yield* Scope.close(open.scope, Exit.void);
      }).pipe(Effect.uninterruptible);
      const current = Effect.flatMap(SubscriptionRef.get(link), (open) =>
        open
          ? Effect.succeed(open.link)
          : Effect.fail(new ChatRefusedError({ reason: 'not-connected' })),
      );
      return {
        state,
        get: SubscriptionRef.get(state),
        update: (f) => SubscriptionRef.update(state, f),
        current,
        isOpen: Effect.map(SubscriptionRef.get(link), (open) => !!open),
        open: Effect.gen(function* () {
          yield* close;
          const scope = yield* Scope.fork(root, 'sequential');
          const fibers = yield* FiberSet.make().pipe(Scope.provide(scope));
          yield* SubscriptionRef.set(link, { link: { scope, fibers }, scope });
        }).pipe(Effect.uninterruptible),
        close,
        run: (work) =>
          Effect.flatMap(current, ({ fibers }) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.flatMap(FiberSet.run(fibers, work, { startImmediately: true }), (fiber) =>
                restore(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))),
              ),
            ),
          ),
      } satisfies ChatLinkShape;
    }),
  );
}
