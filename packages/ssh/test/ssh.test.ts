import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { ChildProcess, execFileSync } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Effect, ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/application/client';
import type { ConnectionSnapshot } from '@moonbase/application/connection-client';
import { chatHostVersion, chatProtocolVersion } from '@moonbase/application/host-client';
import { createHostHealthReply } from '@moonbase/application/host-health';
import { ConnectionService } from '@moonbase/application/services';
import { makeConnectionClient } from '@moonbase/application/runtime-client';
import { SshLive, type SshConfiguration } from '@moonbase/ssh';
const failure = (code: ApplicationError['code']) => (e: unknown) => ApplicationError.is(e) && e.code === code;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean | Promise<boolean>, message = 'condition did not settle', limit = 4000) { const end = Date.now() + limit; while (!await check()) { assert(Date.now() < end, message); await tick(); } }
function rows(path: string): any[] { try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function free(port: number) { const server = tcpServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture(mode = 'normal', healthMode = 'valid') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-ssh-'))), key = randomBytes(32).toString('base64url'), log = join(base, 'children.jsonl'), control = join(base, 'control.json');
  const expected = {hostId: 'explicit-host', storeId: 'explicit-store'}, requests: {url: string; headers: string}[] = [];
  const health = httpServer((req, res) => {
    requests.push({url: req.url!, headers: JSON.stringify(req.headers)});
    if (healthMode === 'stall') { res.writeHead(200, {'content-type': 'application/json'}); res.write('{'); return; }
    try {
      const body = createHostHealthReply({token: healthMode === 'auth' ? 'different-synthetic-host-key' : key, nonce: req.headers['x-moonbase-nonce'] as string, authorization: req.headers.authorization,
        health: {hostId: healthMode === 'identity' ? 'other-host' : expected.hostId, storeId: healthMode === 'store' ? 'other-store' : expected.storeId, protocol: chatProtocolVersion, version: chatHostVersion, capabilities: ['chat-v0']}});
      if (healthMode === 'version') (body as any).version = '99.0.0';
      res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(body));
    } catch { res.writeHead(401); res.end(); }
  });
  await new Promise<void>(resolve => health.listen(0, '127.0.0.1', resolve));
  const remotePort = (health.address() as import('node:net').AddressInfo).port;
  const executable = join(base, 'SSH resources with spaces');
  writeFileSync(executable, '#!' + process.execPath + '\nprocess.env.MOONBASE_SSH_TEST_CONTROL=' + JSON.stringify(control) + ';\n' + readFileSync(fileURLToPath(new URL('./fake-ssh.mjs', import.meta.url)), 'utf8')); chmodSync(executable, 0o700);
  const setMode = (value: string, diagnostic?: string) => writeFileSync(control, JSON.stringify({mode: value, diagnostic, log, key})); setMode(mode);
  const profile = {id: 'configured', label: 'Operator host', destination: 'configured-alias', remotePort, expected};
  const config = {profile, token: key, sshExecutable: executable};
  const start = (configuration: SshConfiguration = config) => { const runtime = ManagedRuntime.make(SshLive(configuration)); return {runtime, client: makeConnectionClient(runtime)}; };
  const current = start();
  const spawned = () => rows(log).filter(r => r.event === 'preflight' || r.event === 'forward');
  const forwards = () => spawned().filter(r => r.event === 'forward');
  const ports = () => forwards().map(r => Number(r.args[r.args.indexOf('-L') + 1].split(':')[1]));
  const endpoint = () => current.runtime.runPromise(Effect.flatMap(ConnectionService, service => service.endpoint({host: expected})));
  return {...current, base, key, log, profile, config, requests, start, spawned, forwards, ports, setMode, endpoint, async close() {
    await current.runtime.dispose(); health.closeAllConnections(); await new Promise<void>(resolve => health.close(() => resolve()));
    for (const child of spawned()) assert(!alive(child.pid), 'owned child leaked: ' + child.pid);
    for (const port of ports()) await free(port);
    rmSync(base, {recursive: true, force: true});
  }};
}

