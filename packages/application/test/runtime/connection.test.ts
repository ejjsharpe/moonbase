import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import { chatHostVersion, chatProtocolVersion } from '@moonbase/contracts/host';
import { makeConnectionClient } from '@moonbase/application/runtime/clients';
import { ConnectionService, type ConnectionServiceShape } from '@moonbase/contracts/services';
import { releaseResource } from '@moonbase/effect';

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
function fixture() {
  const counts = {
    acquired: 0,
    released: 0,
    connect: 0,
    disconnect: 0,
    endpoints: 0,
    watch: 0,
    unwatch: 0,
  };
  const watched = event<void>(),
    unwatched = event<void>();
  let snapshot: ConnectionSnapshot = { profile, state: 'disconnected', connectionId: null };
  const service: ConnectionServiceShape = {
    getConnection: () => Effect.sync(() => structuredClone(snapshot)),
    connect: (input) =>
      Effect.sync(() => {
        assert.equal(input.profileId, profile.id);
        counts.connect++;
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
  return { counts, runtime, client: makeConnectionClient(runtime), watched, unwatched };
}

test('public connection clients share one scoped service and keep endpoint lookup outside public commands', async () => {
  const { counts, runtime, client, watched, unwatched } = fixture();
  const second = makeConnectionClient(runtime);
  let stop = async () => {};
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
    await stop();
    await unwatched.promise;
    assert.equal((await second.command('getConnection', {})).state, 'connected');
    await client.command('disconnect', { connectionId: connected.connectionId });
    assert.equal((await second.command('getConnection', {})).state, 'disconnected');
    assert.equal(counts.acquired, 1);
    assert.equal(counts.endpoints, 0);
    assert.equal(counts.connect, 1);
    assert.equal(counts.disconnect, 1);
  } finally {
    await stop();
    await runtime.dispose();
  }
  assert.equal(counts.released, 1);
  assert.equal(counts.unwatch, 1);
  await assert.rejects(client.command('getConnection', {}));
});
