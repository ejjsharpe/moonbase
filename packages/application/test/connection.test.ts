import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { ApplicationError } from '../src/client.ts';
import type { ConnectionSnapshot } from '../src/connection-client.ts';
import { chatHostVersion, chatProtocolVersion } from '../src/host-client.ts';
import { makeConnectionClient } from '../src/runtime-client.ts';
import {
  ConnectionService,
  releaseResource,
  type ConnectionServiceShape,
} from '../src/services.ts';

const profile = {
  id: 'configured',
  label: 'Remote',
  destination: 'configured-ssh-alias',
  remotePort: 4312,
  expected: { hostId: 'host', storeId: 'store' },
};
function event<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(options: { slow?: boolean; watchFailure?: boolean } = {}) {
  const counts = {
    acquired: 0,
    released: 0,
    connect: 0,
    disconnect: 0,
    endpoints: 0,
    watch: 0,
    unwatch: 0,
    interrupted: 0,
  };
  const entered = event<void>(),
    watched = event<void>(),
    unwatched = event<void>();
  let snapshot: ConnectionSnapshot = { profile, state: 'disconnected', connectionId: null };
  const service: ConnectionServiceShape = {
    getConnection: () => Effect.sync(() => structuredClone(snapshot)),
    connect: (input) =>
      Effect.gen(function* () {
        assert.equal(input.profileId, profile.id);
        counts.connect++;
        entered.resolve();
        snapshot = { profile, state: 'connecting', connectionId: 'generation-one' };
        if (options.slow)
          yield* Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                counts.interrupted++;
              }),
            ),
          );
        snapshot = {
          profile,
          state: 'connected',
          connectionId: 'generation-one',
          health: {
            ...profile.expected,
            protocol: chatProtocolVersion,
            version: chatHostVersion,
            capabilities: ['chat-v0'],
          },
        };
        return structuredClone(snapshot);
      }),
    disconnect: (input) =>
      Effect.sync(() => {
        assert.equal(input.connectionId, 'generation-one');
        counts.disconnect++;
        snapshot = { profile, state: 'disconnected', connectionId: null };
      }),
    endpoint: () =>
      Effect.sync(() => {
        counts.endpoints++;
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'No endpoint in this boundary fixture',
        });
      }),
    watch: () =>
      Stream.unwrap(
        Effect.as(
          Effect.acquireRelease(
            Effect.sync(() => {
              counts.watch++;
              watched.resolve();
            }),
            () =>
              releaseResource(() => {
                counts.unwatch++;
                unwatched.resolve();
                if (options.watchFailure) throw Error('Connection observer cleanup failed');
              }),
          ),
          Stream.concat(Stream.succeed(snapshot), Stream.never),
        ),
      ),
  };
  const runtime = ManagedRuntime.make(
    Layer.effect(
      ConnectionService,
      Effect.acquireRelease(
        Effect.sync(() => {
          counts.acquired++;
          return service;
        }),
        () =>
          releaseResource(() => {
            counts.released++;
          }),
      ),
    ),
  );
  return { counts, runtime, client: makeConnectionClient(runtime), entered, watched, unwatched };
}

test('public connection clients share one scoped service and keep endpoint lookup outside public commands', async () => {
  const { counts, runtime, client, watched, unwatched } = fixture();
  const second = makeConnectionClient(runtime);
  let stop = () => {};
  try {
    assert.equal((await client.command('getConnection', {})).state, 'disconnected');
    const connected = await second.command('connect', { profileId: profile.id });
    assert(connected.state === 'connected');
    assert.deepEqual(connected.health.hostId, profile.expected.hostId);
    stop = client.watch(
      () => {},
      (error) => {
        throw error;
      },
    );
    await watched.promise;
    stop();
    await unwatched.promise;
    assert.equal((await second.command('getConnection', {})).state, 'connected');
    await client.command('disconnect', { connectionId: connected.connectionId });
    assert.equal((await second.command('getConnection', {})).state, 'disconnected');
    assert.equal(counts.acquired, 1);
    assert.equal(counts.endpoints, 0);
    assert.equal(counts.connect, 1);
    assert.equal(counts.disconnect, 1);
  } finally {
    stop();
    await runtime.dispose();
  }
  assert.equal(counts.released, 1);
  assert.equal(counts.unwatch, 1);
  await assert.rejects(client.command('getConnection', {}));
});

test('an in-flight connection command does not block status and cancellation retains the service', async () => {
  const { counts, runtime, client, entered } = fixture({ slow: true });
  const abort = new AbortController();
  const pending = client.command('connect', { profileId: profile.id }, { signal: abort.signal });
  const rejected = assert.rejects(
    pending,
    (error) => ApplicationError.is(error) && error.code === 'Cancelled',
  );
  try {
    await entered.promise;
    assert.equal((await client.command('getConnection', {})).state, 'connecting');
    abort.abort();
    await rejected;
    assert.equal(counts.interrupted, 1);
    assert.equal(counts.released, 0);
    await client.command('getConnection', {});
  } finally {
    abort.abort();
    await runtime.dispose();
  }
  assert.equal(counts.released, 1);
});

test('pre-aborted connection commands dispatch nothing', async () => {
  const { counts, runtime, client } = fixture();
  const abort = new AbortController();
  abort.abort();
  try {
    await assert.rejects(
      client.command('connect', { profileId: profile.id }, { signal: abort.signal }),
      (error) => ApplicationError.is(error) && error.code === 'Cancelled',
    );
  } finally {
    await runtime.dispose();
  }
  assert.equal(counts.connect, 0);
  assert.equal(counts.acquired, 0);
});

test('connection observer cleanup errors remain observable without disposing the process service', async () => {
  const { counts, runtime, client, watched } = fixture({ watchFailure: true });
  const reported = event<ApplicationError>();
  let stop = () => {};
  try {
    stop = client.watch(
      () => {},
      (error) => reported.resolve(error),
    );
    await watched.promise;
    stop();
    const error = await reported.promise;
    assert.equal(error.code, 'Unavailable');
    assert.match(error.message, /cleanup failed/);
    assert.equal(counts.unwatch, 1);
    assert.equal(counts.released, 0);
    await client.command('getConnection', {});
  } finally {
    stop();
    await runtime.dispose();
  }
});
