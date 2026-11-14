import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { ManagedRuntime, Layer } from 'effect';
import {
  makeChatClient,
  makeConnectionClient,
  makeProviderSetupClient,
} from '@moonbase/application/runtime/clients';
import {
  RemoteChatLive,
  RemoteLocalHostLive,
  RemoteProviderSetupLive,
} from '@moonbase/daemon-protocol/remote';
import { LocalHostService } from '@moonbase/contracts/services';
import { SshLive } from '@moonbase/ssh';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { fauxModel } from './faux-model.ts';

async function findFreePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
export async function until<T>(get: () => Promise<T>, ready: (v: T) => boolean) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const v = await get();
    if (ready(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error('Controlled state did not settle');
}
export type FixtureStats = {
  watches: number;
  publications: number;
  activeWatches: number;
  reads?: {
    scans: number;
    entries: number;
    inspections: number;
    ranges?: { limit: number; min: string | null; max: string | null; rows: number }[];
  };
  seeded?: { target: ChatTarget; ids: string[] };
  longSeeded?: { target: ChatTarget; entryId: string; bytes: number; units: number; late: number };
  seedError?: string;
  calls: number;
  tools: number;
  commands: string[];
  heldReplies: string[];
  replyOperation?: string;
  mutations: { operation: string; input: unknown; result: unknown }[];
};
export type CleanupReport = {
  hostPids: number[];
  forwardPids: number[];
  processGroups: number[];
  reboundPorts: number[];
};
const daemonEntry = new URL('./daemon-host.ts', import.meta.url).pathname;
const noNetwork = new URL('../../apps/daemon/test/no-network.ts', import.meta.url).pathname;
/**
 * A controlled remote host: the daemon in host mode in temporary data, on Bun, with the faux
 * providers and tools of `behaviour` (a `faux-*.mjs` module), reached through `forward.mjs` in
 * place of OpenSSH. Its approved root is `cwd`; chats choose `model`.
 */
export async function controlledHostFixture(behaviour: URL, hold = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-chat-test-'))),
    cwd = join(directory, 'remote-folder'),
    data = join(directory, 'data');
  await mkdir(cwd);
  await mkdir(data, { mode: 0o700 });
  const session = {
      host: { hostId: 'controlled-host', storeId: 'controlled-store' },
      actorId: 'personal',
    },
    token = randomBytes(32).toString('hex'),
    port = await findFreePort(),
    log = join(directory, 'forward.jsonl'),
    drop = join(directory, 'drop-send'),
    executable = join(directory, 'controlled-ssh'),
    clientConfig = join(directory, 'client.json');
  // The host's identity and token are provisioned as for a real host; the client holds the token.
  const write = (name: string, value: unknown) =>
    writeFile(join(data, name), typeof value === 'string' ? value : JSON.stringify(value), {
      mode: 0o600,
    });
  await write('identity.json', session);
  await write('token', token);
  await write('daemon.json', {
    mode: 'host',
    port,
    approvedRoots: [cwd],
    credentialKey: { source: 'file', path: join(directory, 'credential.key') },
  });
  await write('fixture.json', { behaviour: behaviour.pathname, hold });
  if (/\s/.test(process.execPath)) throw Error('Controlled executable path contains whitespace');
  await writeFile(
    executable,
    '#!' +
      process.execPath +
      '\n' +
      (await readFile(new URL('./forward.mjs', import.meta.url), 'utf8')),
  );
  await chmod(executable, 0o700);
  const oldLog = process.env.MOONBASE_CHAT_FORWARD_LOG,
    oldDrop = process.env.MOONBASE_CHAT_DROP_SEND;
  process.env.MOONBASE_CHAT_FORWARD_LOG = log;
  process.env.MOONBASE_CHAT_DROP_SEND = drop;
  const roots: { dispose: () => Promise<void> }[] = [],
    requests = new Map<string, (v: FixtureStats) => void>();
  const hostPids: number[] = [],
    hostPorts: number[] = [];
  let host: ChildProcess | undefined,
    origin = '';
  async function startHost() {
    host = fork(daemonEntry, [data], {
      execPath: 'bun',
      // As the app runs the daemon: no `.env`, `bunfig.toml` or auto-install; no provider network.
      execArgv: ['--no-env-file', '--config=/dev/null', '--no-install', '--preload', noNetwork],
      cwd: data,
      silent: true,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) =>
            ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE'].includes(k),
          ),
        ),
        WS_NO_BUFFER_UTIL: '1',
        WS_NO_UTF_8_VALIDATE: '1',
      },
    });
    hostPids.push(host.pid!);
    host.stderr?.resume();
    host.stdout?.resume();
    host.on('message', (m: unknown) => {
      const v = m as FixtureStats & { id?: string };
      if (v.id) {
        requests.get(v.id)?.(v);
        requests.delete(v.id);
      }
    });
    const child = host;
    origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Host startup deadline')), 20000);
      const receive = (m: unknown) => {
        const v = m as { event: string; port: number };
        if (v.event === 'ready') {
          clearTimeout(timer);
          child.off('message', receive);
          resolve(`http://127.0.0.1:${v.port}`);
        }
        if (v.event === 'failed') {
          clearTimeout(timer);
          reject(Error('Controlled host failed'));
        }
      };
      child.on('message', receive);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(Error('Host early exit'));
      });
    });
    hostPorts.push(Number(new URL(origin).port));
    await writeFile(
      clientConfig,
      JSON.stringify({
        profile: profile(),
        token,
        actorId: session.actorId,
        sshExecutable: executable,
      }),
      { mode: 0o600 },
    );
  }
  function profile(expected = session.host) {
    return {
      id: 'controlled-chat',
      label: 'Controlled remote host',
      destination: 'controlled',
      remotePort: Number(new URL(origin).port),
      expected,
    };
  }
  async function stopHost() {
    const child = host;
    if (!child) return;
    host = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('Host shutdown deadline'));
      }, 10000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.send({ type: 'shutdown' });
    });
  }
  function root(expected = session.host) {
    const configuredProfile = profile(expected);
    // The clients a remote desktop composes: chat, folders and provider setup over one forward.
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        RemoteChatLive,
        RemoteLocalHostLive,
        RemoteProviderSetupLive({
          host: expected,
          sameMachine: false,
          openUrl: async () => {},
        }),
      ).pipe(
        Layer.provideMerge(
          SshLive({ profile: configuredProfile, token, sshExecutable: executable }),
        ),
      ),
    );
    roots.push(runtime);
    return {
      runtime,
      profile: configuredProfile,
      chat: makeChatClient(runtime),
      connection: makeConnectionClient(runtime),
      providers: (ownerId: string) => makeProviderSetupClient(runtime, ownerId),
      folders: () => runtime.runPromise(LocalHostService),
    };
  }
  async function close() {
    try {
      if (host?.connected) {
        host.send({ type: 'release' });
        host.send({ type: 'release-reply' });
      }
      const results = await Promise.allSettled(roots.map((r) => r.dispose()));
      await stopHost();
      const records = await readFile(log, 'utf8').then(
        (s) =>
          s
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { pid: number; port?: number }),
        () => [],
      );
      const forwardPids = [...new Set(records.map((r) => r.pid))],
        reboundPorts = [
          ...new Set([...hostPorts, ...records.flatMap((r) => (r.port ? [r.port] : []))]),
        ];
      for (const pid of [...hostPids, ...forwardPids])
        await until(async () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (e) {
            return (e as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }, Boolean);
      for (const group of forwardPids)
        await until(async () => {
          try {
            process.kill(-group, 0);
            return false;
          } catch (e) {
            return (e as NodeJS.ErrnoException).code === 'ESRCH';
          }
        }, Boolean);
      for (const port of reboundPorts)
        await new Promise<void>((resolve, reject) => {
          const server = createServer();
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => server.close((e) => (e ? reject(e) : resolve())));
        });
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length)
        throw new AggregateError(
          failed.map((r) => r.reason),
          'Client cleanup failed',
        );
      return {
        hostPids,
        forwardPids,
        processGroups: forwardPids,
        reboundPorts,
      } satisfies CleanupReport;
    } finally {
      if (oldLog === undefined) delete process.env.MOONBASE_CHAT_FORWARD_LOG;
      else process.env.MOONBASE_CHAT_FORWARD_LOG = oldLog;
      if (oldDrop === undefined) delete process.env.MOONBASE_CHAT_DROP_SEND;
      else process.env.MOONBASE_CHAT_DROP_SEND = oldDrop;
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    await startHost();
  } catch (error) {
    await close();
    throw error;
  }
  const stats = () =>
    new Promise<FixtureStats>((resolve, reject) => {
      const id = randomUUID(),
        timer = setTimeout(() => {
          requests.delete(id);
          reject(Error('Stats deadline'));
        }, 2000);
      requests.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      host!.send({ type: 'stats', id });
    });
  return {
    directory,
    data,
    session,
    token,
    cwd,
    model: fauxModel,
    /** Settings for a new chat in the host's approved root. */
    settings: { cwd, model: fauxModel },
    clientConfig,
    log,
    drop,
    root,
    startHost,
    stopHost,
    close,
    release: () => host!.send({ type: 'release' }),
    nextChunk: () => host!.send({ type: 'next-chunk' }),
    seedHistory: async (target: ChatTarget) => {
      host!.send({ type: 'seed-history', target });
      const result = await until(
        stats,
        (value) =>
          !!value.seedError || value.seeded?.target.conversationId === target.conversationId,
      );
      if (result.seedError) throw Error(result.seedError);
      return result.seeded!.ids;
    },
    seedLongText: async (target: ChatTarget) => {
      host!.send({ type: 'seed-long-text', target });
      const result = await until(
        stats,
        (value) =>
          !!value.seedError || value.longSeeded?.target.conversationId === target.conversationId,
      );
      if (result.seedError) throw Error(result.seedError);
      return result.longSeeded!;
    },
    loseNextSend: () => writeFile(drop, ''),
    loseNextReply: (operation: string) => writeFile(drop, operation),
    tamperNextReply: (operation: string) => writeFile(drop, 'tamper:' + operation),
    holdReply: async (operation: string) => {
      host!.send({ type: 'hold-reply', operation });
      await until(stats, (s) => s.replyOperation === operation);
    },
    releaseReply: async () => {
      host!.send({ type: 'release-reply' });
      await until(stats, (s) => s.replyOperation === undefined);
    },
    stats,
  };
}
