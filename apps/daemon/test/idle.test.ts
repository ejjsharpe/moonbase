import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatClient } from '@moonbase/contracts/chat';
import { runDaemon, type DaemonExit } from '../src/daemon.ts';
import { refuseWhileStopping } from '../src/admission.ts';
import { createIdleMonitor } from '../src/idle.ts';
import {
  bounded,
  createControlledClock,
  createFauxClient,
  findFreePort,
  probeHealth,
  startInProcess,
  temporaryRoot,
  until,
} from './fixture.ts';
import { fauxModelId, fauxProviderId } from './faux.ts';

const minute = 60_000;
const randomNonce = () => randomBytes(32).toString('base64url');

test('the idle monitor waits for every user to end, and treats an unreadable work check as work', async () => {
  const time = createControlledClock();
  let idle = 0,
    work: () => Promise<boolean> = async () => false;
  const monitor = createIdleMonitor({
    idleMs: 5 * minute,
    pollMs: 30_000,
    clock: time.clock,
    hasActiveWork: () => work(),
    onIdle: () => idle++,
  });
  monitor.begin();
  monitor.begin();
  await time.advance(10 * minute);
  monitor.end();
  await time.advance(10 * minute);
  assert.equal(idle, 0, 'one user is still connected');
  monitor.end();
  work = async () => {
    throw Error('store unavailable');
  };
  await time.advance(10 * minute);
  assert.equal(idle, 0, 'work that cannot be ruled out keeps the daemon');
  work = async () => false;
  await time.advance(4 * minute);
  assert.equal(idle, 0, 'idle time counts from the last time work was seen');
  await time.advance(2 * minute);
  assert.equal(idle, 1);
  await time.advance(10 * minute);
  assert.equal(idle, 1, 'idle fires once');
  assert.equal(time.pending, 0);
});

test('a gated client is refused new requests and watches once stopping, and keeps open ones', async () => {
  let stopping = false;
  const forwarded: string[] = [];
  let closed = 0;
  const inner = {
    command: async (operation: string) => {
      forwarded.push(operation);
      return {};
    },
    watch: () => {
      forwarded.push('watch');
      return async () => {
        closed++;
      };
    },
  } as unknown as ChatClient;
  const client = refuseWhileStopping(inner, () => stopping);
  const target = { host: { hostId: 'h', storeId: 's' }, actorId: 'a', conversationId: 'c' };
  const close = client.watch(
    { target } as never,
    () => {},
    () => {},
  );
  await client.command('getChat', { target } as never);
  stopping = true;
  // Anything arriving between stopping and the server closing is refused, not half-admitted.
  await assert.rejects(client.command('sendChat', { target } as never), {
    code: 'Unavailable',
  });
  assert.throws(
    () =>
      client.watch(
        { target } as never,
        () => {},
        () => {},
      ),
    {
      code: 'Unavailable',
    },
  );
  await close();
  assert.deepEqual(forwarded, ['watch', 'getChat']);
  assert.equal(closed, 1);
});

test('a local daemon exits idle only after 5 minutes with no client; a request restarts the wait', async () => {
  const root = await temporaryRoot(),
    time = createControlledClock();
  let daemon: Awaited<ReturnType<typeof startInProcess>> | undefined;
  try {
    daemon = await startInProcess(root, time);
    await time.advance(4 * minute);
    await daemon.client.command('getChatHost', { host: daemon.session.host });
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
    time = createControlledClock();
  let daemon: Awaited<ReturnType<typeof startInProcess>> | undefined;
  try {
    await mkdir(join(root, 'second'));
    daemon = await startInProcess(root, time);
    const origin = daemon.client.origin,
      wrongKey = randomBytes(32).toString('base64url');
    const unauthenticated = [
      () => fetch(origin + '/v1/health'),
      () => probeHealth(origin, wrongKey),
      () =>
        fetch(origin + '/v1/chat/challenge', { headers: { 'X-Moonbase-Nonce': randomNonce() } }),
      () =>
        fetch(origin + '/v1/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Moonbase-Nonce': randomNonce(),
            'X-Moonbase-Challenge': randomNonce(),
            Authorization: 'Moonbase-RPC-HMAC-SHA256 ' + '0'.repeat(64),
          },
          body: JSON.stringify({ operation: 'listChats', input: { session: daemon!.session } }),
        }),
    ];
    for (const request of unauthenticated) {
      await time.advance(minute);
      const response = await request();
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    }
    // A client holding the wrong key is refused its challenge.
    await assert.rejects(
      createFauxClient(daemon.port, wrongKey).command('listChats', { session: daemon.session }),
      { status: 401 },
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
    time = createControlledClock();
  let daemon: Awaited<ReturnType<typeof startInProcess>> | undefined;
  try {
    daemon = await startInProcess(root, time);
    await writeFile(
      join(daemon.directory, 'faux.json'),
      JSON.stringify({ steps: [{ hold: true }] }),
    );
    const { client, session } = daemon;
    const target = (
      await client.command('createChat', {
        session,
        requestId: 'create',
        title: 'Held',
        settings: { model: { provider: fauxProviderId, modelId: fauxModelId } },
      })
    ).conversation.target;
    const watch = await client.watch(target);
    await time.advance(20 * minute);
    assert.equal(daemon.settled, undefined, 'an open watch keeps the daemon');
    await watch.close();
    await client.command('sendChat', { target, requestId: 'held', text: 'Hold this' });
    const running = await until(
      () => client.command('getChat', { target }),
      (snapshot) => !!snapshot.run,
    );
    await time.advance(20 * minute);
    assert.equal(daemon.settled, undefined, 'active work keeps the daemon');
    await client.command('stopChat', { stop: running.run!.stop, requestId: 'stop' });
    await until(
      () => client.command('getChat', { target }),
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
    time = createControlledClock(),
    directory = join(root, 'data'),
    cwd = join(root, 'work'),
    previous = { cwd: process.cwd(), key: process.env.OPENAI_API_KEY, fetch: globalThis.fetch };
  await mkdir(directory, { mode: 0o700 });
  await mkdir(cwd);
  await writeFile(
    join(directory, 'daemon.json'),
    JSON.stringify({
      mode: 'host',
      cwd,
      model: { provider: 'openai', modelId: 'gpt-6-sol' },
      port: await findFreePort(),
    }),
    { mode: 0o600 },
  );
  // The host's fixed providers read their key from the environment; nothing may reach a provider.
  process.env.OPENAI_API_KEY = 'synthetic-no-provider-requests';
  globalThis.fetch = ((url: string | URL | Request, options?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (target.hostname !== '127.0.0.1') throw Error('Provider network is disabled.');
    return previous.fetch(url, options);
  }) as typeof fetch;
  const controller = new AbortController();
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => (ready = resolve));
  let settled: DaemonExit | undefined, running: Promise<unknown> | undefined;
  try {
    running = runDaemon({
      directory,
      signal: controller.signal,
      ready: () => ready(),
      closeClaudeCode: async () => {},
      local: () => assert.fail('host mode composes no local providers'),
      clock: time.clock,
    }).then((exit) => (settled = exit));
    await listening;
    await time.advance(60 * minute);
    assert.equal(settled, undefined);
    assert.equal(time.pending, 0, 'host mode schedules no idle check');
    controller.abort();
    assert.equal(await running, 'stopped');
  } finally {
    controller.abort();
    await running?.catch(() => {});
    process.chdir(previous.cwd);
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.key;
    globalThis.fetch = previous.fetch;
    await rm(root, { recursive: true, force: true });
  }
});
