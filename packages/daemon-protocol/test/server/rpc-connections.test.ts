import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, ManagedRuntime, Queue, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { rpcLimits } from '@moonbase/contracts/rpc-upgrade';
import type { BunWebSocket } from '../../src/server/bun-server.ts';
import { makeRpcConnections, type RpcSocketData } from '../../src/server/rpc-connections.ts';
import { until } from '../runtime-fixture.ts';

test('the idle wait stops while the daemon reads nothing from a connection, and a fresh one starts once it reads again', async (t) => {
  const runtime = ManagedRuntime.make(TestClock.layer()),
    scope = Effect.runSync(Scope.make());
  t.after(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
  });
  const advance = (ms: number) => runtime.runPromise(TestClock.adjust(ms));
  // A Bun socket whose buffered output the test sets, recording whether it is read and its close.
  const state = { buffered: 0, paused: false, closed: undefined as number | undefined };
  const ws: BunWebSocket<RpcSocketData> = {
    data: { kind: 'rpc' },
    sendBinary: (data) => data.byteLength,
    close: (code) => void (state.closed ??= code),
    terminate: () => void (state.closed ??= 1006),
    pause: () => void (state.paused = true),
    resume: () => void (state.paused = false),
    getBufferedAmount: () => state.buffered,
  };
  // Two six-byte replies waiting to be written pass the ten-byte bound; one alone does not.
  const connections = await runtime.runPromise(
    makeRpcConnections({ messageBytes: 1024, queuedBytes: 10 }).pipe(Scope.provide(scope)),
  );
  // The handler writes a six-byte reply each time the test says, as an RPC server answers
  // requests, each in a fiber of its own.
  const replies = Effect.runSync(Queue.unbounded<void>());
  const reply = () => Queue.offerUnsafe(replies, undefined);
  let started = false;
  runtime.runFork(
    connections.server.run((socket) =>
      Effect.gen(function* () {
        const writer = yield* socket.writer;
        started = true;
        return yield* Queue.take(replies).pipe(
          Effect.andThen(
            Effect.forkChild(writer.write(new Uint8Array(6)), { startImmediately: true }),
          ),
          Effect.forever,
        );
      }).pipe(Effect.scoped),
    ),
  );
  connections.open(ws);
  await until(async () => started, Boolean);
  const resumed = () =>
    until(
      async () => state.paused,
      (paused) => !paused,
    );

  // Halfway through the idle bound, the client drains nothing: one reply waits for the drain and
  // a second passes the bound, which stops the daemon reading.
  await advance(rpcLimits.idleMs / 2);
  state.buffered = 2 * rpcLimits.outboundBytes;
  reply();
  reply();
  await until(async () => state.paused, Boolean);
  // Past the bound since the connection opened it stays open: the client is not silent.
  await advance(rpcLimits.idleMs / 2 + 1_000);
  assert.equal(state.closed, undefined);
  // The client drains and the daemon reads again.
  state.buffered = 0;
  connections.drain(ws);
  await resumed();

  // The idle wait starts afresh: the connection closes a whole idle bound later, not before.
  await advance(rpcLimits.idleMs - 1);
  assert.equal(state.closed, undefined);
  await advance(1);
  assert.equal(state.closed, 1008);
});
