import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Cause, Context, Effect, Exit, Layer, Scope } from 'effect';
import type { ConnectionFailure } from '@moonbase/contracts/connection-errors';
import { ConnectionService } from '@moonbase/contracts/services';
import { LoopbackConnectionLive } from '@moonbase/daemon-protocol/loopback';
import { bounded, connectClients, readJson, startDaemon, withRoot } from './daemon-fixture.ts';

/** The tag and reason of the error a connection failed with. */
const describeFailure = (cause: Cause.Cause<ConnectionFailure>) => {
  const error = Cause.squash(cause) as ConnectionFailure;
  return { error: error._tag, reason: 'reason' in error ? error.reason : undefined };
};

/**
 * Builds a loopback connection alone, then connects it, and reports the state it reached or the
 * error that stopped it at either step.
 */
async function connectLoopback(directory: string): Promise<{
  step: 'build' | 'connect';
  initial?: string;
  state?: string;
  error?: string;
  reason?: string;
}> {
  const scope = Effect.runSync(Scope.make());
  try {
    const built = await Effect.runPromiseExit(
      Layer.buildWithScope(LoopbackConnectionLive({ directory }), scope),
    );
    if (Exit.isFailure(built)) return { step: 'build', ...describeFailure(built.cause) };
    const service = Context.get(built.value, ConnectionService);
    const initial = await Effect.runPromise(service.getConnection({}));
    const connected = await Effect.runPromiseExit(service.connect({ profileId: 'loopback' }));
    if (Exit.isFailure(connected))
      return { step: 'connect', initial: initial.state, ...describeFailure(connected.cause) };
    await Effect.runPromise(Scope.close(scope, Exit.void));
    // Once closed, the connection neither connects again nor hands out its endpoint.
    const host = (await Effect.runPromise(service.getConnection({}))).profile.expected;
    assert(Exit.isFailure(await Effect.runPromiseExit(service.connect({ profileId: 'loopback' }))));
    assert(Exit.isFailure(await Effect.runPromiseExit(service.endpoint({ host }))));
    return {
      step: 'connect',
      initial: initial.state,
      state: connected.value.state,
    };
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

const unsafe = { error: 'ConnectionError', reason: 'daemon-files-unsafe' };

test('the loopback connection builds from the identity alone while the daemon is stopped', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data');
    const first = startDaemon([directory]);
    started.push(first);
    const { host } = await bounded(first.ready);
    await first.stop();
    await assert.rejects(readFile(join(directory, 'endpoint.json')), { code: 'ENOENT' });
    const clients = await connectClients(directory, host);
    try {
      const initial = await clients.run(clients.connection.getConnection({}));
      assert.equal(initial.state, 'disconnected');
      assert.equal(initial.profile.remotePort, undefined);
      assert.deepEqual(initial.profile.expected, host);
      await assert.rejects(clients.run(clients.connection.connect({ profileId: 'loopback' })), {
        _tag: 'ConnectionError',
        reason: 'daemon-not-running',
      });
      const daemon = startDaemon([directory]);
      started.push(daemon);
      const ready = await bounded(daemon.ready);
      const connected = await clients.run(clients.connection.connect({ profileId: 'loopback' }));
      assert.equal(connected.state, 'connected');
      assert.equal(connected.profile.remotePort, ready.port);
      assert.deepEqual((await clients.run(clients.chat.getChatHost({ host }))).host, host);
    } finally {
      await clients.runtime.dispose();
    }
  });
});

test('the loopback connection never follows a link to its data directory or files', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data'),
      elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    const daemon = startDaemon([directory]);
    started.push(daemon);
    await bounded(daemon.ready);
    assert.equal((await connectLoopback(directory)).state, 'connected');
    // Each file in turn becomes a link to an identical private copy; only the link is wrong.
    for (const [name, step] of [
      ['identity.json', 'build'],
      ['endpoint.json', 'connect'],
      ['token', 'connect'],
    ] as const) {
      const file = join(directory, name),
        copy = join(elsewhere, name);
      await rename(file, copy);
      await symlink(copy, file);
      const { step: refusedAt, error, reason } = await connectLoopback(directory);
      assert.deepEqual({ step: refusedAt, error, reason }, { step, ...unsafe }, name);
      await rm(file);
      await rename(copy, file);
      assert.equal((await connectLoopback(directory)).state, 'connected', name);
    }
    // A link to the whole private data directory is refused too.
    const linked = join(root, 'linked');
    await symlink(directory, linked);
    assert.deepEqual(await connectLoopback(linked), { step: 'build', ...unsafe });
  });
});

