import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer, type AddressInfo } from 'node:net';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { chatHostVersion, chatProtocolVersion } from '@moonbase/contracts/host';
import {
  ConnectionError,
  HostVerificationError,
  toConnectionApplicationError,
} from '@moonbase/contracts/connection-errors';
import { CancelledError } from '@moonbase/contracts/errors';
import type { ChatHostEndpoint } from '@moonbase/contracts/services';
import type { ChatHostHealth } from '@moonbase/contracts/host';
import { ConnectionService } from '@moonbase/contracts/services';
import { makeConnectionClient } from '@moonbase/application/chat/clients';
import { SshLive, type SshConfiguration, type SshOptions } from '@moonbase/ssh';
/** An error with the legacy code `code`, as clients see it. */
export const failure = (code: ApplicationError['code']) => (e: unknown) => {
  const error =
    e instanceof ConnectionError ||
    e instanceof HostVerificationError ||
    e instanceof CancelledError
      ? toConnectionApplicationError(e)
      : e;
  return ApplicationError.is(error) && error.code === code;
};
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
export async function until(
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
export function rows(path: string): {
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
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export async function free(port: number) {
  const server = tcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
/**
 * A stand-in for the protocol's health check, which the consumer injects: it reads the forwarded
 * health route and checks only the identity, so these tests cover forwarding, not the protocol.
 */
export const verify: SshOptions['verify'] = (endpoint: ChatHostEndpoint) =>
  Effect.tryPromise({
    try: async (signal) => {
      // Like the real check, each attempt has its own short deadline.
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(50)]);
      const response = await fetch(`${endpoint.origin}/v1/health`, { signal: attempt }).catch(
        () => {
          throw new HostVerificationError({ reason: 'unreachable' });
        },
      );
      if (response.status === 401) throw new HostVerificationError({ reason: 'rejected' });
      const value = (await response.json().catch(() => {
        throw new HostVerificationError({ reason: 'read-failed' });
      })) as ChatHostHealth;
      if (value.hostId !== endpoint.expected.hostId || value.storeId !== endpoint.expected.storeId)
        throw new HostVerificationError({ reason: 'identity' });
      return value;
    },
    catch: (error) =>
      error instanceof HostVerificationError
        ? error
        : new HostVerificationError({ reason: 'unreachable' }),
  });
/**
 * A short stop for the cases that wait out the SIGTERM grace or the whole stop deadline (a group
 * that ignores SIGTERM, or one whose absence stays unconfirmed).
 */
export const quickStop = { deadlineMs: 1000, termGraceMs: 200 };
export async function fixture(
  mode = 'normal',
  healthMode = 'valid',
  { testClock = false, ...options }: Omit<SshOptions, 'verify'> & { testClock?: boolean } = {},
) {
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
    if (healthMode === 'auth') {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        hostId: healthMode === 'identity' ? 'other-host' : expected.hostId,
        storeId: expected.storeId,
        protocol: chatProtocolVersion,
        version: chatHostVersion,
        capabilities: ['chat-v0'],
      }),
    );
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
    const layer = SshLive(configuration, { verify, ...options });
    const runtime = ManagedRuntime.make(testClock ? Layer.merge(layer, TestClock.layer()) : layer);
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
    /** Moves the connection's `TestClock`, with `testClock` set. */
    advance: (duration: Parameters<typeof TestClock.adjust>[0]) =>
      current.runtime.runPromise(TestClock.adjust(duration)),
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

/** Runs the real `ssh -G` over a config that sets `flag`, and checks Connect refuses it when enabled. */
export async function checkSystemPolicy(flag: string, extra: string, enabled: boolean) {
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
}
