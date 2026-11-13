import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { ChatService, ConnectionService } from '@moonbase/contracts/services';
import type { ApplicationError } from '@moonbase/contracts/errors';
import { LoopbackConnectionLive, loopbackProfileId } from '@moonbase/daemon-protocol/loopback';
import { RemoteChatLive } from '@moonbase/daemon-protocol/remote';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import {
  createLocalDaemon,
  findDaemonDirectory,
  LocalDaemonConnectionLive,
  readDaemonSession,
} from './local-daemon.ts';
import {
  makeFauxDaemonCommand,
  prepareDaemonData,
  readDaemonPid,
  stopDaemon,
  writeFauxScript,
} from '../../../test/fixtures/faux-daemon.mjs';

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
async function connect(
  t: TestContext,
  daemon: ReturnType<typeof createLocalDaemon>,
  now?: () => number,
) {
  const runtime = ManagedRuntime.make(LocalDaemonConnectionLive(daemon, now));
  t.after(() => runtime.dispose());
  const connection = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ConnectionService;
    }),
  );
  return { runtime, connection };
}

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
  assert.equal(second.isOutdated(), false, 'a daemon of the same build is current');
  assert.deepEqual(await readDaemonSession(directory), session);
  // Both connect to it and verify its signed health for the expected host and store.
  for (const daemon of [first, second]) {
    const { runtime, connection } = await connect(t, daemon);
    const endpoint = await runtime.runPromise(connection.endpoint({ host: session.host }));
    assert.deepEqual(endpoint.expected, session.host);
    assert.equal(endpoint.health.protocol, chatProtocolVersion);
  }
});

