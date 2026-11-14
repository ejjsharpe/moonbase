import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer, type AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Effect, ManagedRuntime, Queue } from 'effect';
import { ApplicationError, type ObservationClose } from '@moonbase/contracts/workspace';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import { chatHostVersion, chatProtocolVersion } from '@moonbase/contracts/host';
import { createHostHealthReply } from '@moonbase/ssh/host-health';
import { ConnectionService } from '@moonbase/contracts/services';
import { makeConnectionClient } from '@moonbase/application/runtime/clients';
import { SshLive, type SshConfiguration, type SshOptions } from '@moonbase/ssh';
const failure = (code: ApplicationError['code']) => (e: unknown) =>
  ApplicationError.is(e) && e.code === code;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function until(
  check: () => boolean | Promise<boolean>,
  message = 'condition did not settle',
  limit = 4000,
) {
  const end = Date.now() + limit;
  while (!(await check())) {
    assert(Date.now() < end, message);
    await tick();
  }
}
function rows(path: string): {
  event: string;
  pid: number;
  parent: number;
  args: string[];
  port: number;
  keyInEnvironment: boolean;
}[] {
  try {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function free(port: number) {
  const server = tcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function fixture(mode = 'normal', healthMode = 'valid', options: SshOptions = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-ssh-'))),
    key = randomBytes(32).toString('base64url'),
    log = join(base, 'children.jsonl'),
    control = join(base, 'control.json');
  const expected = { hostId: 'explicit-host', storeId: 'explicit-store' },
    requests: { url: string; headers: string }[] = [];
  const health = httpServer((req, res) => {
    requests.push({ url: req.url!, headers: JSON.stringify(req.headers) });
    if (healthMode === 'stall') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      return;
    }
    try {
      const body = createHostHealthReply({
        token: healthMode === 'auth' ? 'different-synthetic-host-key' : key,
        nonce: req.headers['x-moonbase-nonce'] as string,
        authorization: req.headers.authorization,
        health: {
          hostId: healthMode === 'identity' ? 'other-host' : expected.hostId,
          storeId: healthMode === 'store' ? 'other-store' : expected.storeId,
          protocol: chatProtocolVersion,
          version: chatHostVersion,
          capabilities: ['chat-v0'],
        },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthMode === 'version' ? { ...body, version: '99.0.0' } : body));
    } catch {
      res.writeHead(401);
      res.end();
    }
  });
  await new Promise<void>((resolve) => health.listen(0, '127.0.0.1', resolve));
  const remotePort = (health.address() as AddressInfo).port;
  const executable = join(base, 'SSH resources with spaces');
  writeFileSync(
    executable,
    '#!' +
      process.execPath +
      '\nprocess.env.MOONBASE_SSH_TEST_CONTROL=' +
      JSON.stringify(control) +
      ';\n' +
      readFileSync(fileURLToPath(new URL('./faux-ssh.mjs', import.meta.url)), 'utf8'),
  );
  chmodSync(executable, 0o700);
  const setMode = (value: string, diagnostic?: string, sshConfig?: string) =>
    writeFileSync(control, JSON.stringify({ mode: value, diagnostic, sshConfig, log, key }));
  setMode(mode);
  const profile = {
    id: 'configured',
    label: 'Operator host',
    destination: 'configured-alias',
    remotePort,
    expected,
  };
  const config = { profile, token: key, sshExecutable: executable };
  const start = (configuration: SshConfiguration = config) => {
    const runtime = ManagedRuntime.make(SshLive(configuration, options));
    return { runtime, client: makeConnectionClient(runtime) };
  };
  const current = start();
  const spawned = () => rows(log).filter((r) => r.event === 'preflight' || r.event === 'forward');
  const forwards = () => spawned().filter((r) => r.event === 'forward');
  const helpers = () => rows(log).filter((r) => r.event === 'helper');
  const ports = () => forwards().map((r) => Number(r.args[r.args.indexOf('-L') + 1].split(':')[1]));
  const endpoint = () =>
    current.runtime.runPromise(
      Effect.flatMap(ConnectionService, (service) => service.endpoint({ host: expected })),
    );
  return {
    ...current,
    base,
    key,
    log,
    profile,
    config,
    requests,
    start,
    spawned,
    forwards,
    helpers,
    ports,
    setMode,
    endpoint,
    async close() {
      await current.runtime.dispose();
      health.closeAllConnections();
      await new Promise<void>((resolve) => health.close(() => resolve()));
      for (const child of [...spawned(), ...helpers()])
        assert(!alive(child.pid), 'owned child leaked: ' + child.pid);
      for (const port of [...ports(), ...helpers().map((row) => row.port)])
        if (port) await free(port);
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('independent public client connects once, verifies health, protects privileged fields and tears down only its child', async () => {
  const f = await fixture();
  const prior = process.env.MOONBASE_SSH_SYNTHETIC_KEY;
  process.env.MOONBASE_SSH_SYNTHETIC_KEY = f.key;
  try {
    const initial = await f.client.command('getConnection', {});
    assert.equal(initial.state, 'disconnected');
    assert.equal(f.spawned().length, 0);
    await assert.rejects(f.endpoint(), failure('Unavailable'));
    assert.equal(f.spawned().length, 0);
    const second = makeConnectionClient(f.runtime);
    const [one, two] = await Promise.all([
      f.client.command('connect', { profileId: 'configured' }),
      second.command('connect', { profileId: 'configured' }),
    ]);
    assert.equal(one.state, 'connected');
    assert.deepEqual(two, one);
    assert.equal(f.forwards().length, 1);
    assert.equal(f.spawned().length, 2);
    one.profile.expected.storeId = 'mutated-public-copy';
    if (one.state === 'connected') one.health.hostId = 'mutated-public-copy';
    assert.deepEqual((await f.client.command('getConnection', {})).profile, f.profile);
    const endpoint = await f.endpoint();
    assert.equal(endpoint.token, f.key);
    assert.equal(endpoint.connectionId, one.connectionId);
    assert.deepEqual(endpoint.health.hostId, f.profile.expected.hostId);
    assert(!JSON.stringify(one).includes(f.key));
    assert(!JSON.stringify(one).includes(endpoint.origin));
    assert(!f.spawned().some((row) => row.keyInEnvironment));
    assert(!JSON.stringify(f.spawned()).includes(f.key));
    assert(f.requests.length);
    assert(f.requests.every((req) => req.url === '/v1/health' && !req.headers.includes(f.key)));
    const args = f.forwards()[0].args;
    assert.deepEqual(args.slice(-2), ['--', f.profile.destination]);
    for (const value of [
      'ControlMaster=no',
      'ControlPath=none',
      'ControlPersist=no',
      'ForkAfterAuthentication=no',
      'BatchMode=yes',
      'ExitOnForwardFailure=yes',
      'GatewayPorts=no',
      'PermitLocalCommand=no',
      'RemoteCommand=none',
    ])
      assert(args.includes(value));
    assert(!args.some((value: string) => /StrictHostKeyChecking|KnownHostsFile/.test(value)));
    assert.match(
      args[args.indexOf('-L') + 1],
      new RegExp('^127\\.0\\.0\\.1:\\d+:127\\.0\\.0\\.1:' + f.profile.remotePort + '$'),
    );
    await f.client.command('disconnect', { connectionId: one.connectionId! });
    assert.equal((await f.client.command('getConnection', {})).state, 'disconnected');
    await f.client.command('disconnect', { connectionId: one.connectionId! });
  } finally {
    if (prior === undefined) delete process.env.MOONBASE_SSH_SYNTHETIC_KEY;
    else process.env.MOONBASE_SSH_SYNTHETIC_KEY = prior;
    await f.close();
  }
});

test('slow startup leaves status usable; cancellation releases a shared attempt and unrelated observers remain alive', async () => {
  const f = await fixture('slow');
  const abort = new AbortController();
  const pending = f.client.command(
      'connect',
      { profileId: 'configured' },
      { signal: abort.signal },
    ),
    rejected = assert.rejects(pending, failure('Cancelled'));
  try {
    await until(() => f.forwards().length === 1);
    const snapshot = await f.client.command('getConnection', {});
    assert.equal(snapshot.state, 'connecting');
    const second = f.client.command('connect', { profileId: 'configured' }),
      secondRejected = assert.rejects(second, failure('Cancelled'));
    await assert.rejects(
      f.client.command('disconnect', { connectionId: 'stale' }),
      failure('Conflict'),
    );
    abort.abort();
    await rejected;
    await secondRejected;
    assert.equal((await f.client.command('getConnection', {})).state, 'disconnected');
    assert.equal(f.forwards().length, 1);
    f.setMode('normal');
    const connected = await f.client.command('connect', { profileId: 'configured' });
    assert.equal(connected.state, 'connected');
    assert.notEqual(connected.connectionId, snapshot.connectionId);
    await assert.rejects(
      f.client.command('disconnect', { connectionId: snapshot.connectionId! }),
      failure('Conflict'),
    );
    assert.equal(
      (await f.client.command('getConnection', {})).connectionId,
      connected.connectionId,
    );
  } finally {
    abort.abort();
    await f.close();
  }
});

test('observation unsubscribe is not disconnect; generation exit fails visibly and reconnect never sends', async () => {
  const f = await fixture();
  const events: ConnectionSnapshot[] = [],
    errors: ApplicationError[] = [];
  let stop = f.client.watch(
    (event) => events.push(event),
    (e) => errors.push(e),
  );
  try {
    await until(() => events.length > 0);
    assert.equal(events[0].state, 'disconnected');
    const first = await f.client.command('connect', { profileId: 'configured' });
    await until(() => events.some((e) => e.state === 'connected'));
    await stop();
    const observed = events.length;
    assert.equal((await f.client.command('getConnection', {})).state, 'connected');
    process.kill(f.forwards()[0].pid, 'SIGTERM');
    await until(async () => (await f.client.command('getConnection', {})).state === 'failed');
    await assert.rejects(f.endpoint(), failure('Unavailable'));
    assert.equal(events.length, observed);
    assert.equal(errors.length, 0);
    stop = f.client.watch(
      (event) => events.push(event),
      (e) => errors.push(e),
    );
    const second = await f.client.command('connect', { profileId: 'configured' });
    assert.notEqual(second.connectionId, first.connectionId);
    await assert.rejects(
      f.client.command('disconnect', { connectionId: first.connectionId! }),
      failure('Conflict'),
    );
    assert.equal((await f.client.command('getConnection', {})).state, 'connected');
    assert(f.requests.every((r) => r.url === '/v1/health'));
  } finally {
    await stop();
    await f.close();
  }
});

for (const [mode, code] of [
  ['auth', 'Unauthorized'],
  ['identity', 'Incompatible'],
  ['store', 'Incompatible'],
  ['version', 'Incompatible'],
] as const)
  test('forwarded health rejects ' + mode + ' without publishing a private endpoint', async () => {
    const f = await fixture('normal', mode);
    try {
      await assert.rejects(
        f.client.command('connect', { profileId: 'configured' }),
        (e) => failure(code)(e) && !JSON.stringify(e).includes(f.key),
      );
      const state = await f.client.command('getConnection', {});
      assert.equal(state.state, 'failed');
      assert(!JSON.stringify(state).includes(f.key));
      await assert.rejects(f.endpoint(), failure('Unavailable'));
    } finally {
      await f.close();
    }
  });

for (const [mode, diagnostic, code] of [
  ['early', 'REMOTE HOST IDENTIFICATION HAS CHANGED', 'Unavailable'],
  ['early', 'Permission denied', 'Unauthorized'],
  ['collision', '', 'Unavailable'],
  ['extra-forward', '', 'InvalidInput'],
  ['key-policy', '', 'InvalidInput'],
  ['clear-forward', '', 'InvalidInput'],
  ['device-tunnel', '', 'InvalidInput'],
  ['overflow', '', 'Unavailable'],
] as const)
  test(
    'owned SSH failure ' +
      mode +
      '/' +
      diagnostic +
      ' cleans children and keeps raw output private',
    async () => {
      const f = await fixture(mode);
      f.setMode(mode, diagnostic);
      try {
        await assert.rejects(
          f.client.command('connect', { profileId: 'configured' }),
          (e) => failure(code)(e) && !JSON.stringify(e).includes(f.key),
        );
        const state = await f.client.command('getConnection', {});
        assert.equal(state.state, 'failed');
        assert(!JSON.stringify(state).includes(f.key));
        if (mode === 'collision') {
          f.setMode('normal');
          assert.equal(
            (await f.client.command('connect', { profileId: 'configured' })).state,
            'connected',
          );
        }
      } finally {
        await f.close();
      }
    },
  );

test('a command for another profile or host cannot spawn or select a target', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.client.command('connect', { profileId: 'other' }),
      failure('InvalidInput'),
    );
    await assert.rejects(
      f.runtime.runPromise(
        Effect.flatMap(ConnectionService, (s) =>
          s.endpoint({ host: { ...f.profile.expected, storeId: 'other' } }),
        ),
      ),
      failure('Conflict'),
    );
    assert.equal(f.spawned().length, 0);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      f.client.command('connect', { profileId: 'configured' }, { signal: abort.signal }),
      failure('Cancelled'),
    );
    assert.equal(f.spawned().length, 0);
  } finally {
    await f.close();
  }
});

test('executable spawn failure is typed and does not disclose paths or private values', async () => {
  const f = await fixture(),
    other = f.start({ ...f.config, sshExecutable: join(f.base, 'missing-executable') });
  try {
    await assert.rejects(
      other.client.command('connect', { profileId: 'configured' }),
      (e) =>
        failure('Unavailable')(e) &&
        !JSON.stringify(e).includes(f.base) &&
        !JSON.stringify(e).includes(f.key),
    );
  } finally {
    await other.runtime.dispose();
    await f.close();
  }
});

test('root disposal kills an uncooperative owned child, releases the forward and isolates other runtimes', async () => {
  const f = await fixture('ignore-term'),
    other = f.start();
  try {
    const first = await f.client.command('connect', { profileId: 'configured' });
    f.setMode('normal');
    const second = await other.client.command('connect', { profileId: 'configured' });
    assert.notEqual(second.connectionId, first.connectionId);
    await f.runtime.dispose();
    assert(!alive(f.forwards()[0].pid));
    assert(alive(f.forwards()[1].pid));
    assert.equal((await other.client.command('getConnection', {})).state, 'connected');
  } finally {
    await other.runtime.dispose();
    await f.close();
  }
});

test('public disconnect reports an unknown throwing process release; later root cleanup can recover', async () => {
  const f = await fixture();
  const originalKill = process.kill.bind(process);
  try {
    const connected = await f.client.command('connect', { profileId: 'configured' }),
      pid = f.forwards()[0].pid;
    mock.method(process, 'kill', function (target: number, signal?: NodeJS.Signals | number) {
      if (target === -pid && signal !== 0)
        throw new Proxy(
          {},
          {
            get() {
              throw f.key;
            },
          },
        );
      return originalKill(target, signal);
    });
    await assert.rejects(
      f.client.command('disconnect', { connectionId: connected.connectionId! }),
      (e) =>
        ApplicationError.is(e) &&
        /teardown|cleanup/i.test(e.message) &&
        !JSON.stringify(e).includes(f.key),
    );
    await assert.rejects(f.endpoint(), failure('Unavailable'));
  } finally {
    mock.restoreAll();
    await f.close();
  }
});

test('watch subscriptions are bounded and unsubscribe plus concurrent root disposal has no connection side effect', async () => {
  const f = await fixture(),
    stops: ObservationClose[] = [],
    events: ConnectionSnapshot[] = [];
  let reported: ApplicationError | undefined;
  try {
    for (let i = 0; i < 64; i++)
      stops.push(
        f.client.watch(
          (event) => events.push(event),
          (e) => {
            reported = e;
          },
        ),
      );
    await until(() => events.length === 64);
    const overflow = f.client.watch(
      () => {},
      (e) => {
        reported = e;
      },
    );
    await until(() => !!reported);
    assert.equal(reported?.code, 'Unavailable');
    await assert.rejects(overflow(), failure('Unavailable'));
    await Promise.all(stops.map((stop) => stop()));
    await f.runtime.dispose();
    assert.equal(f.spawned().length, 0);
  } finally {
    await Promise.all(stops.map((stop) => stop()));
    await f.close();
  }
  const raced = await fixture();
  const stop = raced.client.watch(
    () => {},
    () => {},
  );
  try {
    const [observation, root] = await Promise.allSettled([stop(), raced.runtime.dispose()]);
    assert.equal(root.status, 'fulfilled');
    if (observation.status === 'rejected')
      assert(
        failure('Unavailable')(observation.reason) || failure('Cancelled')(observation.reason),
      );
    assert.equal(raced.spawned().length, 0);
  } finally {
    await raced.close();
  }
});

test('IO watch close awaits release and retains a redacted cleanup failure on repeated close', async () => {
  const f = await fixture();
  let observed = false,
    failed = false;
  const errors: ApplicationError[] = [];
  const stop = f.client.watch(
    () => {
      observed = true;
    },
    (error) => errors.push(error),
  );
  try {
    await until(() => observed);
    const remove = Set.prototype.delete;
    mock.method(Set.prototype, 'delete', function (this: Set<unknown>, value: unknown) {
      const removed = remove.call(this, value);
      if (removed && !failed && Queue.isQueue(value)) {
        failed = true;
        throw Error(f.key);
      }
      return removed;
    });
    const closed = stop();
    assert.equal(stop(), closed);
    await assert.rejects(
      closed,
      (error) =>
        failure('Unavailable')(error) &&
        /cleanup/.test((error as ApplicationError).message) &&
        !JSON.stringify(error).includes(f.key),
    );
    assert(failed);
    assert.equal(errors.length, 0);
    await assert.rejects(stop(), failure('Unavailable'));
    assert.equal((await f.client.command('getConnection', {})).state, 'disconnected');
    assert.equal(f.spawned().length, 0);
  } finally {
    mock.restoreAll();
    await stop().catch(() => {});
    await f.close();
  }
});

test('installed system OpenSSH accepts the safe owned-child options without making a network connection', () => {
  const output = execFileSync(
    '/usr/bin/ssh',
    [
      '-F',
      '/dev/null',
      '-G',
      '-N',
      '-T',
      '-n',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ControlPersist=no',
      '-o',
      'ForkAfterAuthentication=no',
      '-o',
      'RemoteCommand=none',
      '-o',
      'GatewayPorts=no',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      '127.0.0.1:49111:127.0.0.1:49112',
      '--',
      'moonbase-syntax.invalid',
    ],
    { encoding: 'utf8' },
  );
  assert(/^controlmaster false$/m.test(output), 'Multiplex master must be disabled.');
  assert(!/^controlpath /m.test(output), 'ControlPath=none must disable the control socket.');
  assert(/^forkafterauthentication no$/m.test(output), 'SSH must stay in the foreground.');
  assert(
    /^localforward \[127\.0\.0\.1\]:49111 \[127\.0\.0\.1\]:49112$/m.test(output),
    'Forward must be explicit loopback to loopback.',
  );
});

test('disconnect and root disposal during startup release the pending generation without disposing its independent host', async () => {
  for (const action of ['disconnect', 'dispose']) {
    const f = await fixture('slow'),
      pending = f.client.command('connect', { profileId: 'configured' });
    const rejected = assert.rejects(
      pending,
      (e) => ApplicationError.is(e) && ['Cancelled', 'Unavailable'].includes(e.code),
    );
    try {
      await until(() => f.forwards().length === 1);
      const captured = await f.client.command('getConnection', {});
      assert.equal(captured.state, 'connecting');
      if (action === 'disconnect')
        await f.client.command('disconnect', { connectionId: captured.connectionId! });
      else await f.runtime.dispose();
      await rejected;
      assert(f.spawned().every((child) => !alive(child.pid)));
      for (const port of f.ports()) await free(port);
      if (action === 'disconnect') {
        f.setMode('normal');
        assert.equal(
          (await f.client.command('connect', { profileId: 'configured' })).state,
          'connected',
        );
      }
    } finally {
      await f.close();
    }
  }
});

test('a stalled forwarded health response hits the startup deadline and releases the reader, child and port', async () => {
  const f = await fixture('normal', 'stall', { startupMs: 500 });
  try {
    await assert.rejects(
      f.client.command('connect', { profileId: 'configured' }),
      (e) => failure('Unavailable')(e) && /startup deadline/.test((e as ApplicationError).message),
    );
    assert.equal((await f.client.command('getConnection', {})).state, 'failed');
    await assert.rejects(f.endpoint(), failure('Unavailable'));
    await until(() => f.spawned().every((child) => !alive(child.pid)));
    for (const port of f.ports()) await free(port);
  } finally {
    await f.close();
  }
});

test('runnable consumer composition root uses the public package and never prints its private configuration', async () => {
  const f = await fixture(),
    configuration = join(f.base, 'private-config.json');
  const execute = () =>
    new Promise<{ error: Error | null; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [
          '--experimental-strip-types',
          fileURLToPath(new URL('../examples/connect.ts', import.meta.url)),
          configuration,
        ],
        { timeout: 10000 },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
    });
  try {
    writeFileSync(configuration, JSON.stringify(f.config), { mode: 0o600 });
    const good = await execute();
    assert.equal(good.error, null);
    assert(good.stdout.includes('"profile"'));
    assert(!good.stdout.includes(f.key));
    assert(!good.stderr.includes(f.key));
    assert(!good.stdout.includes('http://127.0.0.1:'));
    assert.equal(f.forwards().length, 1);
    assert(f.spawned().every((child) => !alive(child.pid)));
    writeFileSync(
      configuration,
      JSON.stringify({ ...f.config, sshExecutable: 'relative/' + f.key }),
    );
    const invalid = await execute();
    assert(invalid.error);
    assert.match(invalid.stderr, /Could not read the private connection configuration JSON/);
    assert(!invalid.stderr.includes(f.key));
    assert(!invalid.stderr.includes(f.base));
    assert.equal(f.forwards().length, 1);
    writeFileSync(configuration, '{ malformed private JSON ' + f.key);
    const bad = await execute();
    assert(bad.error);
    assert.match(bad.stderr, /Could not read the private connection configuration JSON/);
    assert(!bad.stderr.includes(f.key));
    assert.equal(f.forwards().length, 1);
  } finally {
    await f.close();
  }
});

