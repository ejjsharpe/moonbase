import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { ManagedRuntime, Layer } from 'effect';
import { makeChatClient, makeConnectionClient } from '@moonbase/application/runtime-client';
import { RemoteChatLive } from '@moonbase/pi-runtime/remote';
import { SshLive } from '@moonbase/ssh';
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
export async function fixture(hold = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-chat-proof-'))),
    cwd = join(directory, 'remote-folder');
  await mkdir(cwd);
  const session = {
      host: { hostId: 'controlled-host', storeId: 'controlled-store' },
      actorId: 'personal',
    },
    token = randomBytes(32).toString('hex'),
    configuration = join(directory, 'host.json'),
    log = join(directory, 'forward.jsonl'),
    drop = join(directory, 'drop-send'),
    executable = join(directory, 'controlled-ssh'),
    clientConfig = join(directory, 'client.json');
  await writeFile(
    configuration,
    JSON.stringify({ session, token, cwd, databasePath: join(directory, 'chat.sqlite'), hold }),
    { mode: 0o600 },
  );
  await writeFile(
    executable,
    '#!' +
      process.execPath +
      '\n' +
      (await readFile(new URL('../../../tests/chat/forward.mjs', import.meta.url), 'utf8')),
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
    host = fork(new URL('./host.mjs', import.meta.url), [configuration], {
      execArgv: ['--experimental-strip-types'],
      silent: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) =>
          ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE'].includes(k),
        ),
      ),
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
      const timer = setTimeout(() => reject(Error('Host startup deadline')), 10000);
      const receive = (m: unknown) => {
        const v = m as { event: string; origin: string };
        if (v.event === 'ready') {
          clearTimeout(timer);
          child.off('message', receive);
          resolve(v.origin);
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
  function profile() {
    return {
      id: 'proof',
      label: 'Controlled remote host',
      destination: 'controlled',
      remotePort: Number(new URL(origin).port),
      expected: session.host,
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
  function root() {
    const runtime = ManagedRuntime.make(
      RemoteChatLive.pipe(
        Layer.provideMerge(SshLive({ profile: profile(), token, sshExecutable: executable })),
      ),
    );
    roots.push(runtime);
    return { runtime, chat: makeChatClient(runtime), connection: makeConnectionClient(runtime) };
  }
  async function close() {
    try {
      host?.send({ type: 'release' });
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
      for (const r of results) if (r.status === 'rejected') throw r.reason;
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
    session,
    token,
    cwd,
    clientConfig,
    log,
    drop,
    root,
    startHost,
    stopHost,
    close,
    release: () => host!.send({ type: 'release' }),
    loseNextSend: () => writeFile(drop, ''),
    holdReply: async (operation: string) => {
      host!.send({ type: 'hold-reply', operation });
      await until(stats, (s) => s.replyOperation === operation);
    },
    releaseReply: () => host!.send({ type: 'release-reply' }),
    stats,
  };
}
