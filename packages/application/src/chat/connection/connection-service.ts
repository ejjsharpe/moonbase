import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  Layer,
  Option,
  Ref,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import { ChatConfig } from '../chat-config.ts';
import { ChatRefusedError } from '../chat-errors.ts';
import { ChatActions } from '../actions/actions-service.ts';
import { verifiedNotice } from '../actions/actions.ts';
import { ChatDrafts } from '../drafts/drafts-service.ts';
import { isSameSession } from '../drafts/drafts.ts';
import { ChatLink } from '../link/link-service.ts';
import { ChatList } from '../chat-list/chat-list-service.ts';
import { ChatSelection } from '../selection/selection-service.ts';
import { ChatSends } from '../sends/sends-service.ts';
import { ChatProviderSetup } from '../provider-setup/provider-setup-service.ts';
import { isConnectionChanged } from './connection.ts';

export type ChatConnectionShape = {
  /**
   * Starts the chat once: a host on this machine is used at once; one reached through a
   * connection follows its connection's state and waits for an explicit Connect.
   */
  readonly start: Effect.Effect<void>;
  readonly connect: Effect.Effect<void>;
  /** Ends the connection: everything that ran over it stops before it disconnects. */
  readonly disconnect: Effect.Effect<void>;
  /**
   * Verifies the host, then lists its chats, opens the selected one and queries retained Sends. A
   * newer refresh replaces a running one.
   */
  readonly refresh: Effect.Effect<void>;
};

/** How the chat reaches its host: the connection, and refresh over each connected link. */
export class ChatConnection extends Context.Service<ChatConnection, ChatConnectionShape>()(
  'moonbase/chat/ChatConnection',
) {
  static readonly layer = Layer.effect(
    ChatConnection,
    Effect.gen(function* () {
      const config = yield* ChatConfig;
      const actions = yield* ChatActions;
      const drafts = yield* ChatDrafts;
      const link = yield* ChatLink;
      const list = yield* ChatList;
      const selection = yield* ChatSelection;
      const sends = yield* ChatSends;
      const providers = yield* ChatProviderSetup;
      const port = config.connection;
      const scope = yield* Effect.scope;
      const started = yield* Ref.make(false);
      const refreshing = yield* FiberHandle.make<void, unknown>();
      const watching = yield* FiberHandle.make<void, never>();
      /** Completes with the next state the connection's watch delivers. */
      const nextEvent = yield* Ref.make(yield* Deferred.make<void>());

      const verify = Effect.gen(function* () {
        const host = yield* config.chat.getChatHost({ host: config.session.host });
        if (!isSameSession(host, config.session))
          return yield* new ChatRefusedError({ reason: 'host-mismatch' });
        // Opening a chat needs only the verified host, so a failed chat list cannot block it.
        yield* link.update((s) => ({ ...s, host, ready: true }));
        yield* actions.setNotice(verifiedNotice(!!port));
        // A connected host's providers are read once it is verified; a local one's at start.
        if (port) yield* actions.fork(providers.refresh);
        const listed = yield* Effect.exit(list.listFirst);
        const { transcript } = yield* SubscriptionRef.get(selection.state);
        if ((yield* SubscriptionRef.get(transcript)).observation === 'failed')
          yield* selection.close;
        const { selected } = (yield* drafts.get).saved;
        if (selected && !(yield* selection.isOpen)) yield* selection.open(selected);
        yield* sends.queryAll;
        yield* listed;
      });
      const refresh = actions.run(
        'refresh',
        Effect.gen(function* () {
          yield* link.current;
          const fiber = yield* FiberHandle.run(refreshing, link.run(verify));
          // A newer refresh, or the link's end, interrupts this one: no failure to show.
          const exit = yield* Fiber.await(fiber);
          if (Exit.isFailure(exit) && !Exit.hasInterrupts(exit)) yield* exit;
        }),
        { duplicate: false },
      );
      yield* Deferred.succeed(link.verifier, {
        refresh,
        refreshing: Effect.map(FiberHandle.get(refreshing), Option.isSome),
      });

      /** Takes a connection state: a new connection (or none) ends everything over the last. */
      const onConnection = (next: ConnectionSnapshot) =>
        Effect.gen(function* () {
          const { connection: previous } = yield* link.get;
          const changed = isConnectionChanged(previous, next, yield* link.isOpen);
          // A repeated event is ready only once refresh has verified this connection's host.
          yield* link.update((s) => ({
            ...s,
            connection: next,
            ready: next.state === 'connected' && !!s.host,
          }));
          if (!changed) return;
          yield* link.close;
          if (next.state !== 'connected') return;
          yield* link.open;
          yield* actions.fork(refresh);
        });
      /**
       * A connection read. Its reply is dropped if the watch delivers a state first, but its
       * failure never is: a refused Connect always shows why.
       */
      const readLatest = <E>(read: Effect.Effect<ConnectionSnapshot, E>) =>
        Effect.gen(function* () {
          const event = yield* Ref.get(nextEvent);
          // The read runs to its end (or the chat's) even when its reply is dropped: it may be a
          // mutation.
          const fiber = yield* Effect.forkIn(read, scope, { startImmediately: true });
          const overtaken = yield* Effect.raceFirst(
            Effect.as(Fiber.await(fiber), false),
            Effect.as(Deferred.await(event), true),
          );
          const reply = yield* Fiber.join(fiber);
          if (!overtaken) yield* onConnection(reply);
        });

      const watchConnection = port
        ? port.watch().pipe(
            Stream.runForEach((next) =>
              Effect.gen(function* () {
                const event = yield* Ref.getAndSet(nextEvent, yield* Deferred.make<void>());
                yield* Deferred.succeed(event, undefined);
                yield* onConnection(next);
              }),
            ),
            Effect.catch(actions.report),
          )
        : Effect.void;

      return {
        start: Effect.gen(function* () {
          if (!(yield* actions.accepting) || (yield* Ref.getAndSet(started, true))) return;
          if (!port) {
            yield* link.open;
            yield* Effect.all([refresh, providers.refresh], { concurrency: 'unbounded' });
            return;
          }
          yield* FiberHandle.run(watching, watchConnection);
          yield* actions.run('status', readLatest(port.getConnection({})), { duplicate: false });
          const current = yield* link.get;
          if (current.connection?.state === 'connected' && !current.host) yield* refresh;
        }),
        connect: actions.run(
          'connect',
          Effect.gen(function* () {
            const { connection } = yield* link.get;
            if (!port || !connection) return;
            yield* readLatest(port.connect({ profileId: connection.profile.id }));
          }),
        ),
        disconnect: actions.run(
          'disconnect',
          Effect.gen(function* () {
            const id = (yield* link.get).connection?.connectionId;
            if (!port || !id || !(yield* link.isOpen)) return;
            // Closing the link waits for its watches to close before the connection ends.
            yield* link.close;
            // A newer connection replaced this one meanwhile: its Disconnect is dropped unsent,
            // and one the host refuses as stale once it did is dropped silently.
            const replaced = Effect.map(link.get, (s) => s.connection?.connectionId !== id);
            if ((yield* replaced) || (yield* link.isOpen)) return;
            const sent = yield* Effect.exit(port.disconnect({ connectionId: id }));
            if (Exit.isFailure(sent)) {
              if ((yield* replaced) || (yield* link.isOpen)) return;
              return yield* sent;
            }
            yield* readLatest(port.getConnection({}));
          }),
        ),
        refresh,
      } satisfies ChatConnectionShape;
    }),
  );
}