for (const action of ['disconnect', 'dispose'])
  for (const deduplicated of [false, true])
    test(`${action} from the first connecting observation settles ${deduplicated ? 'all coalesced callers' : 'Connect before attempt startup'}`, async () => {
      const f = await fixture(),
        abort = new AbortController(),
        secondAbort = new AbortController();
      let release: Promise<void> | undefined,
        second: Promise<unknown> | undefined,
        outcome: unknown,
        secondOutcome: unknown;
      let watched = false;
      const stop = f.client.watch(
        (value) => {
          watched = true;
          if (value.state === 'connecting' && !release) {
            if (deduplicated)
              second = f.client
                .command('connect', { profileId: 'configured' }, { signal: secondAbort.signal })
                .then(
                  (v) => {
                    secondOutcome = v;
                  },
                  (e) => {
                    secondOutcome = e;
                  },
                );
            release =
              action === 'disconnect'
                ? f.client.command('disconnect', { connectionId: value.connectionId })
                : f.runtime.dispose();
          }
        },
        (e) => {
          throw e;
        },
      );
      let pending: Promise<unknown> | undefined;
      try {
        await until(() => watched);
        pending = f.client
          .command('connect', { profileId: 'configured' }, { signal: abort.signal })
          .then(
            (v) => {
              outcome = v;
            },
            (e) => {
              outcome = e;
            },
          );
        await until(() => !!release);
        await release;
        await until(
          () => outcome !== undefined && (!deduplicated || secondOutcome !== undefined),
          'owning release left a Connect waiter pending',
          600,
        );
        const cancelled = (value: unknown) =>
          ApplicationError.is(value) &&
          (value.code === 'Cancelled' || (action === 'dispose' && value.code === 'Unavailable'));
        assert(cancelled(outcome));
        if (deduplicated) assert(cancelled(secondOutcome));
        if (action === 'disconnect')
          assert.equal((await f.client.command('getConnection', {})).state, 'disconnected');
        else await assert.rejects(f.client.command('getConnection', {}));
        assert.equal(f.spawned().length, 0);
      } finally {
        await stop();
        abort.abort();
        secondAbort.abort();
        await Promise.allSettled([pending, second, release]);
        await f.close();
      }
    });

