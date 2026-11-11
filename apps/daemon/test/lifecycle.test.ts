import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createKeyFileSource } from '@moonbase/chat-runtime/credentials';
import { runDaemon } from '../src/daemon.ts';
import { createControlledClock, startInProcess, temporaryRoot } from './fixture.ts';
import { createFauxProviders } from './faux.ts';

const minute = 60_000;
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
/** Whether another connection can read the store, which the runtime holds exclusively while open. */
function storeIsClosed(directory: string) {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(join(directory, 'chat.sqlite'), { timeout: 0 });
    database.prepare('SELECT count(*) FROM moonbase_owner_lock').get();
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
async function serverRefuses(port: number) {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/health`);
    return false;
  } catch {
    return true;
  }
}

/** Records what has closed when Claude Code's workers are closed, which comes last but one. */
function recordShutdown(directory: () => string, port: () => number) {
  const calls: { serverClosed: boolean; storeClosed: boolean; endpoint: boolean }[] = [];
  return {
    calls,
    closeClaudeCode: async () => {
      calls.push({
        serverClosed: await serverRefuses(port()),
        storeClosed: storeIsClosed(directory()),
        endpoint: await exists(join(directory(), 'endpoint.json')),
      });
    },
  };
}

for (const exit of ['stopped', 'idle'] as const)
  test(`a daemon ${exit === 'idle' ? 'going idle' : 'told to stop'} closes the server, then the runtime, then Claude Code, then removes endpoint.json`, async () => {
    const root = await temporaryRoot(),
      time = createControlledClock();
    let daemon: Awaited<ReturnType<typeof startInProcess>> | undefined;
    const shutdown = recordShutdown(
      () => daemon!.directory,
      () => daemon!.port,
    );
    try {
      daemon = await startInProcess(root, time, { closeClaudeCode: shutdown.closeClaudeCode });
      assert.equal(storeIsClosed(daemon.directory), false, 'the running daemon holds the store');
      assert.equal(await serverRefuses(daemon.port), false);
      if (exit === 'idle') await time.advance(5 * minute + 30_000);
      else await daemon.stop();
      assert.equal(await daemon.running, exit);
      assert.deepEqual(shutdown.calls, [{ serverClosed: true, storeClosed: true, endpoint: true }]);
      assert.equal(await exists(join(daemon.directory, 'endpoint.json')), false);
    } finally {
      await daemon?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

test('a daemon stopped before it listens never announces itself, and still cleans up', async () => {
  const root = await temporaryRoot(),
    directory = join(root, 'data'),
    controller = new AbortController();
  controller.abort();
  let ready = 0,
    closed = 0;
  try {
    const exit = await runDaemon({
      directory,
      signal: controller.signal,
      ready: () => ready++,
      closeClaudeCode: async () => {
        closed++;
      },
      providers: () => createFauxProviders(directory),
    });
    assert.equal(exit, 'stopped');
    assert.equal(ready, 0);
    assert.equal(closed, 1);
    assert.equal(await exists(join(directory, 'endpoint.json')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function prepareDirectory(root: string, files: Record<string, string>) {
  const directory = join(root, 'data');
  await mkdir(directory, { mode: 0o700 });
  for (const [name, text] of Object.entries(files))
    await writeFile(join(directory, name), text, { mode: 0o600 });
  return directory;
}
const failToStart = (directory: string, providers = () => createFauxProviders(directory)) =>
  runDaemon({
    directory,
    signal: new AbortController().signal,
    ready: () => assert.fail('the daemon must not become ready'),
    closeClaudeCode: async () => {},
    providers,
  });

test('a stale endpoint.json from a crashed daemon is removed once the lock is taken', async () => {
  const root = await temporaryRoot();
  try {
    const directory = await prepareDirectory(root, {
      'endpoint.json': JSON.stringify({ port: 1, pid: 1, version: '0.1.0', protocol: 2 }),
      // Startup fails after the lock, so only the lock step can have removed the endpoint.
      'daemon.json': '{ not json',
    });
    await assert.rejects(failToStart(directory), { message: /malformed/ });
    assert.equal(await exists(join(directory, 'endpoint.json')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a damaged daemon.lock is refused with a hint that names no path', async () => {
  const root = await temporaryRoot();
  try {
    const directory = await prepareDirectory(root, { 'daemon.lock': 'x'.repeat(4096) });
    const error = await failToStart(directory).then(
      () => assert.fail('started'),
      (error: Error) => error,
    );
    assert.match(error.message, /lock file is damaged.*remove daemon\.lock/);
    assert.ok(!error.message.includes(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a local daemon refuses an insecure credential key file at startup, and creates no key', async () => {
  const root = await temporaryRoot();
  try {
    const keys = join(root, 'keys');
    await mkdir(keys, { mode: 0o700 });
    const keyPath = join(keys, 'credential.key');
    const directory = await prepareDirectory(root, {
      'daemon.json': JSON.stringify({
        mode: 'local',
        credentialKey: { source: 'file', path: keyPath },
      }),
    });
    const local = () => ({
      ...createFauxProviders(directory),
      keySource: createKeyFileSource(keyPath),
    });
    await writeFile(keyPath, 'not a key', { mode: 0o644 });
    const insecure = await failToStart(directory, local).then(
      () => assert.fail('started'),
      (error: Error) => error,
    );
    assert.match(insecure.message, /credential key file must be a regular file/);
    assert.ok(!insecure.message.includes(root));

    // A missing key file is fine at startup; nothing creates it until a sign-in needs it.
    await rm(keyPath);
    const controller = new AbortController();
    let ready!: () => void;
    const listening = new Promise<void>((resolve) => (ready = resolve));
    const running = runDaemon({
      directory,
      signal: controller.signal,
      ready: () => ready(),
      closeClaudeCode: async () => {},
      providers: local,
    });
    try {
      await listening;
      assert.equal(await exists(keyPath), false);
    } finally {
      controller.abort();
      assert.equal(await running, 'stopped');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
