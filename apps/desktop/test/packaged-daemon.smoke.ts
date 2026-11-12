import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Effect, Layer, ManagedRuntime } from 'effect';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { LocalHostService, WorkspaceHostService } from '@moonbase/contracts/services';
import {
  makeChatClient,
  makeConnectionClient,
  makeProviderSetupClient,
} from '@moonbase/application/runtime/clients';
import { LoopbackConnectionLive } from '@moonbase/daemon-protocol/loopback';
import {
  RemoteChatLive,
  RemoteLocalHostLive,
  RemoteProviderSetupLive,
  RemoteWorkspaceHostLive,
} from '@moonbase/daemon-protocol/remote';
import { findDaemonCommand } from '../src/main/daemon-command.ts';
import {
  bounded,
  launchFrom,
  missingPackageProbe,
  plantHostileBunFiles,
  prepareDaemonRoot,
  runProbe,
  startDaemonCommand,
  withLocalRegistry,
  writeHostilePreload,
} from './daemon-process.ts';

// Runs against the package that `bun run package` made; `test:package` runs it.
const contents = resolve(
  `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Moonbase.app/Contents`,
);
const packaged = {
  packaged: true,
  resourcesPath: join(contents, 'Resources'),
  bundleDirectory: join(contents, 'Resources/app.asar'),
  // The packaged bundle's digest, which the build embedded in main.
  build: JSON.parse(await readFile(resolve('dist/daemon-build.json'), 'utf8')) as string,
};

// A stand-in for the Claude Code CLI, the chat's faux provider: it reports a subscription login,
// starts the tool-inventory helper from the MCP config exactly as Claude Code would, records what
// the helper listed and answers each turn without any network.
const fauxClaude = (logs: string) => `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
const logs = ${JSON.stringify(logs)};
if (process.argv.includes('auth') && process.argv.includes('status')) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
  process.exit(0);
}
const server = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]).mcpServers.pi;
const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const replies = readline.createInterface({ input: mcp.stdout });
const tools = await new Promise((resolve, reject) => {
  mcp.once('exit', (code) => reject(Error('MCP helper exited ' + code)));
  replies.on('line', (line) => { const reply = JSON.parse(line); if (reply.id === 2) resolve(reply.result.tools); });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\\n');
});
appendFileSync(logs + '/helpers.jsonl', JSON.stringify({ command: server.command, args: server.args, env: server.env, tools: tools.map((tool) => tool.name), hostile: process.env.MOONBASE_HOSTILE ?? null }) + '\\n');
const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const send = (value) => console.log(JSON.stringify(value));
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { models: [] } } });
    continue;
  }
  if (frame.type !== 'user') continue;
  if (frame.shouldQuery === false) {
    send({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, usage, user_message_uuids: [frame.uuid] });
    continue;
  }
  const text = 'Packaged helper listed ' + tools.length + ' tools';
  for (const event of [
    { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage },
    { type: 'message_stop' },
  ])
    send({ type: 'stream_event', event });
  send({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage } });
  send({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, usage, user_message_uuids: [frame.uuid] });
}
mcp.kill();
`;

