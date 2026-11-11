import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { ChatService, ConnectionService } from '@moonbase/contracts/services';
import { RemoteChatLive } from '@moonbase/pi-runtime/remote';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import {
  createLocalDaemon,
  findDaemonDirectory,
  LocalDaemonConnectionLive,
  readDaemonSession,
} from '../src/main/local-daemon.ts';
import {
  makeFauxDaemonCommand,
  prepareDaemonData,
  readDaemonPid,
  stopDaemon,
} from './faux-daemon.mjs';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(ready: () => boolean | Promise<boolean>, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw Error('Condition did not settle.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A temporary profile with a daemon directory; the daemon it ran is stopped afterwards. */
async function profile(t: TestContext) {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-local-daemon-')));
  const directory = findDaemonDirectory(userData);
  await prepareDaemonData(userData);
  const command = makeFauxDaemonCommand(directory);
  t.after(async () => {
    await stopDaemon(directory);
    await rm(userData, { recursive: true, force: true });
  });
  return { userData, directory, command };
}

/** The loopback connection to a daemon, as main builds it. */
async function connect(t: TestContext, daemon: ReturnType<typeof createLocalDaemon>) {
  const runtime = ManagedRuntime.make(LocalDaemonConnectionLive(daemon));
  t.after(() => runtime.dispose());
  const connection = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ConnectionService;
    }),
  );
  return { runtime, connection };
}

test('each profile has its own daemon directory', () => {
  assert.equal(findDaemonDirectory('/profiles/Moonbase Dev'), '/profiles/Moonbase Dev/daemon-v1');
  assert.notEqual(findDaemonDirectory('/profiles/Moonbase'), findDaemonDirectory('/profiles/Dev'));
});

test('with no daemon running one is started detached; another app finds and reuses it', async (t) => {
  const { directory, command } = await profile(t);
  const first = createLocalDaemon({ directory, command });
  assert.equal(first.isRunning(), false);
  await first.ensure();
  const pid = (await readDaemonPid(directory))!;
  assert(pid && isAlive(pid));
  assert.equal(first.isRunning(), true);
  const session = await readDaemonSession(directory);
  // A second launch of the app finds the same daemon rather than starting one.
  const second = createLocalDaemon({ directory, command });
  await second.ensure();
  assert.equal(await readDaemonPid(directory), pid);
  assert.equal(second.isRunning(), true);
  assert.deepEqual(await readDaemonSession(directory), session);
  // Both connect to it and verify its signed health for the expected host and store.
  for (const daemon of [first, second]) {
    const { runtime, connection } = await connect(t, daemon);
    const endpoint = await runtime.runPromise(connection.endpoint({ host: session.host }));
    assert.deepEqual(endpoint.expected, session.host);
    assert.equal(endpoint.health.protocol, chatProtocolVersion);
  }
});

test('a crashed daemon is restarted on the next request, in a new connection generation', async (t) => {
  const { directory, command } = await profile(t);
  const daemon = createLocalDaemon({ directory, command });
  await daemon.ensure();
  const session = await readDaemonSession(directory);
  const { runtime, connection } = await connect(t, daemon);
  const before = await runtime.runPromise(connection.endpoint({ host: session.host }));
  const pid = (await readDaemonPid(directory))!;
  process.kill(pid, 'SIGKILL');
  await until(() => !daemon.isRunning());
  // Its endpoint is left behind, naming a process that is gone.
  assert.equal(await readDaemonPid(directory), pid);
  const after = await runtime.runPromise(connection.endpoint({ host: session.host }));
  assert.notEqual(after.connectionId, before.connectionId);
  assert.notEqual(await readDaemonPid(directory), pid);
  assert.deepEqual(await readDaemonSession(directory), session, 'the same store restarts');
  assert.equal(daemon.isRunning(), true);
});

test('an endpoint naming a live process that does not answer starts a daemon that does', async (t) => {
  const { directory, command } = await profile(t);
  const daemon = createLocalDaemon({ directory, command });
  await daemon.ensure();
  const session = await readDaemonSession(directory);
  const pid = (await readDaemonPid(directory))!;
  await stopDaemon(directory, pid);
  // A reused process ID: this test process, which is alive but serves nothing.
  await writeFile(
    join(directory, 'endpoint.json'),
    JSON.stringify({ port: 9, pid: process.pid, version: '0.1.0', protocol: chatProtocolVersion }),
    { mode: 0o600 },
  );
  const { runtime, connection } = await connect(t, daemon);
  const endpoint = await runtime.runPromise(connection.endpoint({ host: session.host }));
  assert.deepEqual(endpoint.expected, session.host);
  const restarted = (await readDaemonPid(directory))!;
  assert.notEqual(restarted, process.pid);
  assert(isAlive(restarted));
});

