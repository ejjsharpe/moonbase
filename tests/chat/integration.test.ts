import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { ManagedRuntime, Layer } from 'effect';
import { makeChatClient, makeConnectionClient } from '@moonbase/application/runtime-client';
import type { ApplicationError } from '@moonbase/application/client';
import type { ChatSnapshot } from '@moonbase/application/chat-client';
import { RemoteChatLive } from '@moonbase/pi-runtime/remote';
import { SshLive } from '@moonbase/ssh';

type HostStats = {
  calls: number;
  commands: string[];
  replyOperation?: string;
  heldReplies: string[];
};
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('Public integration state did not settle');
}
async function fixture(t: { after(fn: () => Promise<void>): void }, hold = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-chat-fanin-'))),
    cwd = join(directory, 'remote-context');
  await mkdir(cwd);
  const token = randomBytes(32).toString('hex'),
    session = {
      host: { hostId: 'controlled-host', storeId: 'controlled-store' },
      actorId: 'personal',
    };
  const configuration = join(directory, 'private.json'),
    log = join(directory, 'forward.jsonl'),
    executable = join(directory, 'controlled-ssh'),
    dropSend = join(directory, 'drop-next-send');
  await writeFile(
    configuration,
    JSON.stringify({ session, token, cwd, databasePath: join(directory, 'chat.sqlite'), hold }),
    { mode: 0o600 },
  );
  assert(!/\s/.test(process.execPath));
  await writeFile(
    executable,
    '#!' +
      process.execPath +
      '\n' +
      (await readFile(new URL('./forward.mjs', import.meta.url), 'utf8')),
  );
  await chmod(executable, 0o700);
  const previousLog = process.env.MOONBASE_CHAT_FORWARD_LOG,
    previousDrop = process.env.MOONBASE_CHAT_DROP_SEND;
  process.env.MOONBASE_CHAT_FORWARD_LOG = log;
  process.env.MOONBASE_CHAT_DROP_SEND = dropSend;
  const requests = new Map<string, (value: HostStats) => void>();
  let host: ChildProcess | undefined,
    hostOrigin = '';
  const roots: { runtime: { dispose(): Promise<void> } }[] = [];
  async function startHost() {
    const child = fork(new URL('./host.mjs', import.meta.url), [configuration], {
      execArgv: ['--experimental-strip-types'],
      silent: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE'].includes(key),
        ),
      ),
    });
    host = child;
    child.stderr?.resume();
    child.stdout?.resume();
    child.on('message', (message: unknown) => {
      const value = message as HostStats & { id?: string };
      if (value.id) {
        requests.get(value.id)?.(value);
        requests.delete(value.id);
      }
    });
    hostOrigin = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Controlled host startup timed out')), 10000);
      const receive = (message: unknown) => {
        const value = message as { event?: string; origin?: string };
        if (value.event === 'ready') {
          clearTimeout(timeout);
          child.off('message', receive);
          resolve(value.origin!);
        } else if (value.event === 'failed') {
          clearTimeout(timeout);
          reject(Error('Controlled host failed'));
        }
      };
      child.on('message', receive);
      child.once('exit', () => {
        clearTimeout(timeout);
        reject(Error('Controlled host exited before ready'));
      });
    });
  }
  async function stopHost() {
    const child = host;
    if (!child) return;
    host = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(Error('Controlled host shutdown timed out'));
      }, 10000);
      child.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.send({ type: 'shutdown' });
    });
  }
  function root(expected = session.host) {
    const profile = {
      id: 'one-profile',
      label: 'Controlled forward',
      destination: 'controlled',
      remotePort: Number(new URL(hostOrigin).port),
      expected,
    };
    const runtime = ManagedRuntime.make(
      RemoteChatLive.pipe(
        Layer.provideMerge(SshLive({ profile, token, sshExecutable: executable })),
      ),
    );
    const value = {
      runtime,
      profile,
      chat: makeChatClient(runtime),
      connection: makeConnectionClient(runtime),
    };
    roots.push(value);
    return value;
  }
  t.after(async () => {
    try {
      if (host?.connected) {
        host.send({ type: 'release' });
        host.send({ type: 'release-reply' });
      }
      const disposed = await Promise.allSettled(roots.map((value) => value.runtime.dispose()));
      await stopHost();
      const records = await readFile(log, 'utf8').then(
        (text) =>
          text
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { pid: number; event: string; port?: number }),
        () => [],
      );
      for (const pid of new Set(records.map((row) => row.pid)))
        assert.throws(
          () => process.kill(pid, 0),
          (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
        );
      for (const port of new Set(records.flatMap((row) => (row.port ? [row.port] : []))))
        await new Promise<void>((resolve, reject) => {
          const server = createServer();
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        });
      const failed = disposed.filter((value) => value.status === 'rejected');
      if (failed.length)
        throw new AggregateError(
          failed.map((value) => value.reason),
          'Client cleanup failed',
        );
    } finally {
      if (previousLog === undefined) delete process.env.MOONBASE_CHAT_FORWARD_LOG;
      else process.env.MOONBASE_CHAT_FORWARD_LOG = previousLog;
      if (previousDrop === undefined) delete process.env.MOONBASE_CHAT_DROP_SEND;
      else process.env.MOONBASE_CHAT_DROP_SEND = previousDrop;
      await rm(directory, { recursive: true, force: true });
    }
  });
  await startHost();
  const stats = () =>
    new Promise<HostStats>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(Error('Host observation timed out'));
      }, 2000);
      requests.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      host!.send({ type: 'stats', id });
    });
  return {
    session,
    cwd,
    token,
    log,
    root,
    stopHost,
    startHost,
    loseNextSend: () => writeFile(dropSend, ''),
    release: () => host!.send({ type: 'release' }),
    stats,
    holdReply: async (operation: string) => {
      host!.send({ type: 'hold-reply', operation });
      await until(stats, (value) => value.replyOperation === operation);
    },
    releaseReply: async () => {
      host!.send({ type: 'release-reply' });
      await until(stats, (value) => value.replyOperation === undefined);
    },
  };
}

