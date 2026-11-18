import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  Clock,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  References,
  Scope,
} from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { TestClock } from 'effect/testing';
import { ChatService } from '@moonbase/contracts/services';
import { LoopbackConnectionLive, loopbackProfileId } from '@moonbase/daemon-protocol/loopback';
import { DaemonRpcLinkLive, RemoteChatLive } from '@moonbase/daemon-protocol/remote';
import { ConnectionService } from '@moonbase/contracts/services';
import { chatProtocolVersion } from '@moonbase/contracts/host';
import { findDaemonDirectory, readDaemonSession } from '../src/main/daemon/daemon-files.ts';
import {
  LocalDaemon,
  LocalDaemonLive,
  type LocalDaemonOptions,
} from '../src/main/daemon/local-daemon.ts';
import {
  gateDaemonCommand,
  makeFauxDaemonCommand,
  prepareDaemonData,
  readDaemonPid,
  readGateIds,
  stopDaemon,
  writeFauxScript,
} from './fixtures/faux-daemon.mjs';

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const localDaemon = Effect.gen(function* () {
  return yield* LocalDaemon;
});
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

/** A temporary profile with a daemon directory; the daemons it ran are stopped afterwards. */
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

/** The local daemon as main builds it, in a scope the test closes as Quit does (`dispose`). */
async function makeLocal(
  t: TestContext,
  options: Omit<LocalDaemonOptions, 'openUrl'>,
  extra: Layer.Layer<never> = Layer.empty,
) {
  const runtime = ManagedRuntime.make(
    LocalDaemonLive({ openUrl: async () => {}, ...options }).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, extra)),
    ),
  );
  t.after(() => runtime.dispose());
  return { runtime, local: await runtime.runPromise(localDaemon) };
}

test('every caller shares one attempt to reach the daemon; a failed one is the answer for a moment, then tried anew', async (t) => {
  const { userData, directory, command } = await profile(t);
  const gate = join(userData, 'gate');
  await mkdir(gate);
  // Every start waits on the gate; the first fails.
  await writeFile(join(gate, 'fail'), '');
  let now = 0;
  // A clock whose time the test moves; it sleeps as the real one does.
  const clock: Clock.Clock = Object.create(Clock.Clock.defaultValue(), {
    currentTimeMillisUnsafe: { value: () => now },
    currentTimeMillis: { value: Effect.sync(() => now) },
  });
  const { local } = await makeLocal(t, { directory, command: gateDaemonCommand(command, gate) });
  const get = local.get.pipe(Effect.provideService(Clock.Clock, clock));
  for (const result of await Promise.allSettled([run(get), run(local.connect), run(get)]))
    assert.equal(result.status === 'rejected' && result.reason.reason, 'unreachable');
  await assert.rejects(run(get), { reason: 'unreachable' });
  assert.equal((await readGateIds(gate, 'starts')).length, 1);
  assert.equal(await run(local.peek), undefined);
  // Once the failure has been answered long enough, the next caller tries again.
  await rm(join(gate, 'fail'));
  await writeFile(join(gate, 'start'), '');
  now += 2000;
  const [clients, connected] = await Promise.all([run(get), run(local.connect)]);
  assert.equal((await readGateIds(gate, 'starts')).length, 2);
  assert.deepEqual(clients.session, await run(readDaemonSession(directory)));
  assert.deepEqual(connected.endpoint.expected, clients.session.host);
  assert.equal(connected.endpoint.health.protocol, chatProtocolVersion);
  assert.equal(await run(local.peek), clients);
});

