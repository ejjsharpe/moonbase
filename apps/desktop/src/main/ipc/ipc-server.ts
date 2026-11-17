import { Context, Deferred, Effect, Exit, Layer, Scope, SynchronizedRef } from 'effect';
import { RpcSerialization, RpcServer, type Rpc, type RpcGroup } from 'effect/rpc';
import * as NetAddress from 'effect/net/NetAddress';
import type * as Socket from 'effect/socket/Socket';
import * as SocketServer from 'effect/socket/SocketServer';
import { DesktopRpcs } from '../../ipc/desktop-rpcs.ts';
import type { IpcAdmission } from '../../ipc/ipc-admission.ts';
import { ipcLimits } from '../../ipc/ipc-limits.ts';
import { makePortSocket, type MessagePortLike } from '../../ipc/port-socket.ts';

/** What serves one document: its procedures' handlers and admission, built in its scope. */
export type DocumentHandlers = (
  document: Scope.Scope,
) => Layer.Layer<Rpc.ToHandler<RpcGroup.Rpcs<typeof DesktopRpcs>> | IpcAdmission>;
type Document = {
  scope: Scope.Closeable;
  connections: number;
  /** The RPC server's handler for each connection, once it has started. */
  serve: Deferred.Deferred<(socket: Socket.Socket) => Effect.Effect<unknown, unknown>>;
};
/** The window's document, if it has connected; none once the server is closed. */
type ServerState = { _tag: 'Open'; document?: Document } | { _tag: 'Closed' };

/**
 * The window's IPC: each port main hands its document is one RPC connection to the document's
 * server, which holds what the document's requests acquire. Releasing the document closes its
 * connections and interrupts its requests, then a new document starts with none. Closing the
 * scope releases the document and refuses every later connection.
 */
export const makeIpcServer = (handlers: DocumentHandlers) =>
  Effect.gen(function* () {
    // Documents close after the server stops taking connections, which the finalizer below does.
    const documents = yield* Scope.fork(yield* Effect.scope, 'parallel');
    const state = yield* SynchronizedRef.make<ServerState>({ _tag: 'Open' });
    yield* Effect.addFinalizer(() => SynchronizedRef.set(state, { _tag: 'Closed' }));

    const startDocument = Effect.gen(function* () {
      const scope = yield* Scope.fork(documents, 'parallel');
      const serve =
        yield* Deferred.make<(socket: Socket.Socket) => Effect.Effect<unknown, unknown>>();
      const socketServer = SocketServer.SocketServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe('127.0.0.1', 0),
        run: (handler) => Effect.andThen(Deferred.succeed(serve, handler as never), Effect.never),
      });
      const server = RpcServer.layer(DesktopRpcs, {
        disableFatalDefects: true,
        disableTracing: true,
      }).pipe(
        Layer.provide([
          handlers(scope),
          RpcServer.layerProtocolSocketServer.pipe(
            Layer.provide([
              Layer.succeed(SocketServer.SocketServer, socketServer),
              RpcSerialization.layerJson,
            ]),
          ),
        ]),
      );
      yield* Layer.buildWithScope(server, scope).pipe(
        Effect.catchCause((cause) =>
          Effect.andThen(
            Effect.logError('The IPC server could not start.', cause),
            Scope.close(scope, Exit.void),
          ),
        ),
        Effect.forkIn(scope),
      );
      return { scope, serve, connections: 0 } satisfies Document;
    });

    /** Gives back `document`'s place, if it is still the window's. */
    const leave = (document: Document) =>
      SynchronizedRef.update(state, (current): ServerState =>
        current._tag === 'Open' && current.document?.scope === document.scope
          ? {
              _tag: 'Open',
              document: { ...current.document, connections: current.document.connections - 1 },
            }
          : current,
      );
    /** One connection of `document`, served until either side closes it or the document ends. */
    const serve = (document: Document, port: MessagePortLike) =>
      Effect.gen(function* () {
        const handler = yield* Deferred.await(document.serve);
        const socket = yield* makePortSocket(Effect.succeed(port));
        yield* Effect.scoped(handler(socket));
      }).pipe(
        Effect.ignore,
        Effect.interruptible,
        Effect.ensuring(
          Effect.andThen(
            Effect.sync(() => port.close()),
            leave(document),
          ),
        ),
        // Started uninterruptible, so a document closed at once still closes the port.
        Effect.forkIn(document.scope, { uninterruptible: true }),
      );

    return {
      /**
       * Serves `port` for the current document, starting one if needed; refuses it (false) past
       * `ipcLimits.connections` or once closed. The check and its reservation are one step.
       */
      connect: (port: MessagePortLike) =>
        SynchronizedRef.modifyEffect(state, (current) =>
          Effect.gen(function* () {
            if (current._tag === 'Closed') return [false, current] as const;
            const document = current.document ?? (yield* startDocument);
            if (document.connections >= ipcLimits.connections)
              return [false, { _tag: 'Open', document }] as const;
            yield* serve(document, port);
            return [
              true,
              { _tag: 'Open', document: { ...document, connections: document.connections + 1 } },
            ] as const;
          }),
        ),
      /** Ends the current document's connections and what its requests hold. */
      releaseDocument: Effect.flatMap(
        SynchronizedRef.modify(state, (current): readonly [Document | undefined, ServerState] =>
          current._tag === 'Open' ? [current.document, { _tag: 'Open' }] : [undefined, current],
        ),
        (document) => (document ? Scope.close(document.scope, Exit.void) : Effect.void),
      ),
    };
  });
/** The window's IPC server. */
export class IpcServer extends Context.Service<
  IpcServer,
  Effect.Success<ReturnType<typeof makeIpcServer>>
>()('moonbase/desktop/IpcServer') {}
