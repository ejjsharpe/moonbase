import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatCommand, ChatInput, ChatOutput, ChatTarget } from '@moonbase/contracts/chat';

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw Error('Condition did not settle.');
    await delay(20);
  }
}
export async function bounded<T>(promise: Promise<T>, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Did not settle in time.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A new parent folder; the daemon's data directory is `data` inside it. */
export async function temporaryRoot() {
  return realpath(await mkdtemp(join(tmpdir(), 'moonbase-daemon-')));
}

const entries = {
  faux: new URL('./faux-daemon.ts', import.meta.url).pathname,
  main: new URL('../src/main.ts', import.meta.url).pathname,
};
const noNetwork = new URL('./no-network.ts', import.meta.url).pathname;

export type DaemonProcess = ReturnType<typeof startDaemon>;
/** Starts a daemon on this Bun, with provider network refused. */
export function startDaemon(
  args: string[],
  { entry = 'faux', env = {} }: { entry?: keyof typeof entries; env?: Record<string, string> } = {},
) {
  const child = spawn(process.execPath, ['--preload', noNetwork, entries[entry], ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  });
  let output = '',
    errors = '';
  child.stdout.on('data', (bytes) => (output += bytes));
  child.stderr.on('data', (bytes) => (errors += bytes));
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const ready = new Promise<{ port: number; host: { hostId: string; storeId: string } }>(
    (resolve, reject) => {
      const data = () => {
        const line = output.split('\n').find((text) => text.includes('"event":"ready"'));
        if (!line) return;
        child.stdout.off('data', data);
        resolve(JSON.parse(line));
      };
      child.stdout.on('data', data);
      void exited.then(() => reject(Error('Daemon exited before ready: ' + errors)));
    },
  );
  ready.catch(() => {});
  return {
    child,
    exited,
    ready,
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      try {
        return await bounded(exited);
      } catch {
        child.kill('SIGKILL');
        return await bounded(exited);
      }
    },
  };
}

const hash = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
const mac = (token: string, ...parts: unknown[]) =>
  createHmac('sha256', token)
    .update(JSON.stringify(['moonbase-chat-v1', ...parts]))
    .digest('hex');

/**
 * A faux client of the existing authenticated HTTP protocol: a single-use challenge, then an
 * HMAC-signed request whose signed reply it checks.
 */
const streamMac = (token: string, ...parts: unknown[]) =>
  createHmac('sha256', token)
    .update(JSON.stringify(['moonbase-chat-stream-v1', ...parts]))
    .digest('hex');

export function createFauxClient(port: number, token: string) {
  const origin = `http://127.0.0.1:${port}`;
  async function grant() {
    const nonce = randomBytes(32).toString('base64url');
    const granted = await fetch(origin + '/v1/chat/challenge', {
      headers: {
        'X-Moonbase-Nonce': nonce,
        Authorization:
          'Moonbase-RPC-HMAC-SHA256 ' +
          mac(token, 'challenge-request', nonce, 'GET', '/v1/chat/challenge'),
      },
    });
    if (granted.status !== 200)
      throw Object.assign(Error('Challenge refused'), { status: granted.status });
    const text = await granted.text();
    if (
      granted.headers.get('x-moonbase-proof') !==
      mac(token, 'challenge-response', nonce, granted.status, hash(text))
    )
      throw Error('Challenge proof did not verify');
    return { nonce, challenge: (JSON.parse(text) as { challenge: string }).challenge };
  }
  async function command<K extends ChatCommand>(
    operation: K,
    input: ChatInput<K>,
  ): Promise<ChatOutput<K>> {
    const { nonce, challenge } = await grant();
    const body = JSON.stringify({ operation, input });
    const response = await fetch(origin + '/v1/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Moonbase-Nonce': nonce,
        'X-Moonbase-Challenge': challenge,
        Authorization:
          'Moonbase-RPC-HMAC-SHA256 ' +
          mac(token, 'request', nonce, challenge, 'POST', '/v1/chat', hash(body)),
      },
      body,
    });
    const text = await response.text();
    if (
      response.headers.get('x-moonbase-proof') !==
      mac(token, 'response', nonce, challenge, response.status, hash(text))
    )
      throw Error('Reply proof did not verify');
    const reply = JSON.parse(text) as
      | { ok: true; value: ChatOutput<K> }
      | { ok: false; error: { code: string } };
    if (!reply.ok) throw Object.assign(Error(reply.error.code), { code: reply.error.code });
    return reply.value;
  }
  /** Opens a watch and resolves once its first frame arrives; `close` ends it. */
  async function watch(target: ChatTarget) {
    const { nonce, challenge } = await grant();
    const body = JSON.stringify({ target, connectionId: 'faux-client' });
    const controller = new AbortController();
    const response = await fetch(origin + '/v1/chat/watch', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'X-Moonbase-Nonce': nonce,
        'X-Moonbase-Challenge': challenge,
        Authorization:
          'Moonbase-RPC-HMAC-SHA256 ' +
          streamMac(token, 'request', nonce, challenge, 'POST', '/v1/chat/watch', hash(body)),
      },
      body,
    });
    if (response.status !== 200) throw Error('Watch refused');
    const reader = response.body!.getReader();
    await reader.read();
    return {
      async close() {
        controller.abort();
        await reader.cancel().catch(() => {});
      },
    };
  }
  return { origin, command, watch };
}

/** A port free right now on 127.0.0.1, for a host-mode daemon's configured port. */
export async function findFreePort() {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const value = (server.address() as { port: number }).port;
      server.close(() => resolve(value));
    });
  });
}

export const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
