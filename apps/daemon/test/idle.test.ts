import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runDaemon, type DaemonExit } from '../src/daemon.ts';
import { createIdleMonitor, type IdleClock } from '../src/idle.ts';
import {
  createFauxClient,
  delay,
  findFreePort,
  readJson,
  temporaryRoot,
  until,
} from './fixture.ts';
import { createFauxProviders, fauxModelId, fauxProviderId } from './faux.ts';

const minute = 60_000;

/** A clock whose time moves only when the test advances it; due timers then fire in order. */
function createControlledClock() {
  let now = 0,
    next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: IdleClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      timers.set(++next, { at: now + ms, callback });
      return next;
    },
    clearTimeout: (handle) => timers.delete(handle as number),
  };
  return {
    clock,
    get pending() {
      return timers.size;
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        // The check reads active work from the real store before it decides.
        await delay(40);
      }
      now = end;
      await delay(40);
    },
  };
}

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

async function startInProcess(root: string, time: ReturnType<typeof createControlledClock>) {
  const directory = join(root, 'data'),
    controller = new AbortController();
  let ready!: (port: number) => void;
  const listening = new Promise<number>((resolve) => (ready = resolve));
  let settled: DaemonExit | Error | undefined;
  const running = runDaemon({
    directory,
    signal: controller.signal,
    ready: (line) => ready(JSON.parse(line).port),
    closeClaudeCode: async () => {},
    local: () => createFauxProviders(directory),
    clock: time.clock,
  }).then(
    (exit) => (settled = exit),
    (error: Error) => (settled = error),
  );
  const port = await listening;
  const token = (await readFile(join(directory, 'token'), 'utf8')).trim(),
    identity = await readJson(join(directory, 'identity.json'));
  return {
    directory,
    client: createFauxClient(port, token),
    session: { host: identity.host, actorId: identity.actorId },
    get settled() {
      return settled;
    },
    running,
    stop: async () => {
      controller.abort();
      return running;
    },
  };
}

test('a local daemon exits idle only after 5 minutes with no client; a request restarts the wait', async () => {
  const root = await temporaryRoot(),
    time = createControlledClock();
  try {
    const daemon = await startInProcess(root, time);
    await time.advance(4 * minute);
    await daemon.client.command('getChatHost', { host: daemon.session.host });
    await time.advance(4 * minute);
    assert.equal(daemon.settled, undefined, 'the request restarted the wait');
    await stat(join(daemon.directory, 'endpoint.json'));
    await time.advance(minute + 30_000);
    assert.equal(await daemon.running, 'idle');
    await assert.rejects(stat(join(daemon.directory, 'endpoint.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an open watch and active work keep a local daemon running; it idles once both end', async () => {
  const root = await temporaryRoot(),
    time = createControlledClock();
  try {
    const daemon = await startInProcess(root, time);
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
  let settled: DaemonExit | undefined;
  try {
    const running = runDaemon({
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
    process.chdir(previous.cwd);
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.key;
    globalThis.fetch = previous.fetch;
    await rm(root, { recursive: true, force: true });
  }
});
