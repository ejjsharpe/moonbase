import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Duration, Effect, Exit, Fiber, Scope, SubscriptionRef } from 'effect';
import { TestClock } from 'effect/testing';
import { makeDaemonStop } from '../src/daemon-stop.ts';
import { waitForIdle } from '../src/idle.ts';
import { createFauxProviders } from './faux-provider.ts';
import {
  bounded,
  createFauxClient,
  createTestClock,
  findFreePort,
  probeHealth,
  runInProcess,
  startInProcess,
  temporaryRoot,
  until,
} from './daemon-fixture.ts';
import { fauxModelId, fauxProviderId } from './faux-provider.ts';

const minute = 60_000;

test('the idle wait waits for every use to end, treats an unreadable work check as work, and stops once', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const stop = yield* makeDaemonStop;
      let work: Effect.Effect<boolean, Error> = Effect.succeed(false);
      const stopping = Effect.map(SubscriptionRef.get(stop.use), (use) => use.stopping);
      const idle = yield* Effect.forkChild(
        waitForIdle(
          stop.use,
          {
            idle: Duration.minutes(5),
            poll: Duration.seconds(30),
            hasActiveWork: Effect.suspend(() => work),
          },
          stop.request('idle', { unused: true }),
        ),
      );
      const [first, second] = [Scope.makeUnsafe(), Scope.makeUnsafe()];
      yield* Scope.provide(stop.admit, first);
      yield* Scope.provide(stop.admit, second);
      yield* TestClock.adjust(10 * minute);
      yield* Scope.close(first, Exit.void);
      yield* TestClock.adjust(10 * minute);
      assert.equal(yield* stopping, undefined, 'one use is still held');
      yield* Scope.close(second, Exit.void);
      work = Effect.fail(Error('store unavailable'));
      yield* TestClock.adjust(10 * minute);
      assert.equal(yield* stopping, undefined, 'work that cannot be ruled out keeps the daemon');
      work = Effect.succeed(false);
      yield* TestClock.adjust(4 * minute);
      assert.equal(yield* stopping, undefined, 'idle time counts from the last time work was seen');
      yield* TestClock.adjust(2 * minute);
      assert.equal(yield* stopping, 'idle');
      assert.ok(idle.pollUnsafe(), 'the wait ends once the daemon stops');
      // Once stopping, a new use is refused, and a stop asked for later changes nothing.
      const refused = yield* Effect.exit(Effect.scoped(stop.admit));
      assert.ok(Exit.isFailure(refused));
      assert.equal(yield* stop.request('stopped'), false);
      assert.equal(yield* stopping, 'idle');
      yield* Fiber.join(idle);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

test('a local daemon exits idle only after 5 minutes with no client; a request restarts the wait', async () => {
  const root = await temporaryRoot(),
    time = createTestClock();
  let daemon: Awaited<ReturnType<typeof startInProcess>> | undefined;
  try {
    daemon = await startInProcess(root, time);
    await time.advance(4 * minute);
    const { host } = daemon.session;
    await daemon.client.chat((chat) => chat.getChatHost({ host }));
    await time.advance(4 * minute);
    assert.equal(daemon.settled, undefined, 'the request restarted the wait');
    await stat(join(daemon.directory, 'endpoint.json'));
    await time.advance(minute + 30_000);
    assert.equal(await daemon.running, 'idle');
    await assert.rejects(stat(join(daemon.directory, 'endpoint.json')), { code: 'ENOENT' });
  } finally {
    await daemon?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('unauthenticated requests never delay a local daemon going idle; an authenticated probe does', async () => {
  const root = await temporaryRoot(),
    time = createTestClock();
  let daemon: Awaited<ReturnType<typeof startInProcess>> | undefined;
  try {
    await mkdir(join(root, 'second'));
    daemon = await startInProcess(root, time);
    const origin = daemon.client.origin,
      wrongKey = randomBytes(32).toString('base64url');
    const unauthenticated = [
      () => fetch(origin + '/v1/health'),
      () => probeHealth(origin, wrongKey),
    ];
    // Each probe comes two minutes after the last: had either counted as use, the daemon would
    // still be up a minute and a half after the last one.
    for (const request of unauthenticated) {
      await time.advance(2 * minute);
      const response = await request();
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    }
    // A client holding the wrong key is refused at signed health, before it can upgrade.
    const { session } = daemon;
    await assert.rejects(
      createFauxClient(daemon.port, wrongKey, session.host).chat((chat) =>
        chat.listChats({ session }),
      ),
      { _tag: 'HostVerificationError', reason: 'rejected' },
    );
    await time.advance(minute + 30_000);
    assert.equal(
      await bounded(daemon.running, 5000).catch(() => daemon!.settled),
      'idle',
      'unauthenticated requests delayed idle exit',
    );

    daemon = await startInProcess(join(root, 'second'), time);
    const token = (await readFile(join(daemon.directory, 'token'), 'utf8')).trim();
    await time.advance(4 * minute);
    const probe = await probeHealth(daemon.client.origin, token);
    assert.equal(probe.status, 200);
    await probe.arrayBuffer();
    await time.advance(4 * minute);
    assert.equal(daemon.settled, undefined, 'the authenticated probe restarted the wait');
    await time.advance(minute + 30_000);
    assert.equal(await daemon.running, 'idle');
  } finally {
    await daemon?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('an open watch and active work keep a local daemon running; it idles once both end', async () => {
  const root = await temporaryRoot(),
    time = createTestClock();
  let daemon: Awaited<ReturnType<typeof startInProcess>> | undefined;
  try {
    daemon = await startInProcess(root, time);
    await writeFile(
      join(daemon.directory, 'faux.json'),
      JSON.stringify({ steps: [{ hold: true }] }),
    );
    const { client, session } = daemon;
    const target = (
      await client.chat((chat) =>
        chat.createChat({
          session,
          requestId: 'create',
          title: 'Held',
          settings: { model: { provider: fauxProviderId, modelId: fauxModelId } },
        }),
      )
    ).conversation.target;
    const watch = await client.watch(target);
    await time.advance(20 * minute);
    assert.equal(daemon.settled, undefined, 'an open watch keeps the daemon');
    await watch.close();
    await client.chat((chat) => chat.sendChat({ target, requestId: 'held', text: 'Hold this' }));
    const running = await until(
      () => client.chat((chat) => chat.getChat({ target })),
      (snapshot) => !!snapshot.run,
    );
    await time.advance(20 * minute);
    assert.equal(daemon.settled, undefined, 'active work keeps the daemon');
    await client.chat((chat) => chat.stopChat({ stop: running.run!.stop, requestId: 'stop' }));
    await until(
      () => client.chat((chat) => chat.getChat({ target })),
      (snapshot) => !snapshot.run,
    );
    await time.advance(5 * minute + 30_000);
    assert.equal(await daemon.running, 'idle');
  } finally {
    await daemon?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('a host-mode daemon never idles out and stops on its signal', async () => {
  const root = await temporaryRoot(),
    time = createTestClock(),
    directory = join(root, 'data'),
    work = join(root, 'work');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(work);
  await writeFile(
    join(directory, 'daemon.json'),
    JSON.stringify({
      mode: 'host',
      port: await findFreePort(),
      approvedRoots: [work],
      credentialKey: { source: 'file', path: join(root, 'credential.key') },
    }),
    { mode: 0o600 },
  );
  const listening = Promise.withResolvers<void>();
  let settled: unknown;
  const daemon = runInProcess(directory, {
    ready: () => listening.resolve(),
    providers: () => createFauxProviders(directory),
    idleClock: time.clock,
  });
  void daemon.exit.then((exit) => (settled = exit));
  try {
    await listening.promise;
    await time.advance(60 * minute);
    assert.equal(settled, undefined, 'host mode never idles out');
    assert.equal(await daemon.stop(), 'stopped');
  } finally {
    await daemon.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
