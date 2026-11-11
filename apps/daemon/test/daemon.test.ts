import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { decodeDaemonSettings } from '@moonbase/pi-runtime/host-configuration';
import {
  bounded,
  createFauxClient,
  findFreePort,
  readJson,
  startDaemon,
  temporaryRoot,
  until,
  type DaemonProcess,
} from './fixture.ts';
import { fauxModelId, fauxProviderId, type FauxScript } from './faux.ts';

const model = { provider: fauxProviderId, modelId: fauxModelId };
const mode = async (path: string) => (await lstat(path)).mode & 0o777;

async function withRoot(run: (root: string, started: DaemonProcess[]) => Promise<void>) {
  const root = await temporaryRoot(),
    started: DaemonProcess[] = [];
  try {
    await run(root, started);
  } finally {
    await Promise.all(started.map((daemon) => daemon.stop('SIGKILL')));
    await rm(root, { recursive: true, force: true });
  }
}
const writeHostSettings = async (directory: string, roots: string[], key: string) =>
  writeFile(
    join(directory, 'daemon.json'),
    JSON.stringify({
      mode: 'host',
      port: await findFreePort(),
      approvedRoots: roots,
      credentialKey: { source: 'file', path: key },
    }),
    { mode: 0o600 },
  );
test('host settings name each approved root by an absolute path, none under another', () => {
  const settings = (approvedRoots: string[]) => ({
    mode: 'host',
    port: 8787,
    approvedRoots,
    credentialKey: { source: 'file', path: '/keys/credential.key' },
  });
  assert.deepEqual(
    decodeDaemonSettings(settings(['/work', '/other'])),
    settings(['/work', '/other']),
  );
  for (const roots of [['work'], ['/work', '/work/inner']])
    assert.throws(() => decodeDaemonSettings(settings(roots)), { code: 'InvalidInput' });
});
const writeScript = (directory: string, script: FauxScript) =>
  writeFile(join(directory, 'faux.json'), JSON.stringify(script));

test('a daemon makes a private data directory, prints ready, writes endpoint.json and refuses a second instance', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data');
    const first = startDaemon([directory]);
    started.push(first);
    const ready = await bounded(first.ready);
    assert.equal(first.output.trim().split('\n').length, 1, 'one ready line on stdout');
    assert.equal(await mode(directory), 0o700);
    for (const file of ['identity.json', 'token', 'endpoint.json', 'daemon.lock', 'chat.sqlite'])
      assert.equal(await mode(join(directory, file)), 0o600, file);
    assert.equal(await mode(join(directory, 'logs')), 0o700);
    const endpoint = await readJson(join(directory, 'endpoint.json'));
    assert.deepEqual(endpoint, {
      port: ready.port,
      pid: first.child.pid,
      version: '0.1.0',
      protocol: 2,
      build: 'development',
    });
    const identity = await readJson(join(directory, 'identity.json'));
    assert.deepEqual(ready.host, identity.host);
    const token = (await readFile(join(directory, 'token'), 'utf8')).trim();
    assert.ok(Buffer.from(token, 'base64url').length >= 32);
    assert.ok(!first.output.includes(token));

    const second = startDaemon([directory]);
    started.push(second);
    const [code] = await bounded(second.exited);
    assert.equal(code, 1);
    assert.match(second.errors, /already running/);
    assert.ok(!second.errors.includes(directory));
    assert.ok(!second.output.includes('ready'));
    // The first daemon is untouched: still listening, same endpoint.
    assert.deepEqual(await readJson(join(directory, 'endpoint.json')), endpoint);
    const client = createFauxClient(ready.port, token, identity.host);
    assert.deepEqual(await client.command('getChatHost', { host: identity.host }), {
      host: identity.host,
      actorId: identity.actorId,
      mode: 'local',
    });

    assert.deepEqual(await first.stop('SIGTERM'), [0, null]);
    await assert.rejects(stat(join(directory, 'endpoint.json')), { code: 'ENOENT' });
    // A restart keeps the identity and token it made once.
    const again = startDaemon([directory]);
    started.push(again);
    assert.deepEqual((await bounded(again.ready)).host, identity.host);
    assert.equal((await readFile(join(directory, 'token'), 'utf8')).trim(), token);
    assert.deepEqual(await again.stop('SIGINT'), [0, null]);
    await assert.rejects(stat(join(directory, 'endpoint.json')), { code: 'ENOENT' });
  });
});

