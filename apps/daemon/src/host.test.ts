import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { daemonErrorReasons } from '@moonbase/contracts/daemon';
import {
  bounded,
  connectClients,
  findFreePort,
  readJson,
  startDaemon,
  temporaryRoot,
  until,
  type DaemonProcess,
} from '../test/fixtures/fixture.ts';
import { fauxModelId, fauxProviderId, fauxSignInCode } from '../test/fixtures/faux.ts';

const model = { provider: fauxProviderId, modelId: fauxModelId };

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

/** A host-mode data directory in `root`, serving `roots` with a key file beside it. */
async function prepareHost(root: string, roots: string[]) {
  const directory = join(root, 'data'),
    keyFile = join(root, 'keys', 'credential.key'),
    port = await findFreePort();
  await mkdir(directory, { mode: 0o700 });
  await mkdir(dirname(keyFile), { mode: 0o700 });
  await writeFile(
    join(directory, 'daemon.json'),
    JSON.stringify({
      mode: 'host',
      port,
      approvedRoots: roots,
      credentialKey: { source: 'file', path: keyFile },
    }),
    { mode: 0o600 },
  );
  await writeFile(join(directory, 'faux.json'), '{}');
  return { directory, keyFile, port };
}

test('a host-mode daemon signs ChatGPT in by pasted code, runs chats without a project in its `chats/`, logs no secrets and restarts on its port', async () => {
  await withRoot(async (root, started) => {
    const work = join(root, 'work');
    await mkdir(work);
    const { directory, keyFile, port } = await prepareHost(root, [work]);
    const daemon = startDaemon([directory]);
    started.push(daemon);
    const ready = await bounded(daemon.ready);
    assert.equal(ready.port, port);
    const identity = await readJson(join(directory, 'identity.json'));
    const session = { host: identity.host, actorId: identity.actorId };
    // A remote client: its browser is not on the host's machine.
    const clients = connectClients(directory, ready.host, false);
    try {
      await clients.connection.command('connect', { profileId: 'loopback' });
      // ChatGPT signs in on the host through the redirect URL the user pastes back.
      const owner = clients.owner('remote-document');
      const chatgpt = (await owner.command('startProviderLogin', { providerId: 'openai' })).flow!;
      const pasted = await until(
        () => owner.command('getProviders', {}),
        (state) => state.flow?.prompt?.type === 'manual_code',
      );
      await owner.command('openProviderUrl', { flowId: chatgpt.id });
      assert.match(clients.opened[0]!, /^https:\/\/auth\.openai\.com\//);
      await owner.command('answerProviderPrompt', {
        flowId: chatgpt.id,
        promptId: pasted.flow!.prompt!.id,
        answer: fauxSignInCode,
      });
      await until(
        () => owner.command('getProviders', {}),
        (state) => state.providers.find((p) => p.id === 'openai')?.configured === true,
      );
      // Credentials are encrypted under the key file the host names, created at the first sign-in.
      assert.equal((await lstat(keyFile)).mode & 0o777, 0o600);

      // A chat without a project runs in a new folder in the host's own `chats/`.
      const own = await clients.chat.command('createChat', {
        session,
        requestId: 'create-own',
        title: 'No project',
        settings: { model },
      });
      assert.equal(own.conversation.ownFolder, true);
      assert.equal(dirname(own.conversation.cwd), join(directory, 'chats'));
      const target = own.conversation.target;
      await clients.chat.command('sendChat', { target, requestId: 'send', text: 'Hello host' });
      await until(
        () => clients.chat.command('getChat', { target }),
        (value) => !value.run && value.entries.some((entry) => entry.text === 'Faux reply'),
      );
    } finally {
      await clients.runtime.dispose();
    }
    assert.deepEqual(await daemon.stop(), [0, null]);
    await assert.rejects(stat(join(directory, 'endpoint.json')), { code: 'ENOENT' });
    const log = await readFile(join(directory, 'logs', 'daemon.log'), 'utf8');
    for (const secret of [fauxSignInCode, 'Hello host'])
      assert.ok(!log.includes(secret), 'the log keeps ' + secret);

    // The host listens on its configured port again, so a client's forward finds it.
    const restarted = startDaemon([directory]);
    started.push(restarted);
    assert.equal((await bounded(restarted.ready)).port, port);
    assert.deepEqual(await restarted.stop(), [0, null]);
  });
});

test('the real host entry uses its key file and the host’s own Claude Code login', async () => {
  await withRoot(async (root, started) => {
    const work = join(root, 'work');
    await mkdir(work);
    const { directory } = await prepareHost(root, [work]);
    // Claude Code signs in on the host with `claude auth login`; this stand-in reports a login.
    const claude = join(root, 'claude');
    await writeFile(
      claude,
      `#!/bin/sh\nif [ "$1" = auth ] && [ "$2" = status ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'; exit 0; fi\nexit 1\n`,
    );
    await chmod(claude, 0o700);
    const daemon = startDaemon([directory], {
      entry: 'main',
      env: { PI_CLAUDE_CODE_COMMAND: claude },
    });
    started.push(daemon);
    const ready = await bounded(daemon.ready, 30000);
    const clients = connectClients(directory, ready.host, false);
    try {
      await clients.connection.command('connect', { profileId: 'loopback' });
      const owner = clients.owner('remote-document');
      const state = await until(
        () => owner.command('getProviders', {}),
        (value) => value.providers.find((p) => p.id === 'claude-code')?.configured === true,
      );
      assert.ok(state.providers.some((p) => p.id === 'openai' && !p.configured));
      // Moonbase never signs Claude Code in or out; the host's own login does.
      await assert.rejects(
        owner.command('startProviderLogin', { providerId: 'claude-code' }),
        daemonErrorReasons['claude-code-sign-in'],
      );
    } finally {
      await clients.runtime.dispose();
    }
    assert.deepEqual(await daemon.stop(), [0, null]);
  });
});
