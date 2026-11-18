import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Effect } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import { findDaemonDirectory, readDaemonSession } from '../src/main/daemon/daemon-files.ts';
import { makeDaemonProcess, type DaemonProcessOptions } from '../src/main/daemon/daemon-process.ts';
import {
  makeFauxDaemonCommand,
  prepareDaemonData,
  readDaemonPid,
  stopDaemon,
  writeFauxScript,
} from './fixtures/faux-daemon.mjs';

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
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
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-daemon-process-')));
  const directory = findDaemonDirectory(userData);
  await prepareDaemonData(userData);
  const command = makeFauxDaemonCommand(directory);
  t.after(async () => {
    await stopDaemon(directory);
    await rm(userData, { recursive: true, force: true });
  });
  return { userData, directory, command };
}
/** The daemon's process steps as the local daemon runs them, with the platform main provides. */
const makeProcess = (options: DaemonProcessOptions) =>
  run(makeDaemonProcess(options).pipe(Effect.provide(NodeServices.layer)));

test('with no daemon running one is started detached; another app finds and reuses it', async (t) => {
  const { directory, command } = await profile(t);
  const first = await makeProcess({ directory, command });
  assert.equal(await run(first.isRunning), false);
  await run(first.find);
  const pid = (await readDaemonPid(directory))!;
  assert(pid && isAlive(pid));
  assert.equal(await run(first.isRunning), true);
  const session = await run(readDaemonSession(directory));
  // A second launch of the app finds the same daemon rather than starting one.
  const second = await makeProcess({ directory, command });
  await run(second.find);
  assert.equal(await readDaemonPid(directory), pid);
  assert.equal(await run(second.isRunning), true);
  assert.equal(await run(second.isOutdated), false, 'a daemon of the same build is current');
  assert.deepEqual(await run(readDaemonSession(directory)), session);
});

/**
 * Starts a process that notes any SIGTERM in `marker` rather than stopping, its command line
 * ending with `args`, and waits until it handles the signal. It answers SIGUSR2 by writing
 * `<marker>.checked`, which `assertNotSignalled` uses as a sentinel.
 */
async function spawnStandIn(t: TestContext, marker: string, args: string[]) {
  const standIn = spawn(
    process.execPath,
    [
      ...(args[0]?.endsWith('.mjs')
        ? []
        : [
            '-e',
            `process.on('SIGTERM', () => require('node:fs').writeFileSync(process.env.STAND_IN_MARKER, '')); process.on('SIGUSR2', () => require('node:fs').writeFileSync(process.env.STAND_IN_MARKER + '.checked', '')); setInterval(() => {}, 1000); process.stdout.write('ready')`,
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

/**
 * Asserts the stand-in noted no SIGTERM. Its handlers run in the order the signals arrived, so
 * once it has answered a SIGUSR2 sent now, a SIGTERM sent before would already have been noted.
 */
async function assertNotSignalled(standIn: ReturnType<typeof spawn>, marker: string) {
  const checked = marker + '.checked';
  await rm(checked, { force: true });
  standIn.kill('SIGUSR2');
  await until(() =>
    stat(checked).then(
      () => true,
      () => false,
    ),
  );
  await assert.rejects(stat(marker), { code: 'ENOENT' });
}

test('a daemon speaking another protocol is never signalled; finding waits for it to exit', async (t) => {
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
process.on('SIGUSR2', () => writeFileSync(process.env.STAND_IN_MARKER + '.checked', ''));
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
  const daemon = await makeProcess({ directory, command });
  const busy = { _tag: 'LocalDaemonError', reason: 'older-daemon' };
  await assert.rejects(run(daemon.find), busy);
  await assert.rejects(run(readDaemonSession(directory)), 'nothing was started on its directory');
  await assert.rejects(run(daemon.find), busy);
  assert.equal(older.exitCode, null);
  await assertNotSignalled(older, marker);
  // Once it exits (idle, with nobody connected), the next attempt starts this app's daemon.
  older.kill('SIGKILL');
  await once(older, 'exit');
  await run(daemon.find);
  const current = (await readDaemonPid(directory))!;
  assert(isAlive(current));
  assert.equal(await run(daemon.isOutdated), false);
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
  await run((await makeProcess({ directory, command })).find);
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
  const daemon = await makeProcess({ directory, command, stopMs: 500 });
  await run(daemon.find);
  assert.equal(await run(daemon.isOutdated), true);
  await run(daemon.replace);
  await assertNotSignalled(other, marker);
  assert.equal(other.exitCode, null);
  // This app's daemon runs in its place.
  const current = (await readDaemonPid(directory))!;
  assert.notEqual(current, other.pid);
  assert(isAlive(current));
  assert.equal(await run(daemon.isOutdated), false);
  assert.equal(await run(daemon.isRunning), true);
});

test('a start that finds the lock held adopts only a daemon of this directory and protocol', async (t) => {
  const { directory, command } = await profile(t);
  // Three starts follow; the first daemon must outlive them all, so it may not idle out meanwhile.
  await writeFauxScript(directory, { idleMs: 60_000, pollMs: 500 });
  await run((await makeProcess({ directory, command })).find);
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
      const daemon = await makeProcess({ directory, command });
      await assert.rejects(run(daemon.start), { reason: 'stopped-while-starting' });
      assert.equal(await run(daemon.isRunning), false);
    }
    await writeFile(file, original, { mode: 0o600 });
    const daemon = await makeProcess({ directory, command });
    await run(daemon.start);
    assert.equal(
      await run(daemon.isRunning),
      true,
      'the running daemon of this protocol is adopted',
    );
    assert.equal(await readDaemonPid(directory), running);
  } finally {
    await writeFile(file, original, { mode: 0o600 });
  }
});

test('a daemon that never listens fails its start, and its whole process group is stopped', async (t) => {
  const { directory, command } = await profile(t);
  const leader = join(directory, 'leader.pid'),
    member = join(directory, 'member.pid');
  const daemon = await makeProcess({
    directory,
    command: {
      ...command,
      command: '/bin/sh',
      // A member of its group outlives the leader unless the group is stopped.
      args: ['-c', `echo $$ > ${leader}; sleep 30 & echo $! > ${member}; wait`],
    },
    startMs: 300,
  });
  await assert.rejects(run(daemon.find), { reason: 'start-timeout' });
  const pids = [Number(await readFile(leader, 'utf8')), Number(await readFile(member, 'utf8'))];
  // Nothing of its group is left running; the member is gone once launchd reaps it.
  await until(() => pids.every((pid) => !isAlive(pid)));
});