test('an attempt every caller gave up on still ends once, and its failure is the next caller’s answer for a moment', async (t) => {
  const { userData, directory, command } = await profile(t);
  const gate = join(userData, 'gate');
  await mkdir(gate);
  // The start is held until the test fails it.
  const { local } = await makeLocal(t, { directory, command: gateDaemonCommand(command, gate) });
  // Only the callers run on the test clock; the daemon's processes keep real time.
  await run(
    Effect.gen(function* () {
      const waiting = yield* Effect.forEach([1, 2, 3], () =>
        Effect.forkChild(Effect.timeoutOption(local.get, '1 second')),
      );
      yield* Effect.promise(() =>
        until(async () => (await readGateIds(gate, 'starts')).length === 1),
      );
      // Every caller stops waiting; the attempt goes on.
      yield* TestClock.adjust('1 second');
      for (const fiber of waiting) assert.equal((yield* Fiber.join(fiber))._tag, 'None');
      // A caller arriving now joins it, and gets its failure once it ends.
      const later = yield* Effect.forkChild(Effect.flip(local.get));
      yield* Effect.promise(() => writeFile(join(gate, 'fail'), ''));
      assert.equal((yield* Fiber.join(later)).reason, 'unreachable');
      // The failure is kept: answered again at once, with no new start.
      assert.equal((yield* Effect.flip(local.get)).reason, 'unreachable');
      assert.equal((yield* Effect.promise(() => readGateIds(gate, 'starts'))).length, 1);
      // Once it has been answered long enough, the next caller tries again.
      yield* TestClock.adjust('2 seconds');
      yield* Effect.flip(local.get);
      assert.equal((yield* Effect.promise(() => readGateIds(gate, 'starts'))).length, 2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test('a crashed or unanswering daemon is replaced on the next request, in a new connection generation', async (t) => {
  const { directory, command } = await profile(t);
  const { local } = await makeLocal(t, { directory, command });
  const before = await run(local.connect);
  const pid = (await readDaemonPid(directory))!;
  process.kill(pid, 'SIGKILL');
  await until(async () => !(await run(local.isRunning)));
  // Its endpoint is left behind, naming a process that is gone.
  assert.equal(await readDaemonPid(directory), pid);
  // A chat request finds it gone before it is sent, and starts a daemon on the same store.
  const { conversations } = await run(before.chat.listChats({ session: before.session }));
  assert.deepEqual(conversations, []);
  const after = await run(local.connect);
  assert.notEqual(after.endpoint.connectionId, before.endpoint.connectionId);
  assert.notEqual(await readDaemonPid(directory), pid);
  assert.deepEqual(await run(local.session), before.session, 'the same store restarts');
  // An endpoint naming a reused process ID: this test process, alive but serving nothing.
  await stopDaemon(directory, (await readDaemonPid(directory))!);
  await writeFile(
    join(directory, 'endpoint.json'),
    JSON.stringify({ port: 9, pid: process.pid, version: '0.1.0', protocol: chatProtocolVersion }),
    { mode: 0o600 },
  );
  const replaced = await run(local.connect);
  assert.deepEqual(replaced.endpoint.expected, before.session.host);
  const restarted = (await readDaemonPid(directory))!;
  assert.notEqual(restarted, process.pid);
  assert(isAlive(restarted));
});

const fauxModel = { provider: 'moonbase-faux', modelId: 'faux-model' };

test('a daemon of another build is used while it has work, then replaced in a new generation', async (t) => {
  const { directory } = await profile(t);
  // The faux model holds its first run until it is stopped.
  await writeFauxScript(directory, { idleMs: 5000, pollMs: 500, steps: [{ hold: true }] });
  // Another app version's daemon, of this protocol, already has work before this app connects.
  const older = await makeLocal(t, {
    directory,
    command: makeFauxDaemonCommand(directory, undefined, 'older-build'),
  });
  const olderPid = await run(older.local.connect).then(() => readDaemonPid(directory));
  t.after(() => stopDaemon(directory, olderPid));
  const session = await run(readDaemonSession(directory));
  const direct = ManagedRuntime.make(
    RemoteChatLive.pipe(
      Layer.provide(DaemonRpcLinkLive({ host: session.host })),
      Layer.provideMerge(LoopbackConnectionLive({ directory })),
    ),
  );
  t.after(() => direct.dispose());
  const { chat: directChat, connection } = await direct.runPromise(
    Effect.gen(function* () {
      return { chat: yield* ChatService, connection: yield* ConnectionService };
    }),
  );
  await direct.runPromise(connection.connect({ profileId: loopbackProfileId }));
  await older.runtime.dispose();
  const { conversation } = await direct.runPromise(
    directChat.createChat({
      session,
      requestId: 'create',
      title: 'Held',
      settings: { model: fauxModel },
    }),
  );
  await direct.runPromise(
    directChat.sendChat({ target: conversation.target, requestId: 'send', text: 'Hold on' }),
  );
  let running;
  await until(async () => {
    running = await direct.runPromise(directChat.getChat({ target: conversation.target }));
    return !!running.run;
  });
  // This app counts the checks it makes, each of which asks the older daemon for its work.
  let checks = 0;
  const counting = Logger.layer([
    Logger.make(({ message }) => {
      if (String(message).includes('has work')) checks++;
    }),
  ]);
  const { local } = await makeLocal(
    t,
    { directory, command: makeFauxDaemonCommand(directory), replaceMs: 50 },
    Layer.mergeAll(counting, Layer.succeed(References.MinimumLogLevel, 'Debug')),
  );
  const before = await run(local.connect);
  assert.equal(await readDaemonPid(directory), olderPid, 'the app works with the older daemon');
  // Several checks pass while the run goes on; the older daemon keeps it.
  await until(() => checks >= 4);
  assert(isAlive(olderPid!));
  assert.equal(await readDaemonPid(directory), olderPid);
  await run(before.chat.stopChat({ stop: running!.run!.stop, requestId: 'stop' }));
  // With no work left, it is stopped and this app's daemon starts on the same store.
  await until(() => !isAlive(olderPid!));
  await until(async () => (await readDaemonPid(directory)) !== undefined);
  const current = (await readDaemonPid(directory))!;
  assert.equal(
    JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8')).build,
    'development',
  );
  const after = await run(local.connect);
  assert.notEqual(after.endpoint.connectionId, before.endpoint.connectionId);
  const { conversations } = await run(after.chat.listChats({ session }));
  assert.deepEqual(
    conversations.map((listed) => listed.title),
    ['Held'],
  );
  assert.equal(await readDaemonPid(directory), current);
});

test('Quit releases what was built after the daemon while its clients, bound later, still answer; then nothing reaches them', async (t) => {
  const { directory, command } = await profile(t);
  const services = Scope.makeUnsafe('sequential');
  const steps: string[] = [];
  const local = await run(
    Effect.map(
      Layer.buildWithScope(
        LocalDaemonLive({ directory, command, openUrl: async () => {} }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        services,
      ),
      (context) => Context.get(context, LocalDaemon),
    ),
  );
  // A document built after the daemon, holding work it releases over the daemon's clients, which
  // are only bound by the first request after it.
  await run(
    Scope.addFinalizer(
      services,
      Effect.flatMap(local.peek, (clients) =>
        clients
          ? clients.chat
              .listChats({ session: clients.session })
              .pipe(
                Effect.andThen(Effect.sync(() => void steps.push('released over open clients'))),
              )
          : Effect.void,
      ).pipe(Effect.orDie),
    ),
  );
  await run(local.get);
  const closed = await run(Effect.exit(Scope.close(services, Exit.void)));
  assert(Exit.isSuccess(closed), 'Quit releases everything without a cleanup failure');
  assert.deepEqual(steps, ['released over open clients']);
  assert.equal(await run(local.peek), undefined);
  await assert.rejects(run(local.get), { reason: 'quitting' });
  await assert.rejects(run(local.connect), { reason: 'quitting' });
  // The daemon outlives the app.
  assert(isAlive((await readDaemonPid(directory))!));
});

test('Quit during a start interrupts it and stops the starting daemon’s whole process group', async (t) => {
  const { userData, directory, command } = await profile(t);
  const gate = join(userData, 'gate');
  await mkdir(gate);
  // The start is held, with a member of its process group that outlives the leader on its own.
  await writeFile(join(gate, 'group'), '');
  const { runtime, local } = await makeLocal(t, {
    directory,
    command: gateDaemonCommand(command, gate),
  });
  const waiting = run(Effect.flip(local.get));
  await until(async () => (await readGateIds(gate, 'members')).length === 1);
  const [leader] = await readGateIds(gate, 'starts'),
    [member] = await readGateIds(gate, 'members');
  await runtime.dispose();
  assert.equal((await waiting).reason, 'quitting');
  await until(() => !isAlive(leader!) && !isAlive(member!));
  await assert.rejects(run(local.get), { reason: 'quitting' });
});

test('the mock profile seeds the daemon store, and its daemon starts with the seeded chats', async (t) => {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-mock-profile-')));
  const directory = findDaemonDirectory(userData);
  t.after(async () => {
    await stopDaemon(directory);
    await rm(userData, { recursive: true, force: true });
  });
  const seed = () =>
    spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(new URL('../scripts/seed-mock-chats.ts', import.meta.url)),
        userData,
      ],
      { stdio: 'ignore' },
    );
  assert.equal((await once(seed(), 'exit'))[0], 0);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of ['identity.json', 'chat.sqlite'])
    assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600, file);
  // Seeding refuses a profile whose daemon directory exists, so it never replaces chats.
  assert.notEqual((await once(seed(), 'exit'))[0], 0);
  const session = await run(readDaemonSession(directory));
  const { local } = await makeLocal(t, { directory, command: makeFauxDaemonCommand(directory) });
  const clients = await run(local.get);
  assert.deepEqual(clients.session, session, 'the daemon keeps the identity');
  const { conversations } = await run(clients.chat.listChats({ session }));
  assert.deepEqual(conversations.map((conversation) => conversation.title).sort(), [
    'Move the transcript to Legend List',
    'Plain question',
    'Summarise this repository',
  ]);
});