test('chat commands work through the authenticated WebSocket, and logs keep no token or chat text', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data'),
      canary = 'private-chat-canary-' + randomBytes(8).toString('hex');
    await mkdir(directory, { mode: 0o700 });
    await writeScript(directory, { steps: [{ reply: 'Reply ' + canary }] });
    const daemon = startDaemon([directory]);
    started.push(daemon);
    const { port } = await bounded(daemon.ready);
    const token = (await readFile(join(directory, 'token'), 'utf8')).trim(),
      identity = await readJson(join(directory, 'identity.json')),
      session = { host: identity.host, actorId: identity.actorId };
    const client = createFauxClient(port, token, identity.host);

    // Wrong token: the daemon closes the connection at its hello, before any command runs.
    await assert.rejects(
      createFauxClient(port, 'x'.repeat(43), identity.host).command('listChats', { session }),
      { code: 'Unavailable' },
    );
    const created = await client.command('createChat', {
      session,
      requestId: 'create-one',
      title: 'Chat ' + canary,
      settings: { model },
    });
    const target: ChatTarget = created.conversation.target;
    assert.equal(created.conversation.ownFolder, true);
    assert.equal((await readdir(join(directory, 'chats'))).length, 1);
    // A folder no client approved is refused.
    await assert.rejects(
      client.command('createChat', {
        session,
        requestId: 'create-unapproved',
        title: 'Unapproved',
        settings: { model, cwd: root },
      }),
      { code: 'Unauthorized' },
    );
    const receipt = await client.command('sendChat', {
      target,
      requestId: 'send-one',
      text: 'Hello ' + canary,
    });
    assert.equal(receipt.admission, 'admitted');
    const snapshot = await until(
      () => client.command('getChat', { target }),
      (value) => !value.run && value.entries.some((entry) => entry.text === 'Reply ' + canary),
    );
    assert.equal(snapshot.entries.filter((entry) => entry.role === 'user').length, 1);
    assert.deepEqual(
      await client.command('getChatSend', { target, requestId: 'send-one' }),
      receipt,
    );
    const listed = await client.command('listChats', { session });
    assert.deepEqual(
      listed.conversations.map((chat) => chat.target.conversationId),
      [target.conversationId],
    );
    assert.deepEqual(await daemon.stop(), [0, null]);

    const logs = await readdir(join(directory, 'logs'));
    assert.deepEqual(logs, ['daemon.log']);
    const text = await readFile(join(directory, 'logs', 'daemon.log'), 'utf8');
    assert.match(text, /"event":"ready"/);
    assert.match(text, /"event":"stopped"/);
    for (const secret of [token, canary, 'Hello', identity.actorId])
      assert.ok(!text.includes(secret), 'log leaks ' + secret.slice(0, 12));
    assert.ok(!daemon.output.includes(canary) && !daemon.errors.includes(canary));
    assert.ok(!daemon.errors.includes(token));
  });
});

test('a daemon killed during a run resumes the run on its next start', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data');
    await mkdir(directory, { mode: 0o700 });
    await writeScript(directory, { steps: [{ hold: true }] });
    const first = startDaemon([directory]);
    started.push(first);
    const { port } = await bounded(first.ready);
    const token = (await readFile(join(directory, 'token'), 'utf8')).trim(),
      identity = await readJson(join(directory, 'identity.json')),
      session = { host: identity.host, actorId: identity.actorId };
    let client = createFauxClient(port, token, identity.host);
    const target = (
      await client.command('createChat', {
        session,
        requestId: 'create',
        title: 'Interrupted',
        settings: { model },
      })
    ).conversation.target;
    const receipt = await client.command('sendChat', {
      target,
      requestId: 'original',
      text: 'One original input',
    });
    const calls = async () =>
      (await readFile(join(directory, 'faux-calls.jsonl'), 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean).length;
    await until(calls, (count) => count === 1);
    assert.equal((await client.command('getChat', { target })).state, 'running');

    assert.equal((await first.stop('SIGKILL'))[1], 'SIGKILL');

    await writeScript(directory, { steps: [] });
    const second = startDaemon([directory]);
    started.push(second);
    const ready = await bounded(second.ready);
    assert.deepEqual(await readJson(join(directory, 'endpoint.json')), {
      port: ready.port,
      pid: second.child.pid,
      version: '0.1.0',
      protocol: 2,
      build: 'development',
    });
    client = createFauxClient(ready.port, token, identity.host);
    assert.deepEqual(
      await client.command('getChatSend', { target, requestId: 'original' }),
      receipt,
    );
    const resumed = await until(
      () => client.command('getChat', { target }),
      (value) => !value.run && value.entries.some((entry) => entry.text === 'Faux reply'),
    );
    assert.equal(resumed.entries.filter((entry) => entry.role === 'user').length, 1);
    assert.equal(await calls(), 2);
    assert.deepEqual(await second.stop(), [0, null]);
  });
});