test('combined public root requires explicit verified Connect, then saves/lists/streams a chat through controlled forwarding', async (t) => {
  const f = await fixture(t),
    client = f.root();
  assert.equal((await client.connection.command('getConnection', {})).state, 'disconnected');
  await assert.rejects(client.chat.command('getChatHost', { host: f.session.host }), {
    code: 'Unavailable',
  });
  const connected = await client.connection.command('connect', { profileId: client.profile.id });
  assert.equal(connected.state, 'connected');
  assert(!JSON.stringify(connected).includes(f.token));
  assert(!JSON.stringify(connected).includes('http://'));
  assert.equal((await client.chat.command('getChatHost', { host: f.session.host })).cwd, f.cwd);
  const input = { session: f.session, requestId: 'create-one', title: 'Saved remote chat' };
  const created = await client.chat.command('createChat', input);
  assert.deepEqual(await client.chat.command('createChat', input), created);
  assert.equal(
    (await client.chat.command('listChats', { session: f.session })).conversations.length,
    1,
  );
  const target = created.conversation.target,
    snapshots: ChatSnapshot[] = [],
    errors: ApplicationError[] = [];
  const unsubscribe = client.chat.watch(
    { target },
    (value) => snapshots.push(value),
    (error) => errors.push(error),
  );
  await client.chat.command('sendChat', { target, requestId: 'send-one', text: 'Send once' });
  await until(
    () => client.chat.command('getChat', { target }),
    (value) => !value.run && value.entries.some((entry) => entry.text === 'REMOTE COMPLETED'),
  );
  await until(
    async () => snapshots,
    (value) =>
      value.some((snapshot) => snapshot.entries.some((entry) => entry.text === 'REMOTE COMPLETED')),
  );
  unsubscribe();
  assert.deepEqual(errors, []);
  assert.equal((await f.stats()).calls, 1);
  const children = (await readFile(f.log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string });
  assert.equal(
    children.filter((row) => row.event === 'forward').length,
    1,
    'Chat and Connection clients share one acquired transport',
  );
});

