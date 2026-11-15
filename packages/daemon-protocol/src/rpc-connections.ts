import { Cause, Effect, FiberSet, Layer, Queue } from 'effect';
import * as Socket from 'effect/socket/Socket';
import * as SocketServer from 'effect/socket/SocketServer';
import * as NetAddress from 'effect/net/NetAddress';
import { rpcLimits } from '@moonbase/contracts/rpc-upgrade';
import type { BunWebSocket } from './bun-server.ts';

/** What Bun keeps with an upgraded connection: which socket it is for, and its Effect side. */
export type RpcSocketData = { kind: 'rpc' | 'workspace'; connection?: RpcConnection };
type RpcConnection = {
  receive(message: string | Uint8Array): void;
  drained(): void;
  closed(code: number): void;
};
/**
 * Close codes a daemon sends a connection: going away on shutdown, policy for any refusal, too
 * big for a message past its bound.
 */
const closeCodes = { goingAway: 1001, policy: 1008, tooBig: 1009 };
const sizeOf = (message: string | Uint8Array) =>
  typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;

export type RpcConnectionOptions = {
  /** The largest message a connection may send; a larger one closes it. */
  messageBytes: number;
  /** Called once a connection opens; what it returns, once that closes. */
  track?(): () => void;
};

/**
 * The daemon's authenticated connections to one socket, as the `SocketServer` an RPC server runs
 * on. Bun upgrades a connection only once its proof checked out; each one then becomes an Effect
 * `Socket` whose writes wait while Bun buffers more than `rpcLimits.outboundBytes`, which closes on
 * a message past `messageBytes`, and after `rpcLimits.idleMs` on the Clock without one (clients
 * ping every 5 s).
 */
export const makeRpcConnections = (options: RpcConnectionOptions) =>
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make<unknown, unknown>();
    let handle: ((socket: Socket.Socket) => Effect.Effect<unknown, unknown, never>) | undefined;
    const sockets = new Set<BunWebSocket<RpcSocketData>>();
    const run = yield* FiberSet.runtime(fibers)<never>();

    /** One connection's Socket over its Bun WebSocket. */
    const connect = (ws: BunWebSocket<RpcSocketData>) =>
      Effect.gen(function* () {
        const inbound = yield* Queue.unbounded<string | Uint8Array, Socket.SocketError>();
        // Holds a mark while a message arrived since the idle wait last took one.
        const activity = yield* Queue.sliding<void>(1);
        let waiting: (() => void) | undefined;
        ws.data.connection = {
          receive(message) {
            Queue.offerUnsafe(activity, undefined);
            Queue.offerUnsafe(inbound, message);
          },
          drained() {
            const resume = waiting;
            waiting = undefined;
            resume?.();
          },
          closed(code) {
            Queue.failCauseUnsafe(
              inbound,
              Cause.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) })),
            );
            waiting?.();
          },
        };
        const backpressure = Effect.callback<void>((resume) => {
          if (ws.getBufferedAmount() <= rpcLimits.outboundBytes) return resume(Effect.void);
          waiting = () => resume(Effect.void);
        });
        const send = (chunk: Uint8Array | string) =>
          Effect.andThen(
            Effect.sync(() => {
              if (typeof chunk === 'string') ws.sendBinary(new TextEncoder().encode(chunk));
              else ws.sendBinary(chunk);
            }),
            backpressure,
          );
        const writer: Socket.Writer = {
          write: (chunk) =>
            Socket.isCloseEvent(chunk) ? Effect.sync(() => ws.close(chunk.code)) : send(chunk),
          writeAll: (chunks) => Effect.forEach(chunks, send, { discard: true }),
        };
        const socket = Socket.make({
          reader: Effect.succeed({
            pull: Effect.map(Queue.takeAll(inbound), (messages) => messages as never),
            upgrade: () => Effect.fail(Socket.SocketUpgradeError.unsupported as never),
          }),
          writer: Effect.succeed(writer),
        });
        // A connection silent past its idle bound is closed; any message, a ping too, counts.
        yield* Effect.forkScoped(
          Effect.forever(
            Queue.take(activity).pipe(
              Effect.timeoutOrElse({
                duration: rpcLimits.idleMs,
                orElse: () => Effect.sync(() => ws.close(closeCodes.policy)),
              }),
            ),
          ),
        );
        if (handle) yield* handle(socket);
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          Effect.sync(() => {
            sockets.delete(ws);
            ws.close(closeCodes.goingAway);
          }),
        ),
      );
    // What ends each open connection's tracking, run once when it closes.
    const untrack = new Map<BunWebSocket<RpcSocketData>, () => void>();
    const release = (ws: BunWebSocket<RpcSocketData>) => {
      untrack.get(ws)?.();
      untrack.delete(ws);
    };

    const server = SocketServer.SocketServer.of({
      address: NetAddress.inetAddressFromIpStringUnsafe('127.0.0.1', 0),
      run: (handler) =>
        Effect.suspend(() => {
          handle = handler as never;
          return Effect.never;
        }),
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const ws of sockets) {
          ws.close(closeCodes.goingAway);
          release(ws);
        }
        sockets.clear();
      }),
    );

    return {
      server,
      get count() {
        return sockets.size;
      },
      /** Bun's handlers for these connections; a failure cuts the connection, never reaches Bun. */
      open(ws: BunWebSocket<RpcSocketData>) {
        sockets.add(ws);
        if (options.track) untrack.set(ws, options.track());
        run(connect(ws));
      },
      message(ws: BunWebSocket<RpcSocketData>, message: string | Uint8Array) {
        if (sizeOf(message) > options.messageBytes) return ws.close(closeCodes.tooBig);
        ws.data.connection?.receive(message);
      },
      drain(ws: BunWebSocket<RpcSocketData>) {
        ws.data.connection?.drained();
      },
      close(ws: BunWebSocket<RpcSocketData>, code: number) {
        sockets.delete(ws);
        release(ws);
        ws.data.connection?.closed(code);
      },
    };
  });
export type RpcConnections = Effect.Success<ReturnType<typeof makeRpcConnections>>;
/** An RPC server's `SocketServer`: the connections Bun upgrades on its socket's path. */
export const rpcSocketServerLayer = (connections: RpcConnections) =>
  Layer.succeed(SocketServer.SocketServer, connections.server);