test('a local daemon left unused exits by itself and removes endpoint.json', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data');
    await mkdir(directory, { mode: 0o700 });
    await writeScript(directory, { idleMs: 400, pollMs: 100 });
    const daemon = startDaemon([directory]);
    started.push(daemon);
    await bounded(daemon.ready);
    assert.deepEqual(await bounded(daemon.exited), [0, null]);
    await assert.rejects(stat(join(directory, 'endpoint.json')), { code: 'ENOENT' });
    assert.match(
      await readFile(join(directory, 'logs', 'daemon.log'), 'utf8'),
      /"event":"stopped","reason":"idle"/,
    );
  });
});

test('the real local entry starts with a private key file and never needs the Keychain to serve', async () => {
  await withRoot(async (root, started) => {
    const directory = join(root, 'data'),
      keys = join(root, 'keys');
    await mkdir(directory, { mode: 0o700 });
    await mkdir(keys, { mode: 0o700 });
    await writeFile(join(keys, 'key'), randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
    await writeFile(
      join(directory, 'daemon.json'),
      JSON.stringify({ mode: 'local', credentialKey: { source: 'file', path: join(keys, 'key') } }),
      { mode: 0o600 },
    );
    const daemon = startDaemon([directory], { entry: 'main' });
    started.push(daemon);
    const { port } = await bounded(daemon.ready);
    const token = (await readFile(join(directory, 'token'), 'utf8')).trim(),
      identity = await readJson(join(directory, 'identity.json'));
    const host = await createFauxClient(port, token, identity.host).command('getChatHost', {
      host: identity.host,
    });
    assert.ok('mode' in host && host.mode === 'local');
    assert.deepEqual(await daemon.stop(), [0, null]);
  });
});

type Refusal = {
  name: string;
  prepare(root: string, directory: string, secret: string): Promise<string[] | void>;
};
const refusals: Refusal[] = [
  {
    name: 'a directory others can read',
    prepare: async (_root, directory) => {
      await mkdir(directory);
      await chmod(directory, 0o755);
    },
  },
  {
    name: 'a symlinked directory',
    prepare: async (root, directory) => {
      await mkdir(join(root, 'real'), { mode: 0o700 });
      await symlink(join(root, 'real'), directory);
    },
  },
  {
    name: 'an identity others can read',
    prepare: async (_root, directory, secret) => {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'identity.json'), secret, { mode: 0o644 });
    },
  },
  {
    name: 'a short token',
    prepare: async (_root, directory) => {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'token'), 'too-short', { mode: 0o600 });
    },
  },
  {
    name: 'a symlinked token',
    prepare: async (root, directory, secret) => {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(root, 'elsewhere'), secret, { mode: 0o600 });
      await symlink(join(root, 'elsewhere'), join(directory, 'token'));
    },
  },
  {
    name: 'a symlinked lock',
    prepare: async (root, directory) => {
      await mkdir(directory, { mode: 0o700 });
      await symlink(join(root, 'elsewhere.lock'), join(directory, 'daemon.lock'));
    },
  },
  {
    name: 'settings others can read',
    prepare: async (_root, directory) => {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, 'daemon.json'), '{"mode":"local"}', { mode: 0o644 });
    },
  },
  {
    name: 'host settings with a root holding its data and key file',
    prepare: async (root, directory) => {
      await mkdir(directory, { mode: 0o700 });
      await writeHostSettings(directory, [root], join(root, 'credential.key'));
    },
  },
  {
    name: 'a log folder others can read',
    prepare: async (_root, directory) => {
      await mkdir(join(directory, 'logs'), { recursive: true, mode: 0o700 });
      await chmod(join(directory, 'logs'), 0o755);
    },
  },
];
for (const refusal of refusals)
  test(`a daemon refuses ${refusal.name} without disclosing paths or contents`, async () => {
    await withRoot(async (root, started) => {
      const directory = join(root, 'data'),
        secret = 'private-file-canary-' + randomBytes(8).toString('hex');
      const args = (await refusal.prepare(root, directory, secret)) ?? [directory];
      const daemon = startDaemon(args);
      started.push(daemon);
      assert.deepEqual(await bounded(daemon.exited), [1, null]);
      assert.equal(daemon.output, '');
      const failure = JSON.parse(daemon.errors.trim());
      assert.equal(failure.event, 'failed');
      assert.equal(typeof failure.error.message, 'string');
      for (const leaked of [root, secret])
        assert.ok(!daemon.errors.includes(leaked), 'discloses ' + leaked);
    });
  });
