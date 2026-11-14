import { Cause, Effect, FiberSet, Layer, Queue, Schedule } from 'effect';
import * as Socket from 'effect/socket/Socket';
import * as SocketServer from 'effect/socket/SocketServer';
import * as NetAddress from 'effect/net/NetAddress';
import { rpcLimits } from '@moonbase/contracts/rpc-upgrade';
import { socketLimits } from '@moonbase/contracts/socket';
import type { BunWebSocket } from './bun-server.ts';

/** What Bun keeps with an upgraded RPC connection. */
export type RpcSocketData = { kind: 'rpc'; connection?: RpcConnection };
type RpcConnection = {
  receive(message: string | Uint8Array): void;
  drained(): void;
  closed(code: number): void;
};
/** Close codes a daemon sends an RPC connection: going away on shutdown, policy for any refusal. */
const closeCodes = { goingAway: 1001, policy: 1008 };

/**
 * The daemon's authenticated RPC connections, as the `SocketServer` the RPC server runs on. Bun
 * upgrades a connection only once its proof checked out; each one then becomes an Effect
 * `Socket` whose writes wait while Bun buffers more than `socketLimits.outboundBytes`, and which
 * closes after `rpcLimits.idleMs` without a message (clients ping every few seconds).
 */
export const makeRpcConnections = (options: { idleMs?: number } = {}) =>
  Effect.gen(function* () {
    const idleMs = options.idleMs ?? rpcLimits.idleMs;
    const fibers = yield* FiberSet.make<unknown, unknown>();
    let handle: ((socket: Socket.Socket) => Effect.Effect<unknown, unknown, never>) | undefined;
    const sockets = new Set<BunWebSocket<RpcSocketData>>();
    const run = yield* FiberSet.runtime(fibers)<never>();

    /** One connection's Socket over its Bun WebSocket. */
    const connect = (ws: BunWebSocket<RpcSocketData>) =>
      Effect.gen(function* () {
        const inbound = yield* Queue.unbounded<string | Uint8Array, Socket.SocketError>();
        let waiting: (() => void) | undefined;
        let lastReceived = Date.now();
        ws.data.connection = {
          receive(message) {
            lastReceived = Date.now();
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
          if (ws.getBufferedAmount() <= socketLimits.outboundBytes) return resume(Effect.void);
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
          Effect.repeat(
            Effect.sync(() => {
              if (Date.now() - lastReceived >= idleMs) ws.close(closeCodes.policy);
            }),
            Schedule.spaced(Math.max(10, Math.min(idleMs, 5_000))),
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
        for (const ws of sockets) ws.close(closeCodes.goingAway);
        sockets.clear();
      }),
    );

    return {
      server,
      get count() {
        return sockets.size;
      },
      /** Bun's handlers for RPC connections; a failure cuts the connection, never reaches Bun. */
      open(ws: BunWebSocket<RpcSocketData>) {
        sockets.add(ws);
        run(connect(ws));
      },
      message(ws: BunWebSocket<RpcSocketData>, message: string | Uint8Array) {
        ws.data.connection?.receive(message);
      },
      drain(ws: BunWebSocket<RpcSocketData>) {
        ws.data.connection?.drained();
      },
      close(ws: BunWebSocket<RpcSocketData>, code: number) {
        sockets.delete(ws);
        ws.data.connection?.closed(code);
      },
    };
  });
export type RpcConnections = Effect.Success<ReturnType<typeof makeRpcConnections>>;
/** The RPC server's `SocketServer`: the connections Bun upgrades on `/v3/rpc`. */
export const rpcSocketServerLayer = (connections: RpcConnections) =>
  Layer.succeed(SocketServer.SocketServer, connections.server);