test('a crashed or unanswering daemon is replaced on the next request, in a new connection generation', async (t) => {
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
  // An endpoint naming a reused process ID: this test process, alive but serving nothing.
  await stopDaemon(directory, (await readDaemonPid(directory))!);
  await writeFile(
    join(directory, 'endpoint.json'),
    JSON.stringify({ port: 9, pid: process.pid, version: '0.1.0', protocol: chatProtocolVersion }),
    { mode: 0o600 },
  );
  const replaced = await runtime.runPromise(connection.endpoint({ host: session.host }));
  assert.deepEqual(replaced.expected, session.host);
  const restarted = (await readDaemonPid(directory))!;
  assert.notEqual(restarted, process.pid);
  assert(isAlive(restarted));
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fauxModel = { provider: 'moonbase-faux', modelId: 'faux-model' };

test('a daemon of another build is used while it has work, then replaced in a new generation', async (t) => {
  const { directory } = await profile(t);
  // The faux model holds its first run until it is stopped.
  await writeFauxScript(directory, { idleMs: 5000, pollMs: 500, steps: [{ hold: true }] });
  // Another app version's daemon, of this protocol.
  await createLocalDaemon({
    directory,
    command: makeFauxDaemonCommand(directory, undefined, 'older-build'),
  }).ensure();
  const older = (await readDaemonPid(directory))!;
  t.after(() => stopDaemon(directory, older));
  const session = await readDaemonSession(directory);
  /** Chat over a connection to the directory's daemon. */
  const chatOver = async (connection: Layer.Layer<ConnectionService, ApplicationError>) => {
    const runtime = ManagedRuntime.make(RemoteChatLive.pipe(Layer.provideMerge(connection)));
    t.after(() => runtime.dispose());
    return {
      runtime,
      ...(await runtime.runPromise(
        Effect.gen(function* () {
          return { chat: yield* ChatService, connection: yield* ConnectionService };
        }),
      )),
    };
  };
  // The older daemon has work before this app connects, which asks at once whether it is idle.
  const direct = await chatOver(LoopbackConnectionLive({ directory }));
  await direct.runtime.runPromise(direct.connection.connect({ profileId: loopbackProfileId }));
  const { conversation } = await direct.runtime.runPromise(
    direct.chat.createChat({
      session,
      requestId: 'create',
      title: 'Held',
      settings: { model: fauxModel },
    }),
  );
  await direct.runtime.runPromise(
    direct.chat.sendChat({ target: conversation.target, requestId: 'send', text: 'Hold on' }),
  );
  let running;
  await until(async () => {
    running = await direct.runtime.runPromise(direct.chat.getChat({ target: conversation.target }));
    return !!running.run;
  });
  const daemon = createLocalDaemon({
    directory,
    command: makeFauxDaemonCommand(directory),
    replaceMs: 50,
  });
  const { runtime, chat, connection } = await chatOver(LocalDaemonConnectionLive(daemon));
  const before = await runtime.runPromise(connection.endpoint({ host: session.host }));
  assert.equal(await readDaemonPid(directory), older, 'the app works with the older daemon');
  assert.equal(daemon.isOutdated(), true);
  // Many checks pass while the run goes on; the older daemon keeps it.
  await delay(500);
  assert(isAlive(older));
  assert.equal(await readDaemonPid(directory), older);
  await runtime.runPromise(chat.stopChat({ stop: running!.run!.stop, requestId: 'stop' }));
  // With no work left, it is stopped and this app's daemon starts on the same store.
  await until(async () => !isAlive(older) && !daemon.isOutdated());
  const current = (await readDaemonPid(directory))!;
  assert.notEqual(current, older);
  assert.equal(
    JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8')).build,
    'development',
  );
  assert.equal(daemon.isRunning(), true);
  const after = await runtime.runPromise(connection.endpoint({ host: session.host }));
  assert.notEqual(after.connectionId, before.connectionId);
  const { conversations } = await runtime.runPromise(chat.listChats({ session }));
  assert.deepEqual(
    conversations.map((listed) => listed.title),
    ['Held'],
  );
  // The current daemon is never replaced.
  await delay(200);
  assert.equal(await readDaemonPid(directory), current);
});

/**
 * Starts a process that notes any SIGTERM in `marker` rather than stopping, its command line
 * ending with `args`, and waits until it handles the signal.
 */
async function spawnStandIn(t: TestContext, marker: string, args: string[]) {
  const standIn = spawn(
    process.execPath,
    [
      ...(args[0]?.endsWith('.mjs')
        ? []
        : [
            '-e',
            `process.on('SIGTERM', () => require('node:fs').writeFileSync(process.env.STAND_IN_MARKER, '')); setInterval(() => {}, 1000); process.stdout.write('ready')`,
          ]),
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], env: { STAND_IN_MARKER: marker } },
  );
  t.after(() => standIn.kill('SIGKILL'));
  await once(standIn.stdout!, 'data');
  standIn.stdout!.destroy();
  return standIn;
}

test('a daemon speaking another protocol is never signalled; local chat waits for it to exit', async (t) => {
  const { userData, directory, command } = await profile(t);
  const marker = join(directory, 'signalled');
  // Stands in for an older app's packaged daemon on this directory; it notes any SIGTERM rather
  // than stopping.
  const entry = join(userData, 'Older.app', 'Contents', 'Resources', 'daemon', 'daemon.mjs');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(
    entry,
    `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => writeFileSync(process.env.STAND_IN_MARKER, ''));
setInterval(() => {}, 1000);
process.stdout.write('ready');
`,
  );
  const older = await spawnStandIn(t, marker, [entry, directory]);
  const endpoint = JSON.stringify({
    port: 9,
    pid: older.pid,
    version: '0.1.0',
    protocol: chatProtocolVersion - 1,
  });
  await writeFile(join(directory, 'endpoint.json'), endpoint, { mode: 0o600 });
  const daemon = createLocalDaemon({ directory, command });
  const busy = {
    code: 'Unavailable',
    message:
      'An older Moonbase daemon is still finishing its work. Local chat starts once it stops.',
  };
  await assert.rejects(daemon.ensure(), busy);
  const session = await readDaemonSession(directory).catch(() => undefined);
  assert.equal(session, undefined, 'nothing was started on its directory');
  await delay(200);
  await assert.rejects(daemon.ensure(), busy);
  assert.equal(older.exitCode, null);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  // Once it exits (idle, with nobody connected), the next request starts this app's daemon.
  older.kill('SIGKILL');
  await once(older, 'exit');
  await daemon.ensure();
  const current = (await readDaemonPid(directory))!;
  assert(isAlive(current));
  assert.equal(daemon.isOutdated(), false);
  await stopDaemon(directory, current);
  // An endpoint naming a process that isn't a daemon on this directory doesn't block starting,
  // and that process is never signalled.
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await once(other, 'spawn');
  await writeFile(
    join(directory, 'endpoint.json'),
    JSON.stringify({
      port: 9,
      pid: other.pid,
      version: '0.1.0',
      protocol: chatProtocolVersion - 1,
    }),
    { mode: 0o600 },
  );
  await createLocalDaemon({ directory, command }).ensure();
  assert.equal(other.exitCode, null);
  assert.notEqual(await readDaemonPid(directory), other.pid);
});

test('an outdated daemon whose process ID now runs something else is never signalled', async (t) => {
  const { directory, command } = await profile(t);
  const marker = join(directory, 'signalled');
  // The outdated daemon crashed and its ID was reused by a process that isn't a daemon, even one
  // whose command line also ends with the data directory.
  const other = await spawnStandIn(t, marker, [directory]);
  await writeFile(
    join(directory, 'endpoint.json'),
    JSON.stringify({
      port: 9,
      pid: other.pid,
      version: '0.1.0',
      protocol: chatProtocolVersion,
      build: 'older-build',
    }),
    { mode: 0o600 },
  );
  const daemon = createLocalDaemon({ directory, command, stopMs: 500 });
  await daemon.ensure();
  assert.equal(daemon.isOutdated(), true);
  await daemon.replace();
  await delay(100);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  assert.equal(other.exitCode, null);
  // This app's daemon runs in its place.
  const current = (await readDaemonPid(directory))!;
  assert.notEqual(current, other.pid);
  assert(isAlive(current));
  assert.equal(daemon.isOutdated(), false);
  assert.equal(daemon.isRunning(), true);
});

test('a start that finds the lock held adopts only a daemon of this directory and protocol', async (t) => {
  const { directory, command } = await profile(t);
  await createLocalDaemon({ directory, command }).ensure();
  const running = (await readDaemonPid(directory))!;
  const file = join(directory, 'endpoint.json'),
    original = await readFile(file, 'utf8');
  try {
    // The started daemon exits because `running` holds the lock; the endpoint it then finds
    // speaks another protocol, or names a reused process ID.
    for (const endpoint of [
      { ...JSON.parse(original), protocol: chatProtocolVersion - 1 },
      { ...JSON.parse(original), pid: process.pid },
    ]) {
      await writeFile(file, JSON.stringify(endpoint), { mode: 0o600 });
      const daemon = createLocalDaemon({ directory, command });
      await assert.rejects(daemon.restart(), {
        code: 'Unavailable',
        message: 'The local chat daemon stopped while starting.',
      });
      assert.equal(daemon.isRunning(), false);
    }
    await writeFile(file, original, { mode: 0o600 });
    const daemon = createLocalDaemon({ directory, command });
    await daemon.restart();
    assert.equal(daemon.isRunning(), true, 'the running daemon of this protocol is adopted');
    assert.equal(await readDaemonPid(directory), running);
  } finally {
    await writeFile(file, original, { mode: 0o600 });
  }
});

test('a daemon that never listens is Unavailable and is not left running', async (t) => {
  const { directory, command } = await profile(t);
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
    { code: 'Unavailable' },
  );
  // The daemon that never listened is not left running.
  const slow = Number(await readFile(marker, 'utf8'));
  await until(() => !isAlive(slow));
});