test('lost HTTP Send response and client closure retain original receipt; reconnect/store reopen do not Send again', async (t) => {
  const f = await fixture(t, true),
    first = f.root();
  await first.connection.command('connect', { profileId: first.profile.id });
  const created = await first.chat.command('createChat', {
      session: f.session,
      requestId: 'create',
      title: 'Retained',
    }),
    target = created.conversation.target;
  const input = { target, requestId: 'immutable-send', text: 'Only one admitted input' };
  await f.loseNextSend();
  await assert.rejects(first.chat.command('sendChat', input), { code: 'Uncertain' });
  await until(f.stats, (value) => value.calls === 1);
  await first.runtime.dispose();
  f.release();
  const second = f.root();
  await second.connection.command('connect', { profileId: second.profile.id });
  const receipt = await second.chat.command('getChatSend', { target, requestId: input.requestId });
  assert.equal(receipt?.admission, 'admitted');
  await until(
    () => second.chat.command('getChat', { target }),
    (value) => !value.run && value.entries.some((entry) => entry.text === 'REMOTE COMPLETED'),
  );
  assert.equal((await f.stats()).commands.filter((name) => name === 'sendChat').length, 1);
  assert.equal(
    (await readFile(f.log, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('drop-send-response')).length,
    1,
  );
  await second.runtime.dispose();
  await f.stopHost();
  await f.startHost();
  const third = f.root();
  await third.connection.command('connect', { profileId: third.profile.id });
  assert.deepEqual(
    await third.chat.command('getChatSend', { target, requestId: input.requestId }),
    receipt,
  );
  const state = await third.chat.command('getChat', { target });
  assert.equal(
    state.entries.filter((entry) => entry.role === 'user' && entry.text === input.text).length,
    1,
  );
  assert.equal((await f.stats()).calls, 0);
});

test('disconnect denies commands without implicit reconnect; stale Disconnect and captured cooperative Stop preserve exact generations', async (t) => {
  const f = await fixture(t, true),
    first = f.root();
  const old = await first.connection.command('connect', { profileId: first.profile.id });
  assert.equal(old.state, 'connected');
  const created = await first.chat.command('createChat', {
      session: f.session,
      requestId: 'create',
      title: 'Stop exact work',
    }),
    target = created.conversation.target;
  await first.chat.command('sendChat', { target, requestId: 'send', text: 'Held work' });
  const run = await until(
      () => first.chat.command('getChat', { target }),
      (state) => !!state.run,
    ),
    stop = run.run!.stop;
  await first.connection.command('disconnect', { connectionId: old.connectionId! });
  await assert.rejects(first.chat.command('getChat', { target }), { code: 'Unavailable' });
  assert.equal((await first.connection.command('getConnection', {})).state, 'disconnected');
  const current = await first.connection.command('connect', { profileId: first.profile.id });
  assert.notEqual(current.connectionId, old.connectionId);
  await assert.rejects(
    first.connection.command('disconnect', { connectionId: old.connectionId! }),
    { code: 'Conflict' },
  );
  assert.equal((await first.connection.command('getConnection', {})).state, 'connected');
  const result = await first.chat.command('stopChat', { stop, requestId: 'stop-exact' });
  assert.deepEqual(result.stop, stop);
  assert(['pending', 'stopped', 'terminal'].includes(result.outcome));
  f.release();
  await until(
    () => first.chat.command('getChat', { target }),
    (value) => value.run === null,
  );
  assert.equal((await f.stats()).commands.filter((name) => name === 'sendChat').length, 1);
});

test('a signed health reply for another exact host cannot connect or expose a chat endpoint', async (t) => {
  const f = await fixture(t),
    wrong = f.root({ ...f.session.host, hostId: 'other-host' });
  await assert.rejects(wrong.connection.command('connect', { profileId: wrong.profile.id }), {
    code: 'Incompatible',
  });
  assert.equal((await wrong.connection.command('getConnection', {})).state, 'failed');
  await assert.rejects(wrong.chat.command('getChatHost', { host: wrong.profile.expected }));
  assert.equal((await f.stats()).calls, 0);
  assert((await f.stats()).commands.every((name) => name === 'getChatHost'));
});

for (const operation of ['createChat', 'sendChat', 'stopChat'] as const)
  test(`Disconnect after committed ${operation} preserves uncertainty and original identity across real forwarding teardown`, async (t) => {
    const f = await fixture(t, true),
      client = f.root();
    const connected = await client.connection.command('connect', { profileId: client.profile.id });
    const create = {
      session: f.session,
      requestId: 'captured-create',
      title: 'Captured conversation',
    };
    const created =
      operation === 'createChat' ? undefined : await client.chat.command('createChat', create);
    const target = created?.conversation.target;
    const send = {
      target: target!,
      requestId: 'captured-send',
      text: 'Exactly one admitted input',
    };
    const stop =
      operation === 'stopChat'
        ? await (async () => {
            await client.chat.command('sendChat', send);
            return (
              await until(
                () => client.chat.command('getChat', { target: target! }),
                (value) => !!value.run?.stop.taskId,
              )
            ).run!.stop;
          })()
        : undefined;
    await f.holdReply(operation);
    let work;
    if (operation === 'createChat') work = client.chat.command('createChat', create);
    else if (operation === 'sendChat') work = client.chat.command('sendChat', send);
    else work = client.chat.command('stopChat', { stop: stop!, requestId: 'captured-stop' });
    const outcome = work.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await until(f.stats, (value) => value.heldReplies.includes(operation));
    assert.equal(
      (await client.connection.command('getConnection', {})).state,
      'connected',
      'unrelated commands remain responsive while the mutation reply is held',
    );
    await client.connection.command('disconnect', { connectionId: connected.connectionId! });
    assert.equal((await client.connection.command('getConnection', {})).state, 'disconnected');
    const result = await outcome;
    assert.equal(
      (result.error as ApplicationError)?.code,
      'Uncertain',
      'dispatch may have committed; retain the original identity',
    );
    assert.equal((await f.stats()).commands.filter((name) => name === operation).length, 1);
    await f.releaseReply();
    const next = await client.connection.command('connect', { profileId: client.profile.id });
    assert.notEqual(next.connectionId, connected.connectionId);
    if (operation === 'createChat') {
      const listed = await client.chat.command('listChats', { session: f.session });
      assert.equal(listed.conversations.length, 1);
      const retried = await client.chat.command('createChat', create);
      assert.deepEqual(retried.conversation.target, listed.conversations[0]!.target);
      assert.equal(
        (await client.chat.command('listChats', { session: f.session })).conversations.length,
        1,
      );
      assert.equal((await f.stats()).calls, 0);
    } else {
      const receipt = await client.chat.command('getChatSend', {
        target: target!,
        requestId: send.requestId,
      });
      assert.equal(receipt?.admission, 'admitted');
      if (operation === 'stopChat') {
        const retried = await client.chat.command('stopChat', {
          stop: stop!,
          requestId: 'captured-stop',
        });
        assert.deepEqual(retried.stop, stop);
      }
      f.release();
      await until(
        () => client.chat.command('getChat', { target: target! }),
        (value) => !value.run,
      );
      const snapshot = await client.chat.command('getChat', { target: target! });
      assert.equal(
        snapshot.entries.filter((entry) => entry.role === 'user' && entry.text === send.text)
          .length,
        1,
      );
      assert.equal(
        (await f.stats()).commands.filter((name) => name === 'sendChat').length,
        1,
        'reconnect and receipt lookup never resend',
      );
      assert.equal((await f.stats()).calls, 1);
    }
  });