test('the loopback connection refuses unsafe files, another protocol, another identity and a wrong token', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data'),
      other = join(root, 'other');
    assert.deepEqual(
      await connectLoopback(directory),
      { step: 'build', error: 'ConnectionError', reason: 'daemon-not-running' },
      'no daemon directory yet, so no identity to bind to',
    );
    const daemon = startDaemon([directory]),
      second = startDaemon([other]);
    started.push(daemon, second);
    const [ready] = await Promise.all([bounded(daemon.ready), bounded(second.ready)]);
    assert.deepEqual(await connectLoopback(directory), {
      step: 'connect',
      initial: 'disconnected',
      state: 'connected',
    });
    await chmod(directory, 0o755);
    assert.equal((await connectLoopback(directory)).step, 'build', 'a directory others can read');
    await chmod(directory, 0o700);
    const endpointFile = join(directory, 'endpoint.json'),
      tokenFile = join(directory, 'token'),
      identityFile = join(directory, 'identity.json');
    const endpoint = await readFile(endpointFile, 'utf8'),
      token = await readFile(tokenFile, 'utf8'),
      identity = await readFile(identityFile, 'utf8');
    await chmod(tokenFile, 0o644);
    assert.deepEqual(
      await connectLoopback(directory),
      { step: 'connect', initial: 'disconnected', ...unsafe },
      'a token others can read',
    );
    await chmod(tokenFile, 0o600);
    await writeFile(endpointFile, JSON.stringify({ ...JSON.parse(endpoint), protocol: 1 }));
    assert.equal((await connectLoopback(directory)).reason, 'daemon-protocol', 'an old protocol');
    await writeFile(endpointFile, endpoint);

    const clients = await connectClients(directory, ready.host);
    try {
      const connect = (profileId = 'loopback') =>
        clients.run(clients.connection.connect({ profileId }));
      assert.equal((await connect()).state, 'connected');
      await assert.rejects(connect('other'), {
        _tag: 'ConnectionError',
        reason: 'loopback-profile',
      });
      await assert.rejects(
        clients.run(
          clients.connection.endpoint({ host: { ...ready.host, storeId: 'another-store' } }),
        ),
        { _tag: 'ConnectionError', reason: 'daemon-mismatch' },
      );
      // Another daemon's endpoint and token: its health names another host and store.
      await writeFile(endpointFile, await readFile(join(other, 'endpoint.json')));
      await writeFile(tokenFile, await readFile(join(other, 'token')));
      await assert.rejects(connect(), { _tag: 'HostVerificationError', reason: 'identity' });
      assert.equal((await clients.run(clients.connection.getConnection({}))).state, 'failed');
      // The right daemon with the wrong token proves nothing.
      await writeFile(endpointFile, endpoint);
      await assert.rejects(connect(), { _tag: 'HostVerificationError', reason: 'rejected' });
      await writeFile(tokenFile, token);
      // A directory whose identity changed is another daemon.
      await writeFile(
        identityFile,
        JSON.stringify({ ...JSON.parse(identity), host: { hostId: 'x', storeId: 'y' } }),
      );
      await assert.rejects(connect(), { _tag: 'ConnectionError', reason: 'daemon-identity' });
      await writeFile(identityFile, identity);
      assert.equal((await connect()).state, 'connected');
    } finally {
      await clients.runtime.dispose();
    }
  });
});

test('the built daemon searches files with the ripgrep shipped beside its bundle, with none on PATH', async () => {
  await withRoot(async (root, started) => {
    // The app's layout: `daemon/daemon.mjs` beside `workspace/ripgrep/rg` in its resources.
    const resources = join(root, 'Resources');
    execFileSync(process.execPath, [
      new URL('../scripts/build.mjs', import.meta.url).pathname,
      join(resources, 'daemon'),
      join(root, 'daemon-inputs.json'),
    ]);
    await mkdir(join(resources, 'workspace/ripgrep'), { recursive: true });
    const rg = join(resources, 'workspace/ripgrep/rg');
    await writeFile(rg, "#!/bin/sh\nprintf 'listed-by-bundled-ripgrep.md\\0'\n");
    await chmod(rg, 0o755);
    const directory = join(root, 'data'),
      project = join(root, 'project');
    await mkdir(directory, { mode: 0o700 });
    // Not a Git repository, so without ripgrep the search would fail.
    await mkdir(project);
    await writeFile(join(project, 'readme.md'), 'hello');
    await writeFile(join(root, 'key'), randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
    await writeFile(
      join(directory, 'daemon.json'),
      JSON.stringify({ mode: 'local', credentialKey: { source: 'file', path: join(root, 'key') } }),
      { mode: 0o600 },
    );
    const daemon = startDaemon([directory], {
      entry: join(resources, 'daemon/daemon.mjs'),
      // Only the system PATH, as an app launched from Finder has: no `rg` on it.
      env: { PATH: '/usr/bin:/bin', HOME: root },
    });
    started.push(daemon);
    const ready = await bounded(daemon.ready);
    const identity = await readJson(join(directory, 'identity.json'));
    const session = { host: identity.host, actorId: identity.actorId };
    const clients = await connectClients(directory, ready.host);
    try {
      await clients.run(clients.connection.connect({ profileId: 'loopback' }));
      await clients.run(
        clients.folders.approveFolder({ host: session.host, requestId: 'approve', path: project }),
      );
      const found = await clients.run(
        clients.chat.findChatFiles({ session, cwd: project, query: '' }),
      );
      assert.deepEqual(
        found.matches.map((match) => match.path),
        ['listed-by-bundled-ripgrep.md'],
      );
    } finally {
      await clients.runtime.dispose();
    }
    assert.deepEqual(await daemon.stop(), [0, null]);
  });
});