test('the packaged daemon serves a chat from temporary data, and its Claude Code helper starts from the bundle', async () => {
  const { root, directory } = await prepareDaemonRoot();
  const bin = join(root, 'bin'),
    project = join(root, 'project');
  await mkdir(bin);
  await mkdir(project);
  const claude = join(bin, 'claude');
  await writeFile(claude, fauxClaude(root));
  await chmod(claude, 0o755);
  // Like an npm install, the faux CLI runs through `env node`, with its `node` beside it.
  await symlink(process.execPath, join(bin, 'node'));
  const daemon = findDaemonCommand(packaged, directory, {
    // Only the system PATH, as an app launched from Finder has: no `rg` on it.
    PATH: '/usr/bin:/bin',
    HOME: root,
    TMPDIR: root,
    PI_CLAUDE_CODE_COMMAND: claude,
    // A hostile environment the daemon command must drop.
    BUN_OPTIONS: await writeHostilePreload(root, join(root, 'preloaded')),
  });
  await access(daemon.command);
  await access(daemon.args.at(-2)!);
  // Bun would load these from the folder the app was launched from.
  const launch = join(root, 'launch');
  await mkdir(launch);
  await plantHostileBunFiles(launch, join(root, 'preloaded'));
  const started = launchFrom(launch, () => startDaemonCommand(daemon));
  let runtime: ManagedRuntime.ManagedRuntime<unknown, unknown> | undefined;
  try {
    const ready = await bounded(started.ready);
    // The packaged daemon names the build main expects, so the app keeps using it.
    assert.equal(
      JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8')).build,
      packaged.build,
    );
    const identity = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'));
    const session = { host: identity.host, actorId: identity.actorId };
    assert.deepEqual(ready.host, identity.host);
    const clients = ManagedRuntime.make(
      Layer.mergeAll(
        RemoteChatLive,
        RemoteLocalHostLive,
        RemoteProviderSetupLive({
          host: ready.host,
          sameMachine: true,
          openUrl: async () => {},
        }),
      ).pipe(Layer.provideMerge(LoopbackConnectionLive({ directory }))),
    );
    runtime = clients as ManagedRuntime.ManagedRuntime<unknown, unknown>;
    const connected = await makeConnectionClient(clients).command('connect', {
      profileId: 'loopback',
    });
    assert.equal(connected.state, 'connected');
    // Provider setup sees the subscription through the faux CLI's login.
    const providers = await makeProviderSetupClient(clients, 'smoke').command('getProviders', {});
    const subscription = providers.providers.find((provider) => provider.id === 'claude-code');
    assert.equal(subscription?.configured, true, JSON.stringify(subscription));
    const folders = await clients.runPromise(LocalHostService);
    await clients.runPromise(
      folders.approveFolder({
        host: session.host,
        requestId: 'approve',
        path: project,
      }),
    );
    const chat = makeChatClient(clients);
    // The project is no Git repository and PATH has no `rg`, so only the app's ripgrep lists it.
    await writeFile(join(project, 'readme.md'), 'hello');
    const found = await chat.command('findChatFiles', {
      session,
      cwd: project,
      query: 'readme',
    });
    assert.deepEqual(
      found.matches.map((match) => match.path),
      ['readme.md'],
    );
    const created = await chat.command('createChat', {
      session,
      requestId: 'create',
      title: 'Packaged smoke',
      settings: {
        cwd: project,
        model: { provider: 'claude-code', modelId: 'claude-opus-5-5' },
      },
    });
    const target = created.conversation.target;
    await chat.command('sendChat', {
      target,
      requestId: 'send',
      text: 'Hello packaged daemon',
    });
    let snapshot: ChatSnapshot | undefined;
    for (let i = 0; i < 1000; i++) {
      snapshot = await chat.command('getChat', { target });
      if (!snapshot.run && snapshot.entries.some((entry) => entry.role === 'assistant')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const helpers = (await readFile(join(root, 'helpers.jsonl'), 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert(helpers.length > 0, 'Claude Code never started its helper: ' + started.errors);
    // The helper ran on the packaged runtime from the script beside the packaged bundle.
    for (const helper of helpers) {
      assert.equal(helper.command, daemon.command);
      assert.equal(helper.args[0], join(contents, 'Resources/daemon/inert-mcp.mjs'));
      assert.deepEqual(helper.env, { BUN_BE_BUN: '1' });
      assert(helper.tools.includes('read'), JSON.stringify(helper.tools));
      // The daemon's environment, which Claude Code inherits, took nothing from a `.env`.
      assert.equal(helper.hostile, null);
    }
    assert(
      snapshot?.entries.some(
        (entry) => entry.text === `Packaged helper listed ${helpers[0].tools.length} tools`,
      ),
      JSON.stringify(snapshot?.entries) + started.errors,
    );
    const token = (await readFile(join(directory, 'token'), 'utf8')).trim();
    assert(!started.output.includes(token) && !started.errors.includes(token));
    await clients.dispose();
    runtime = undefined;
    assert.deepEqual(await started.stop(), [0, null]);
    await assert.rejects(access(join(directory, 'endpoint.json')), {
      code: 'ENOENT',
    });
    await assert.rejects(access(join(root, 'preloaded')), { code: 'ENOENT' });
  } finally {
    await runtime?.dispose();
    await started.stop('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('the packaged daemon opens, saves, searches and trashes in a temporary repository', async () => {
  const { root, directory } = await prepareDaemonRoot();
  const project = join(root, 'project');
  await mkdir(project);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', [
      '-C',
      project,
      '-c',
      'user.name=Moonbase smoke',
      '-c',
      'user.email=smoke@example.invalid',
      ...args,
    ]);
  git('init', '-q', '-b', 'main');
  // Only files this test made are trashed; the name is unique in the user's Trash.
  const trashed = `moonbase-smoke-${randomUUID()}.txt`;
  await writeFile(join(project, 'notes.txt'), 'one\n');
  await writeFile(join(project, trashed), 'discard me\n');
  git('add', '.');
  git('commit', '-qm', 'Initial files');
  const daemon = findDaemonCommand(packaged, directory, {
    // Only the system PATH, as an app launched from Finder has: no `rg` on it.
    PATH: '/usr/bin:/bin',
    HOME: root,
    TMPDIR: root,
  });
  const started = startDaemonCommand(daemon);
  let runtime: ManagedRuntime.ManagedRuntime<unknown, unknown> | undefined;
  let inTrash: string | undefined;
  try {
    const ready = await bounded(started.ready);
    const clients = ManagedRuntime.make(
      RemoteWorkspaceHostLive({ host: ready.host }).pipe(
        Layer.provideMerge(LoopbackConnectionLive({ directory })),
      ),
    );
    runtime = clients as ManagedRuntime.ManagedRuntime<unknown, unknown>;
    await makeConnectionClient(clients).command('connect', { profileId: 'loopback' });
    const host = await clients.runPromise(WorkspaceHostService);
    const run = <A>(effect: Effect.Effect<A, unknown>) => clients.runPromise(effect);
    const checkout = await run(host.openCheckout({ root: project }));
    const document = await run(host.readFile({ checkout, path: 'notes.txt' }));
    const saved = await run(
      host.saveFile({
        installationId: 'smoke',
        clientId: 'smoke',
        requestId: randomUUID(),
        target: { checkout, path: 'notes.txt' },
        text: 'two needle\n',
        expectedVersion: document.version,
      }),
    );
    assert.equal(saved.kind, 'saved', JSON.stringify(saved));
    assert.equal(await readFile(join(project, 'notes.txt'), 'utf8'), 'two needle\n');
    // The packaged ripgrep beside the bundle finds it; the PATH has none.
    const found = await run(
      host.searchText({
        checkout,
        query: 'needle',
        matchCase: true,
        wholeWord: false,
        regex: false,
      }),
    );
    assert.deepEqual(
      found.files.map((file) => file.path),
      ['notes.txt'],
      JSON.stringify(found),
    );
    // The packaged helper moves the file to the Trash of the user the daemon runs as.
    const sources = await run(host.inspectEntries({ checkout, paths: [trashed] }));
    const result = await run(
      host.mutate({
        installationId: 'smoke',
        id: randomUUID(),
        clientId: 'smoke',
        checkout,
        kind: 'trash',
        sources,
      }),
    );
    inTrash = result.items[0]?.message?.replace('macOS Trash: ', '');
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    await assert.rejects(access(join(project, trashed)), { code: 'ENOENT' });
    assert(inTrash?.includes('/.Trash/'), String(inTrash));
    await clients.dispose();
    runtime = undefined;
    assert.deepEqual(await started.stop(), [0, null]);
  } finally {
    await runtime?.dispose();
    await started.stop('SIGKILL');
    // Leave nothing of the smoke test in the real Trash.
    if (inTrash?.includes('/.Trash/')) await rm(inTrash, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('the packaged runtime loads no .env or bunfig.toml from the daemon data directory', async () => {
  const { root, directory } = await prepareDaemonRoot();
  try {
    await plantHostileBunFiles(directory, join(root, 'preloaded'));
    const daemon = findDaemonCommand(packaged, directory, {
      PATH: '/usr/bin:/bin',
      HOME: root,
    });
    const probe = join(root, 'probe.mjs');
    await writeFile(probe, 'console.log(JSON.stringify(process.env.MOONBASE_HOSTILE ?? null))');
    const run = await runProbe(daemon, probe);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'null');
    await assert.rejects(access(join(root, 'preloaded')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the packaged runtime never asks a registry for a package the bundle lacks', async () => {
  const { root, directory } = await prepareDaemonRoot();
  try {
    const daemon = findDaemonCommand(packaged, directory, {
      PATH: '/usr/bin:/bin',
      HOME: root,
    });
    // Beside the bundle's own folder layout: no `node_modules` above the probe.
    const probe = join(root, 'probe.mjs');
    await writeFile(probe, missingPackageProbe);
    // Only a local listener: with auto-install on, Bun asks this, never npm.
    const probeWith = (command: typeof daemon) =>
      withLocalRegistry((registry) =>
        runProbe(command, probe, {
          ...daemon.env,
          BUN_CONFIG_REGISTRY: registry,
          BUN_INSTALL_CACHE_DIR: join(root, 'cache'),
        }),
      );
    const control = await probeWith({
      ...daemon,
      args: daemon.args.filter((arg) => arg !== '--no-install'),
    });
    assert.notEqual(control.requests.length, 0, 'without --no-install, Bun asks the registry');
    const { result: run, requests } = await probeWith(daemon);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'missing');
    assert.deepEqual(requests, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
