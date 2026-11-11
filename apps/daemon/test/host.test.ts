import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { daemonErrorReasons } from '@moonbase/contracts/daemon';
import { LocalHostService } from '@moonbase/contracts/services';
import {
  bounded,
  connectClients,
  createFauxClient,
  findFreePort,
  readJson,
  startDaemon,
  temporaryRoot,
  until,
  type DaemonProcess,
} from './fixture.ts';
import { fauxModelId, fauxProviderId, fauxSignInCode, type FauxScript } from './faux.ts';

const model = { provider: fauxProviderId, modelId: fauxModelId };
const hostCapabilities = ['chat-v0', 'daemon-local-v1', 'providers-v1', 'folders-v1', 'roots-v1'];

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
async function prepareHost(root: string, roots: string[], script: FauxScript = {}) {
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
  await writeFile(join(directory, 'faux.json'), JSON.stringify(script));
  return { directory, keyFile, port };
}

test('a host-mode daemon serves local-mode chats in its approved roots, with model choice, provider setup and search', async () => {
  await withRoot(async (root, started) => {
    const projects = join(root, 'projects'),
      alpha = join(projects, 'alpha'),
      outside = join(root, 'outside');
    for (const folder of [alpha, join(projects, 'beta'), outside])
      await mkdir(folder, { recursive: true });
    await writeFile(join(alpha, 'readme.md'), 'hello');
    await writeFile(join(outside, 'secret.md'), 'outside');
    // A link inside a root that leads out of it.
    await symlink(outside, join(projects, 'escape'));
    const { directory, keyFile, port } = await prepareHost(root, [projects]);
    const daemon = startDaemon([directory]);
    started.push(daemon);
    const ready = await bounded(daemon.ready);
    assert.equal(ready.port, port);
    const identity = await readJson(join(directory, 'identity.json'));
    const session = { host: identity.host, actorId: identity.actorId };
    // A remote client: its browser is not on the host's machine.
    const clients = connectClients(directory, ready.host, false);
    try {
      const connected = await clients.connection.command('connect', {
        profileId: 'loopback',
      });
      assert.deepEqual(
        connected.state === 'connected' && connected.health.capabilities,
        hostCapabilities,
      );
      const folders = await clients.runtime.runPromise(LocalHostService);
      const host = session.host;
      // The client has no picker for the host's disk: it chooses from the roots and their folders.
      assert.deepEqual(await clients.run(folders.listHostFolders({ host })), {
        folders: [projects, alpha, join(projects, 'beta')],
      });
      assert.deepEqual(await clients.run(folders.listRecentFolders({ host })), {
        folders: [],
      });
      assert.deepEqual(
        await clients.run(
          folders.approveFolder({
            host,
            requestId: 'approve-alpha',
            path: alpha,
          }),
        ),
        { requestId: 'approve-alpha', path: alpha },
      );
      for (const [index, path] of [outside, join(projects, 'escape')].entries()) {
        await assert.rejects(
          clients.run(
            folders.approveFolder({
              host,
              requestId: `approve-${index}`,
              path,
            }),
          ),
          daemonErrorReasons['folder-outside-roots'],
        );
        await assert.rejects(
          clients.run(folders.checkApprovedFolder({ host, path })),
          daemonErrorReasons['folder-outside-roots'],
        );
      }

      // Provider setup on the host: an API key, and ChatGPT through the pasted redirect URL.
      const owner = clients.owner('remote-document');
      const apiKey = (await owner.command('startProviderLogin', { providerId: 'anthropic' })).flow!;
      const keyPrompt = await until(
        () => owner.command('getProviders', {}),
        (state) => state.flow?.prompt?.type === 'secret',
      );
      await owner.command('answerProviderPrompt', {
        flowId: apiKey.id,
        promptId: keyPrompt.flow!.prompt!.id,
        answer: 'faux-api-key',
      });
      await until(
        () => owner.command('getProviders', {}),
        (state) => state.providers.find((p) => p.id === 'anthropic')?.configured === true,
      );
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

      // Each chat chooses its folder under a root, and its model and reasoning effort.
      const chosen = { provider: 'anthropic', modelId: 'anthropic-faux' };
      const created = await clients.chat.command('createChat', {
        session,
        requestId: 'create-alpha',
        title: 'In a root',
        settings: { cwd: alpha, model: chosen, reasoningEffort: 'high' },
      });
      assert.equal(created.conversation.cwd, alpha);
      const target = created.conversation.target;
      const opened = await clients.chat.command('getChat', { target });
      assert.equal(opened.conversation.model, 'anthropic/anthropic-faux');
      assert.equal(opened.conversation.reasoningEffort, 'high');
      const found = await clients.chat.command('findChatFiles', {
        session,
        cwd: alpha,
        query: 'readme',
      });
      assert.deepEqual(
        found.matches.map((match) => match.path),
        ['readme.md'],
      );
      await clients.chat.command('sendChat', {
        target,
        requestId: 'send',
        text: 'Hello host',
      });
      await until(
        () => clients.chat.command('getChat', { target }),
        (value) => !value.run && value.entries.some((entry) => entry.text === 'Faux reply'),
      );
      await clients.chat.command('settleChat', { target, settled: true });
      assert.ok((await clients.chat.command('getChat', { target })).conversation.settledAt);

      // A chat without a project runs in a new folder in the host's own `chats/`.
      const own = await clients.chat.command('createChat', {
        session,
        requestId: 'create-own',
        title: 'No project',
        settings: { model },
      });
      assert.equal(own.conversation.ownFolder, true);
      assert.equal(dirname(own.conversation.cwd), join(directory, 'chats'));

      // Folders outside the roots and links out of them are refused for chats and search alike.
      for (const [requestId, cwd] of [
        ['create-outside', outside],
        ['create-escape', join(projects, 'escape')],
      ] as const)
        await assert.rejects(
          clients.chat.command('createChat', {
            session,
            requestId,
            title: 'Refused',
            settings: { cwd, model },
          }),
          (error: { code: string }) => ['Unauthorized', 'InvalidInput'].includes(error.code),
        );
      await assert.rejects(
        clients.chat.command('findChatFiles', {
          session,
          cwd: outside,
          query: 'secret',
        }),
        { code: 'Unauthorized' },
      );

      // A root replaced by another folder approves nothing under it, even at the same path.
      await rename(projects, `${projects}-moved`);
      await mkdir(alpha, { recursive: true });
      await assert.rejects(
        clients.chat.command('createChat', {
          session,
          requestId: 'create-replaced',
          title: 'Replaced',
          settings: { cwd: alpha, model },
        }),
        { code: 'Unauthorized' },
      );
      assert.deepEqual(await clients.run(folders.listHostFolders({ host })), {
        folders: [],
      });
      assert.equal((await clients.chat.command('listChats', { session })).conversations.length, 2);
    } finally {
      await clients.runtime.dispose();
    }
    assert.deepEqual(await daemon.stop(), [0, null]);
    await assert.rejects(stat(join(directory, 'endpoint.json')), {
      code: 'ENOENT',
    });
    const log = await readFile(join(directory, 'logs', 'daemon.log'), 'utf8');
    for (const secret of ['faux-api-key', fauxSignInCode, 'Hello host'])
      assert.ok(!log.includes(secret), 'the log keeps ' + secret);
  });
});