test('independent public client connects once, verifies health, protects privileged fields and tears down only its child', async () => {
  const f = await fixture();
  const prior = process.env.MOONBASE_SSH_SYNTHETIC_KEY; process.env.MOONBASE_SSH_SYNTHETIC_KEY = f.key;
  try {
    const initial = await f.client.command('getConnection', {}); assert.equal(initial.state, 'disconnected'); assert.equal(f.spawned().length, 0);
    await assert.rejects(f.endpoint(), failure('Unavailable')); assert.equal(f.spawned().length, 0);
    const second = makeConnectionClient(f.runtime);
    const [one, two] = await Promise.all([f.client.command('connect', {profileId: 'configured'}), second.command('connect', {profileId: 'configured'})]);
    assert.equal(one.state, 'connected'); assert.deepEqual(two, one); assert.equal(f.forwards().length, 1); assert.equal(f.spawned().length, 2);
    one.profile.expected.storeId = 'mutated-public-copy'; if (one.state === 'connected') one.health.hostId = 'mutated-public-copy';
    assert.deepEqual((await f.client.command('getConnection', {})).profile, f.profile);
    const endpoint = await f.endpoint(); assert.equal(endpoint.token, f.key); assert.equal(endpoint.connectionId, one.connectionId); assert.deepEqual(endpoint.health.hostId, f.profile.expected.hostId);
    assert(!JSON.stringify(one).includes(f.key)); assert(!JSON.stringify(one).includes(endpoint.origin));
    assert(!f.spawned().some(row => row.keyInEnvironment)); assert(!JSON.stringify(f.spawned()).includes(f.key));
    assert(f.requests.length); assert(f.requests.every(req => req.url === '/v1/health' && !req.headers.includes(f.key)));
    const args = f.forwards()[0].args; assert.deepEqual(args.slice(-2), ['--', f.profile.destination]);
    for (const value of ['ControlMaster=no', 'ControlPath=none', 'ControlPersist=no', 'ForkAfterAuthentication=no', 'BatchMode=yes', 'ExitOnForwardFailure=yes', 'GatewayPorts=no', 'PermitLocalCommand=no', 'RemoteCommand=none']) assert(args.includes(value));
    assert(!args.some((value: string) => /StrictHostKeyChecking|KnownHostsFile/.test(value)));
    assert.match(args[args.indexOf('-L') + 1], new RegExp('^127\\.0\\.0\\.1:\\d+:127\\.0\\.0\\.1:' + f.profile.remotePort + '$'));
    await f.client.command('disconnect', {connectionId: one.connectionId!}); assert.equal((await f.client.command('getConnection', {})).state, 'disconnected');
    await f.client.command('disconnect', {connectionId: one.connectionId!});
  } finally { if (prior === undefined) delete process.env.MOONBASE_SSH_SYNTHETIC_KEY; else process.env.MOONBASE_SSH_SYNTHETIC_KEY = prior; await f.close(); }
});

test('slow startup leaves status usable; cancellation releases a shared attempt and unrelated observers remain alive', async () => {
  const f = await fixture('slow'); const abort = new AbortController();
  const pending = f.client.command('connect', {profileId: 'configured'}, {signal: abort.signal}), rejected = assert.rejects(pending, failure('Cancelled'));
  try {
    await until(() => f.forwards().length === 1);
    const snapshot = await f.client.command('getConnection', {}); assert.equal(snapshot.state, 'connecting');
    const second = f.client.command('connect', {profileId: 'configured'}), secondRejected = assert.rejects(second, failure('Cancelled'));
    await assert.rejects(f.client.command('disconnect', {connectionId: 'stale'}), failure('Conflict'));
    abort.abort(); await rejected; await secondRejected;
    assert.equal((await f.client.command('getConnection', {})).state, 'disconnected'); assert.equal(f.forwards().length, 1);
    f.setMode('normal'); const connected = await f.client.command('connect', {profileId: 'configured'}); assert.equal(connected.state, 'connected'); assert.notEqual(connected.connectionId, snapshot.connectionId);
    await assert.rejects(f.client.command('disconnect', {connectionId: snapshot.connectionId!}), failure('Conflict'));
    assert.equal((await f.client.command('getConnection', {})).connectionId, connected.connectionId);
  } finally { abort.abort(); await f.close(); }
});

test('observation unsubscribe is not disconnect; generation exit fails visibly and reconnect never sends', async () => {
  const f = await fixture(); const events: ConnectionSnapshot[] = [], errors: ApplicationError[] = [];
  let stop = f.client.watch(event => events.push(event), e => errors.push(e));
  try {
    await until(() => events.length > 0); assert.equal(events[0].state, 'disconnected');
    const first = await f.client.command('connect', {profileId: 'configured'}); await until(() => events.some(e => e.state === 'connected'));
    stop(); await tick(); const observed = events.length;
    assert.equal((await f.client.command('getConnection', {})).state, 'connected');
    process.kill(f.forwards()[0].pid, 'SIGTERM');
    await until(async () => (await f.client.command('getConnection', {})).state === 'failed'); await assert.rejects(f.endpoint(), failure('Unavailable'));
    assert.equal(events.length, observed); assert.equal(errors.length, 0);
    stop = f.client.watch(event => events.push(event), e => errors.push(e));
    const second = await f.client.command('connect', {profileId: 'configured'}); assert.notEqual(second.connectionId, first.connectionId);
    await assert.rejects(f.client.command('disconnect', {connectionId: first.connectionId!}), failure('Conflict'));
    assert.equal((await f.client.command('getConnection', {})).state, 'connected'); assert(f.requests.every(r => r.url === '/v1/health'));
  } finally { stop(); await f.close(); }
});

