import { Deferred, Effect, Exit, FiberSet, Layer, Scope } from 'effect';
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

/**
 * The window's IPC: each port main hands its document is one RPC connection to the document's
 * server, which holds what the document's requests acquire. Releasing the document closes its
 * connections and interrupts its requests, then a new document starts with none.
 */
export const makeIpcServer = (handlers: DocumentHandlers) =>
  Effect.gen(function* () {
    const root = yield* Effect.scope;
    const fibers = yield* FiberSet.make();
    const run = yield* FiberSet.runtime(fibers)();
    let current: Document | undefined;
    let closed = false;

    const startDocument = (): Document => {
      const scope = Scope.forkUnsafe(root, 'parallel');
      const document: Document = { scope, connections: 0, serve: Deferred.makeUnsafe() };
      const socketServer = SocketServer.SocketServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe('127.0.0.1', 0),
        run: (handler) =>
          Effect.andThen(Deferred.succeed(document.serve, handler as never), Effect.never),
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
      run(
        Layer.buildWithScope(server, scope).pipe(
          Effect.catchCause((cause) =>
            Effect.andThen(
              Effect.logError('The IPC server could not start.', cause),
              Scope.close(scope, Exit.void),
            ),
          ),
        ),
      );
      return document;
    };

    /** One connection of `document`, served until either side closes it or the document ends. */
    const serve = (document: Document, port: MessagePortLike) =>
      Effect.gen(function* () {
        const handler = yield* Deferred.await(document.serve);
        const socket = yield* makePortSocket(Effect.succeed(port));
        yield* Effect.scoped(handler(socket));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            document.connections--;
            port.close();
          }),
        ),
        Effect.ignore,
        Effect.forkIn(document.scope),
      );

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closed = true;
        const document = current;
        current = undefined;
        return document ? Scope.close(document.scope, Exit.void) : Effect.void;
      }),
    );

    return {
      /**
       * Serves `port` for the current document, starting one if needed; refuses it (false) past
       * `ipcLimits.connections` or once disposed. Synchronous, so a check and its reservation are
       * one step.
       */
      connect(port: MessagePortLike): boolean {
        if (closed) return false;
        const document = (current ??= startDocument());
        if (document.connections >= ipcLimits.connections) return false;
        document.connections++;
        run(serve(document, port));
        return true;
      },
      /** Ends the current document's connections and what its requests hold. */
      releaseDocument: Effect.suspend(() => {
        const document = current;
        current = undefined;
        return document ? Scope.close(document.scope, Exit.void) : Effect.void;
      }),
      /** Releases the current document and refuses every later connection. */
      dispose: Effect.suspend(() => {
        closed = true;
        const document = current;
        current = undefined;
        return document ? Scope.close(document.scope, Exit.void) : Effect.void;
      }),
    };
  });
export type IpcServer = Effect.Success<ReturnType<typeof makeIpcServer>>;