test('SIGTERM during a host run closes cleanly, and the restarted host resumes it with its sign-ins', async () => {
  await withRoot(async (root, started) => {
    const work = join(root, 'work');
    await mkdir(work);
    const { directory } = await prepareHost(root, [work], {
      steps: [{ hold: true }],
    });
    const first = startDaemon([directory]);
    started.push(first);
    const { port } = await bounded(first.ready);
    const token = (await readFile(join(directory, 'token'), 'utf8')).trim(),
      identity = await readJson(join(directory, 'identity.json')),
      session = { host: identity.host, actorId: identity.actorId };
    let client = createFauxClient(port, token);
    const target = (
      await client.command('createChat', {
        session,
        requestId: 'create',
        title: 'Interrupted',
        settings: { cwd: work, model },
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
    assert.deepEqual(await first.stop('SIGTERM'), [0, null]);
    await assert.rejects(stat(join(directory, 'endpoint.json')), {
      code: 'ENOENT',
    });

    await writeFile(join(directory, 'faux.json'), JSON.stringify({ steps: [] }));
    const second = startDaemon([directory]);
    started.push(second);
    // The host listens on its configured port again, so a client's forward finds it.
    assert.equal((await bounded(second.ready)).port, port);
    client = createFauxClient(port, token);
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