for (const [mode, code] of [['auth', 'Unauthorized'], ['identity', 'Incompatible'], ['store', 'Incompatible'], ['version', 'Incompatible']] as const) test('forwarded health rejects ' + mode + ' without publishing a private endpoint', async () => {
  const f = await fixture('normal', mode);
  try {
    await assert.rejects(f.client.command('connect', {profileId: 'configured'}), e => failure(code)(e) && !JSON.stringify(e).includes(f.key));
    const state = await f.client.command('getConnection', {}); assert.equal(state.state, 'failed'); assert(!JSON.stringify(state).includes(f.key));
    await assert.rejects(f.endpoint(), failure('Unavailable'));
  } finally { await f.close(); }
});

for (const [mode, diagnostic, code] of [['early', 'REMOTE HOST IDENTIFICATION HAS CHANGED', 'Unavailable'], ['early', 'Permission denied', 'Unauthorized'], ['collision', '', 'Unavailable'], ['extra-forward', '', 'InvalidInput'], ['key-policy', '', 'InvalidInput'], ['clear-forward', '', 'InvalidInput'], ['device-tunnel', '', 'InvalidInput'], ['overflow', '', 'Unavailable']] as const) test('owned SSH failure ' + mode + '/' + diagnostic + ' cleans children and keeps raw output private', async () => {
  const f = await fixture(mode); f.setMode(mode, diagnostic);
  try {
    await assert.rejects(f.client.command('connect', {profileId: 'configured'}), e => failure(code)(e) && !JSON.stringify(e).includes(f.key));
    const state = await f.client.command('getConnection', {}); assert.equal(state.state, 'failed'); assert(!JSON.stringify(state).includes(f.key));
    if (mode === 'collision') { f.setMode('normal'); assert.equal((await f.client.command('connect', {profileId: 'configured'})).state, 'connected'); }
  } finally { await f.close(); }
});

test('private config is projected explicitly and invalid commands/config cannot spawn or select a target', async () => {
  const f = await fixture();
  const extra = {...f.config, profile: {...f.profile, token: f.key, origin: 'http://127.0.0.1:9999', expected: {...f.profile.expected, token: f.key}}};
  const other = f.start(extra);
  try {
    assert.deepEqual((await other.client.command('getConnection', {})).profile, f.profile);
    for (const bad of [{...f.config, token: 'short'}, {...f.config, profile: {...f.profile, destination: '-oProxyCommand=bad'}}, {...f.config, profile: {...f.profile, remotePort: 0}}, {...f.config, profile: {...f.profile, label: f.key}}, {...f.config, sshExecutable: 'relative'}]) {
      const invalid = f.start(bad); try { await assert.rejects(invalid.client.command('getConnection', {}), failure('InvalidInput')); } finally { await invalid.runtime.dispose(); }
    }
    await assert.rejects(f.client.command('getConnection', {token: f.key} as any), failure('InvalidInput'));
    await assert.rejects(f.client.command('connect', {profileId: 'other'}), failure('InvalidInput'));
    await assert.rejects(f.runtime.runPromise(Effect.flatMap(ConnectionService, s => s.endpoint({host: {...f.profile.expected, storeId: 'other'}}))), failure('Conflict'));
    assert.equal(f.spawned().length, 0);
    const abort = new AbortController(); abort.abort(); await assert.rejects(f.client.command('connect', {profileId: 'configured'}, {signal: abort.signal}), failure('Cancelled')); assert.equal(f.spawned().length, 0);
  } finally { await other.runtime.dispose(); await f.close(); }
});

test('executable spawn failure is typed and does not disclose paths or private values', async () => {
  const f = await fixture(), other = f.start({...f.config, sshExecutable: join(f.base, 'missing-executable')});
  try { await assert.rejects(other.client.command('connect', {profileId: 'configured'}), e => failure('Unavailable')(e) && !JSON.stringify(e).includes(f.base) && !JSON.stringify(e).includes(f.key)); }
  finally { await other.runtime.dispose(); await f.close(); }
});

test('root disposal kills an uncooperative owned child, releases the forward and isolates other runtimes', async () => {
  const f = await fixture('ignore-term'), other = f.start();
  try {
    const first = await f.client.command('connect', {profileId: 'configured'});
    f.setMode('normal'); const second = await other.client.command('connect', {profileId: 'configured'}); assert.notEqual(second.connectionId, first.connectionId);
    await f.runtime.dispose(); assert(!alive(f.forwards()[0].pid)); assert(alive(f.forwards()[1].pid));
    assert.equal((await other.client.command('getConnection', {})).state, 'connected');
  } finally { await other.runtime.dispose(); await f.close(); }
});

