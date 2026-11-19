import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred, Effect, Exit, ManagedRuntime, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { rpcLimits } from '@moonbase/contracts/rpc-upgrade';
import type { BunWebSocket } from '../src/server/bun-server.ts';
import { makeRpcConnections, type RpcSocketData } from '../src/server/rpc-connections.ts';
import { until } from './runtime-fixture.ts';

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
  const connections = await runtime.runPromise(
    makeRpcConnections({ messageBytes: 1024, queuedBytes: 1 }).pipe(Scope.provide(scope)),
  );
  // The handler writes one reply when the test says, as an RPC server answers a request.
  const reply = Effect.runSync(Deferred.make<void>());
  let started = false;
  runtime.runFork(
    connections.server.run((socket) =>
      Effect.gen(function* () {
        const writer = yield* socket.writer;
        started = true;
        yield* Deferred.await(reply);
        yield* writer.write(new Uint8Array(8));
        return yield* Effect.never;
      }).pipe(Effect.scoped),
    ),
  );
  connections.open(ws);
  await until(async () => started, Boolean);

  // Halfway through the idle bound, a reply the client does not drain stops the daemon reading.
  await advance(rpcLimits.idleMs / 2);
  state.buffered = 2 * rpcLimits.outboundBytes;
  Effect.runSync(Deferred.succeed(reply, undefined));
  await until(async () => state.paused, Boolean);
  // Just short of the bound since the connection opened, the client drains and it reads again.
  await advance(rpcLimits.idleMs / 2 - 1_000);
  state.buffered = 0;
  connections.drain(ws);
  await until(
    async () => state.paused,
    (paused) => !paused,
  );
  // The idle wait starts afresh: the connection closes a whole idle bound later, not before.
  await advance(rpcLimits.idleMs - 1);
  assert.equal(state.closed, undefined);
  await advance(1);
  assert.equal(state.closed, 1008);
});