test('an outdated daemon of this directory is stopped and replaced; an unrelated process is left alone', async (t) => {
  const { directory, command } = await profile(t);
  // Stands in for an older daemon: alive, with the data directory as its last argument.
  const older = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', directory], {
    stdio: 'ignore',
  });
  t.after(() => older.kill('SIGKILL'));
  await once(older, 'spawn');
  await writeFile(
    join(directory, 'endpoint.json'),
    JSON.stringify({ port: 9, pid: older.pid, version: '0.0.1', protocol: chatProtocolVersion }),
    { mode: 0o600 },
  );
  const daemon = createLocalDaemon({ directory, command });
  await daemon.ensure();
  await until(() => older.exitCode !== null || older.signalCode !== null);
  assert.equal(older.signalCode, 'SIGTERM');
  const current = (await readDaemonPid(directory))!;
  assert.notEqual(current, older.pid);
  await stopDaemon(directory, current);
  // A process that isn't a daemon on this directory is never signalled.
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await once(other, 'spawn');
  await writeFile(
    join(directory, 'endpoint.json'),
    JSON.stringify({ port: 9, pid: other.pid, version: '0.0.1', protocol: chatProtocolVersion }),
    { mode: 0o600 },
  );
  await createLocalDaemon({ directory, command }).ensure();
  assert.equal(other.exitCode, null);
  assert(isAlive(other.pid!));
  assert.notEqual(await readDaemonPid(directory), other.pid);
});

test('a daemon that cannot start, exits while starting or never listens is Unavailable', async (t) => {
  const { directory, command } = await profile(t);
  await assert.rejects(
    createLocalDaemon({
      directory,
      command: { ...command, command: join(directory, 'missing-bun') },
    }).ensure(),
    { code: 'Unavailable', message: 'Moonbase could not start its local chat daemon.' },
  );
  await assert.rejects(
    createLocalDaemon({
      directory,
      command: { ...command, command: '/usr/bin/false', args: [] },
    }).ensure(),
    { code: 'Unavailable', message: 'The local chat daemon stopped while starting.' },
  );
  const marker = join(directory, 'slow.pid');
  await assert.rejects(
    createLocalDaemon({
      directory,
      command: {
        ...command,
        command: '/bin/sh',
        args: ['-c', `echo $$ > ${marker}; exec sleep 30`],
      },
      startMs: 300,
    }).ensure(),
    { code: 'Unavailable', message: 'The local chat daemon did not start in time.' },
  );
  // The daemon that never listened is not left running.
  const slow = Number(await readFile(marker, 'utf8'));
  await until(() => !isAlive(slow));
});

test('the connection fails as Unavailable when no daemon can be started, and recovers later', async (t) => {
  const { directory, command } = await profile(t);
  let broken = false;
  const daemon = createLocalDaemon({ directory, command });
  await daemon.ensure();
  const session = await readDaemonSession(directory);
  const failing = {
    ...daemon,
    ensure: () => (broken ? Promise.reject(Error('spawn failed')) : daemon.ensure()),
  };
  const { runtime, connection } = await connect(t, failing);
  await runtime.runPromise(connection.endpoint({ host: session.host }));
  broken = true;
  await stopDaemon(directory);
  await assert.rejects(runtime.runPromise(connection.endpoint({ host: session.host })), {
    code: 'Unavailable',
  });
  broken = false;
  const endpoint = await runtime.runPromise(connection.endpoint({ host: session.host }));
  assert.deepEqual(endpoint.expected, session.host);
});

test('the mock profile seeds the daemon store, and its daemon starts with the seeded chats', async (t) => {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-mock-profile-')));
  const directory = findDaemonDirectory(userData);
  t.after(async () => {
    await stopDaemon(directory);
    await rm(userData, { recursive: true, force: true });
  });
  const seed = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('../scripts/seed-mock-chats.ts', import.meta.url)),
      userData,
    ],
    { stdio: 'ignore' },
  );
  const [status] = await once(seed, 'exit');
  assert.equal(status, 0);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of ['identity.json', 'chat.sqlite'])
    assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600, file);
  // Seeding refuses a profile whose daemon directory exists, so it never replaces chats.
  const again = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('../scripts/seed-mock-chats.ts', import.meta.url)),
      userData,
    ],
    { stdio: 'ignore' },
  );
  assert.notEqual((await once(again, 'exit'))[0], 0);
  const session = await readDaemonSession(directory);
  const daemon = createLocalDaemon({ directory, command: makeFauxDaemonCommand(directory) });
  await daemon.ensure();
  assert.deepEqual(await readDaemonSession(directory), session, 'the daemon keeps the identity');
  const runtime = ManagedRuntime.make(
    RemoteChatLive.pipe(Layer.provide(LocalDaemonConnectionLive(daemon))),
  );
  t.after(() => runtime.dispose());
  const { conversations } = await runtime.runPromise(
    Effect.flatMap(ChatService, (chat) => chat.listChats({ session })),
  );
  assert.deepEqual(conversations.map((conversation) => conversation.title).sort(), [
    'Move the transcript to Legend List',
    'Plain question',
    'Summarise this repository',
  ]);
});