test('public disconnect reports an unknown throwing process release; later root cleanup can recover', async () => {
  const f = await fixture(); const originalKill = ChildProcess.prototype.kill;
  try {
    const connected = await f.client.command('connect', {profileId: 'configured'}), pid = f.forwards()[0].pid;
    mock.method(ChildProcess.prototype, 'kill', function(this: ChildProcess, signal?: NodeJS.Signals | number) {
      if (this.pid === pid) throw new Proxy({}, {get() { throw f.key; }});
      return originalKill.call(this, signal);
    });
    await assert.rejects(f.client.command('disconnect', {connectionId: connected.connectionId!}), e => ApplicationError.is(e) && /teardown|cleanup/i.test(e.message) && !JSON.stringify(e).includes(f.key));
    await assert.rejects(f.endpoint(), failure('Unavailable'));
  } finally { mock.restoreAll(); await f.close(); }
});

test('watch subscriptions are bounded and unsubscribe plus concurrent root disposal has no connection side effect', async () => {
  const f = await fixture(), stops: (() => void)[] = [], events: ConnectionSnapshot[] = [];
  let reported: ApplicationError | undefined;
  try {
    for (let i = 0; i < 64; i++) stops.push(f.client.watch(event => events.push(event), e => { reported = e; }));
    await until(() => events.length === 64);
    stops.push(f.client.watch(() => {}, e => { reported = e; })); await until(() => !!reported); assert.equal(reported?.code, 'Unavailable');
    stops.forEach(stop => stop()); await f.runtime.dispose(); assert.equal(f.spawned().length, 0);
  } finally { stops.forEach(stop => stop()); await f.close(); }
  const raced = await fixture(); const stop = raced.client.watch(() => {}, () => {}); stop(); await raced.runtime.dispose(); await raced.close();
});

test('installed system OpenSSH accepts the safe owned-child options without making a network connection', () => {
  const output = execFileSync('/usr/bin/ssh', ['-F', '/dev/null', '-G', '-N', '-T', '-n', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no', '-o', 'ForkAfterAuthentication=no', '-o', 'RemoteCommand=none', '-o', 'GatewayPorts=no', '-o', 'ExitOnForwardFailure=yes', '-L', '127.0.0.1:49111:127.0.0.1:49112', '--', 'moonbase-syntax.invalid'], {encoding: 'utf8'});
  assert(/^controlmaster false$/m.test(output), 'Multiplex master must be disabled.'); assert(!/^controlpath /m.test(output), 'ControlPath=none must disable the control socket.'); assert(/^forkafterauthentication no$/m.test(output), 'SSH must stay in the foreground.'); assert(/^localforward \[127\.0\.0\.1\]:49111 \[127\.0\.0\.1\]:49112$/m.test(output), 'Forward must be explicit loopback to loopback.');
});

test('disconnect and root disposal during startup release the pending generation without disposing its independent host', async () => {
  for (const action of ['disconnect', 'dispose']) {
    const f = await fixture('slow'), pending = f.client.command('connect', {profileId: 'configured'});
    const rejected = assert.rejects(pending, e => ApplicationError.is(e) && ['Cancelled', 'Unavailable'].includes(e.code));
    try {
      await until(() => f.forwards().length === 1);
      const captured = await f.client.command('getConnection', {}); assert.equal(captured.state, 'connecting');
      if (action === 'disconnect') await f.client.command('disconnect', {connectionId: captured.connectionId!}); else await f.runtime.dispose();
      await rejected;
      assert(f.spawned().every(child => !alive(child.pid))); for (const port of f.ports()) await free(port);
      if (action === 'disconnect') { f.setMode('normal'); assert.equal((await f.client.command('connect', {profileId: 'configured'})).state, 'connected'); }
    } finally { await f.close(); }
  }
});

test('a stalled forwarded health response hits the bounded startup deadline and releases the reader/child/port', {timeout: 25000}, async () => {
  const f = await fixture('normal', 'stall'), began = Date.now();
  try {
    await assert.rejects(f.client.command('connect', {profileId: 'configured'}), failure('Unavailable'));
    assert(Date.now() - began < 23000); assert.equal((await f.client.command('getConnection', {})).state, 'failed');
    await assert.rejects(f.endpoint(), failure('Unavailable'));
  } finally { await f.close(); }
});

test('a child that never opens its forward cannot keep startup pending beyond the overall deadline', {timeout: 25000}, async () => {
  const f = await fixture('wait'), began = Date.now();
  try {
    await assert.rejects(f.client.command('connect', {profileId: 'configured'}), e => failure('Unavailable')(e) && /startup deadline/.test((e as ApplicationError).message));
    assert(Date.now() - began < 23000); assert.equal((await f.client.command('getConnection', {})).state, 'failed');
  } finally { await f.close(); }
});