test('the connection fails as Unavailable when no daemon can be started, answers that for a moment without starting one, and recovers later', async (t) => {
  const { directory, command } = await profile(t);
  let broken = false,
    attempts = 0,
    clock = 0;
  const daemon = createLocalDaemon({ directory, command });
  await daemon.ensure();
  const session = await readDaemonSession(directory);
  const failing = {
    ...daemon,
    ensure: () => {
      attempts++;
      return broken ? Promise.reject(Error('spawn failed')) : daemon.ensure();
    },
  };
  const { runtime, connection } = await connect(t, failing, () => clock);
  await runtime.runPromise(connection.endpoint({ host: session.host }));
  broken = true;
  await stopDaemon(directory);
  const lookup = () => runtime.runPromise(connection.endpoint({ host: session.host }));
  // Lookups waiting together share one recovery; one just after its failure gets that failure.
  attempts = 0;
  for (const result of await Promise.allSettled([lookup(), lookup(), lookup()]))
    assert.equal(result.status === 'rejected' && result.reason.code, 'Unavailable');
  await assert.rejects(lookup(), { code: 'Unavailable' });
  assert.equal(attempts, 1);
  broken = false;
  clock += 2000;
  const endpoint = await lookup();
  assert.equal(attempts, 2);
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
      fileURLToPath(new URL('../../../scripts/seed-mock-chats.ts', import.meta.url)),
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
      fileURLToPath(new URL('../../../scripts/seed-mock-chats.ts', import.meta.url)),
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