for (const [flag, extra] of [
  ['NoHostAuthenticationForLocalhost', 'HostName 127.0.0.1'],
  ['NoHostAuthenticationForProxyCommand', 'ProxyCommand /usr/bin/false'],
] as const)
  for (const enabled of [true, false])
    test(`actual system policy ${flag} ${enabled ? 'rejects enabled bypass' : 'preserves normal verification'}`, async () => {
      const f = await fixture(),
        config = join(f.base, 'test-only-ssh-config');
      writeFileSync(
        config,
        `Host *\n StrictHostKeyChecking yes\n ${extra}\n ${flag} ${enabled ? 'yes' : 'no'}\n`,
        { mode: 0o600 },
      );
      f.setMode('normal', undefined, config);
      try {
        if (enabled) {
          await assert.rejects(
            f.client.command('connect', { profileId: 'configured' }),
            failure('InvalidInput'),
          );
          assert.equal(f.forwards().length, 0);
          await assert.rejects(f.endpoint(), failure('Unavailable'));
        } else
          assert.equal(
            (await f.client.command('connect', { profileId: 'configured' })).state,
            'connected',
          );
      } finally {
        await f.close();
      }
    });

for (const [mode, action] of [
  ['held-stderr', 'exit'],
  ['held-both', 'exit'],
  ['held-none', 'exit'],
  ['held-both', 'disconnect'],
  ['held-none', 'dispose'],
])
  test(`SSH ${action} invalidates the endpoint and reaps ${mode} helper group without touching a different generation`, async () => {
    const f = await fixture(mode),
      unrelated = f.start();
    try {
      const first = await f.client.command('connect', { profileId: 'configured' });
      await until(() => f.helpers().length === 1);
      const helper = f.helpers()[0],
        forward = f.forwards()[0];
      f.setMode('normal');
      const other = await unrelated.client.command('connect', { profileId: 'configured' });
      assert.notEqual(other.connectionId, first.connectionId);
      const pgid = (pid: number) =>
        Number(
          execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
        );
      assert.equal(pgid(forward.pid), forward.pid);
      assert.equal(pgid(helper.pid), forward.pid);
      assert.notEqual(pgid(f.forwards()[1].pid), forward.pid);
      if (action === 'exit') {
        process.kill(forward.pid, 'SIGKILL');
        await until(() => !alive(forward.pid));
        await until(
          async () => (await f.client.command('getConnection', {})).state === 'failed',
          'process exit stayed connected behind inherited pipes',
          800,
        );
        await assert.rejects(f.endpoint(), failure('Unavailable'));
        await f.client.command('disconnect', { connectionId: first.connectionId! });
      } else if (action === 'disconnect') {
        await f.client.command('disconnect', { connectionId: first.connectionId! });
        await assert.rejects(f.endpoint(), failure('Unavailable'));
      } else {
        await f.runtime.dispose();
        await assert.rejects(f.endpoint());
      }
      await until(() => !alive(helper.pid));
      await free(helper.port);
      assert(alive(f.forwards()[1].pid));
      assert.equal((await unrelated.client.command('getConnection', {})).state, 'connected');
      if (mode !== 'held-stderr') assert(rows(f.log).some((row) => row.event === 'helper-term'));
      assert.throws(
        () => process.kill(-forward.pid, 0),
        (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ESRCH',
      );
    } finally {
      // Failed pre-fix probes must not leave their explicitly recorded fixture helper running.
      for (const row of f.helpers()) if (alive(row.pid)) process.kill(row.pid, 'SIGKILL');
      await tick();
      await unrelated.runtime.dispose();
      await f.close();
    }
  });

for (const action of ['exit', 'cancel'])
  test(`actual SSH with a pipe-only ProxyCommand releases its owned helper after ${action}`, async () => {
    const f = await fixture(),
      abort = new AbortController(),
      proxy = join(f.base, 'pipe-only-proxy.mjs'),
      config = join(f.base, 'private-test-ssh-config');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(
      proxy,
      `import {appendFileSync} from 'node:fs'; import {createServer} from 'node:net';
    const server=createServer(); server.listen(0,'127.0.0.1',()=>appendFileSync(${JSON.stringify(f.log)},JSON.stringify({event:'helper',pid:process.pid,parent:process.ppid,port:server.address().port})+'\\n'));
    process.on('SIGTERM',()=>appendFileSync(${JSON.stringify(f.log)},JSON.stringify({event:'helper-term',pid:process.pid})+'\\n'));
  `,
    );
    writeFileSync(
      config,
      `Host *\n HostName 127.0.0.1\n StrictHostKeyChecking yes\n ProxyCommand ${quote(process.execPath)} ${quote(proxy)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      f.config.sshExecutable,
      '#!/bin/sh\nexec /usr/bin/ssh -F ' + quote(config) + ' "$@"\n',
      { mode: 0o700 },
    );
    let outcome: unknown;
    let helper!: ReturnType<typeof f.helpers>[number];
    const pending = f.client
      .command('connect', { profileId: 'configured' }, { signal: abort.signal })
      .then(
        (v) => {
          outcome = v;
        },
        (e) => {
          outcome = e;
        },
      );
    try {
      await until(() => f.helpers().length === 1);
      helper = f.helpers()[0];
      if (action === 'exit') {
        process.kill(helper.parent, 'SIGKILL');
        await until(() => !alive(helper.parent));
      } else abort.abort();
      await until(
        () => outcome !== undefined,
        'actual SSH exit/cancel stayed pending behind its proxy pipe',
      );
      assert(failure(action === 'exit' ? 'Unavailable' : 'Cancelled')(outcome));
      await until(
        () => !alive(helper.pid),
        'owned ProxyCommand helper survived connection release',
      );
      await free(helper.port);
      assert.equal(
        (await f.client.command('getConnection', {})).state,
        action === 'exit' ? 'failed' : 'disconnected',
      );
      await assert.rejects(f.endpoint(), failure('Unavailable'));
    } finally {
      abort.abort();
      for (const row of f.helpers()) if (alive(row.pid)) process.kill(row.pid, 'SIGKILL');
      await pending;
      if (helper) await until(() => !alive(helper.parent) && !alive(helper.pid));
      await f.close();
    }
  });

test('cancellation during admitted teardown cannot strand the owned helper group', async () => {
  const f = await fixture('held-both'),
    abort = new AbortController();
  try {
    const connected = await f.client.command('connect', { profileId: 'configured' });
    await until(() => f.helpers().length === 1);
    const helper = f.helpers()[0],
      forward = f.forwards()[0];
    const releasing = f.client
      .command('disconnect', { connectionId: connected.connectionId! }, { signal: abort.signal })
      .then(
        () => undefined,
        (e) => e,
      );
    await until(
      async () => (await f.client.command('getConnection', {})).state === 'disconnecting',
    );
    abort.abort();
    const outcome = await releasing;
    assert(outcome === undefined || failure('Cancelled')(outcome));
    assert.equal((await f.client.command('getConnection', {})).state, 'disconnected');
    assert(!alive(forward.pid));
    assert(!alive(helper.pid));
    await free(helper.port);
    assert.throws(
      () => process.kill(-forward.pid, 0),
      (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ESRCH',
    );
  } finally {
    abort.abort();
    for (const row of f.helpers()) if (alive(row.pid)) process.kill(row.pid, 'SIGKILL');
    await f.close();
  }
});

for (const persistent of [false, true])
  test(`${persistent ? 'persistent' : 'transient'} EPERM during owned-group exit requires confirmed absence`, async () => {
    const f = await fixture('held-both'),
      other = f.start(),
      originalKill = process.kill.bind(process);
    let observations = 0,
      term = false;
    const deniedSignals = new Set<NodeJS.Signals | number>();
    try {
      const connected = await f.client.command('connect', { profileId: 'configured' });
      await until(() => f.helpers().length === 1);
      const leader = f.forwards()[0],
        helper = f.helpers()[0];
      f.setMode('normal');
      const independent = await other.client.command('connect', { profileId: 'configured' });
      mock.method(process, 'kill', function (pid: number, signal?: NodeJS.Signals | number) {
        if (
          !persistent &&
          pid === -leader.pid &&
          (signal === 'SIGTERM' || signal === 'SIGKILL') &&
          !deniedSignals.has(signal)
        ) {
          deniedSignals.add(signal);
          throw Object.assign(new Error('Controlled transient group-signal ambiguity'), {
            code: 'EPERM',
          });
        }
        if (pid === -leader.pid && signal === 0 && term && (persistent || observations < 3)) {
          observations++;
          throw Object.assign(new Error('Controlled Darwin exit-window observation'), {
            code: 'EPERM',
          });
        }
        const result = originalKill(pid, signal);
        if (pid === -leader.pid && signal === 'SIGTERM') term = true;
        return result;
      });
      const started = performance.now(),
        releasing = f.client.command('disconnect', { connectionId: connected.connectionId! });
      if (persistent) {
        await assert.rejects(releasing, failure('Unavailable'));
        assert(
          performance.now() - started >= 2400,
          'persistent ambiguity failed before the existing cleanup budget',
        );
        assert(performance.now() - started < 3500, 'persistent ambiguity exceeded its bound');
        assert.equal((await f.client.command('getConnection', {})).state, 'disconnecting');
        await assert.rejects(
          f.client.command('connect', { profileId: 'configured' }),
          failure('Conflict'),
        );
        await assert.rejects(f.endpoint(), failure('Unavailable'));
        mock.restoreAll();
        await f.client.command('disconnect', { connectionId: connected.connectionId! });
      } else {
        await releasing;
        assert.equal(observations, 3);
        assert.deepEqual([...deniedSignals], ['SIGTERM', 'SIGKILL']);
      }
      mock.restoreAll();
      assert.equal((await f.client.command('getConnection', {})).state, 'disconnected');
      assert(!alive(leader.pid));
      assert(!alive(helper.pid));
      assert.throws(
        () => originalKill(-leader.pid, 0),
        (e: unknown) => e instanceof Error && 'code' in e && e.code === 'ESRCH',
      );
      for (const port of [...f.ports().slice(0, 1), helper.port]) await free(port);
      assert(alive(f.forwards()[1].pid));
      assert.equal(
        (await other.client.command('getConnection', {})).connectionId,
        independent.connectionId,
      );
      const reconnected = await f.client.command('connect', { profileId: 'configured' });
      assert.notEqual(reconnected.connectionId, connected.connectionId);
    } finally {
      mock.restoreAll();
      await other.runtime.dispose();
      await f.close();
    }
  });
