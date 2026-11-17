import { Cause, Effect, FiberSet, Layer, Queue, type Scope, Semaphore } from 'effect';
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
  /** Reply bytes waiting to be written past which the daemon stops reading the connection. */
  queuedBytes: number;
  /** Held in each connection's scope, from when it opens until it closes. */
  track?: Effect.Effect<void, never, Scope.Scope>;
};

/**
 * The daemon's authenticated connections to one socket, as the `SocketServer` an RPC server runs
 * on. Bun upgrades a connection only once its proof checked out; each one then becomes an Effect
 * `Socket` that writes one message at a time and waits while Bun buffers more than
 * `rpcLimits.outboundBytes` (closing the connection when the client drains nothing for
 * `rpcLimits.drainMs`, cut without a close frame), that stops reading from the connection while
 * `queuedBytes` of replies wait to be written (so what a client sends meanwhile waits in its own
 * and the kernel's buffers, never the daemon's), and that closes on a message past
 * `messageBytes` and after `rpcLimits.idleMs` on the Clock without one while it reads (clients
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
        // Counted in this connection's scope, until it closes.
        if (options.track) yield* options.track;
        const inbound = yield* Queue.unbounded<string | Uint8Array, Socket.SocketError>();
        // Holds a mark while a message arrived since the idle wait last took one.
        const activity = yield* Queue.sliding<void>(1);
        // Writes go one at a time, so at most one waits for a drain: its wake-up is this.
        let waiting: (() => void) | undefined,
          closed = false,
          queued = 0,
          // Set while replies past `queuedBytes` wait to be written: Bun reads nothing meanwhile.
          paused = false;
        const wake = () => {
          const resume = waiting;
          waiting = undefined;
          resume?.();
        };
        ws.data.connection = {
          receive(message) {
            Queue.offerUnsafe(activity, undefined);
            Queue.offerUnsafe(inbound, message);
          },
          drained: wake,
          closed(code) {
            closed = true;
            Queue.failCauseUnsafe(
              inbound,
              Cause.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) })),
            );
            wake();
          },
        };
        const writes = yield* Semaphore.make(1);
        /**
         * Waits while Bun buffers more than `outboundBytes`. A client that drains nothing for
         * `drainMs` is disconnected, which ends every wait on it.
         */
        // Checked and registered in one step, so a drain between the two is never missed.
        const drained = Effect.callback<boolean>((resume) => {
          if (closed || ws.getBufferedAmount() <= rpcLimits.outboundBytes)
            return resume(Effect.succeed(true));
          waiting = () => resume(Effect.succeed(false));
        });
        const backpressure: Effect.Effect<void> = drained.pipe(
          Effect.timeoutOrElse({
            duration: rpcLimits.drainMs,
            // Cut at once: a close frame would wait behind what the client never read.
            orElse: () => Effect.sync(() => (ws.terminate(), true)),
          }),
          Effect.flatMap((done) => (done ? Effect.void : backpressure)),
        );
        const send = (chunk: Uint8Array | string) => {
          const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
          // Counted and released in one uninterruptible step around the interruptible write.
          return Effect.uninterruptibleMask((restore) =>
            Effect.suspend(() => {
              queued += bytes;
              if (queued >= options.queuedBytes && !paused && !closed) {
                paused = true;
                ws.pause();
              }
              return restore(
                writes.withPermits(1)(
                  Effect.andThen(
                    Effect.sync(() => {
                      if (typeof chunk === 'string') ws.sendBinary(new TextEncoder().encode(chunk));
                      else ws.sendBinary(chunk);
                    }),
                    backpressure,
                  ),
                ),
              ).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    queued -= bytes;
                    if (queued < options.queuedBytes && paused) {
                      paused = false;
                      if (!closed) ws.resume();
                    }
                  }),
                ),
              );
            }),
          );
        };
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
        // A connection silent past its idle bound is closed; any message, a ping too, counts. While
        // the daemon itself reads nothing, the client is not silent; the drain bound applies.
        yield* Effect.forkScoped(
          Effect.forever(
            Queue.take(activity).pipe(
              Effect.timeoutOrElse({
                duration: rpcLimits.idleMs,
                orElse: () =>
                  Effect.sync(() => {
                    if (!paused) ws.close(closeCodes.policy);
                  }),
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
        }
        sockets.clear();
      }),
    );

    /** Upgrades accepted whose connection has not opened yet; each holds a place under the cap. */
    let pending = 0;
    return {
      server,
      /**
       * Holds a place for one upgrade if the open and pending connections leave one under `cap`,
       * in the same synchronous step as the check: `open` takes it, `unreserve` gives it back.
       */
      reserve(cap: number) {
        if (sockets.size + pending >= cap) return false;
        pending++;
        return true;
      },
      unreserve() {
        pending--;
      },
      /** Bun's handlers for these connections; a failure cuts the connection, never reaches Bun. */
      open(ws: BunWebSocket<RpcSocketData>) {
        if (pending > 0) pending--;
        sockets.add(ws);
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
        ws.data.connection?.closed(code);
      },
    };
  });
export type RpcConnections = Effect.Success<ReturnType<typeof makeRpcConnections>>;
/** An RPC server's `SocketServer`: the connections Bun upgrades on its socket's path. */
export const rpcSocketServerLayer = (connections: RpcConnections) =>
  Layer.succeed(SocketServer.SocketServer, connections.server);
