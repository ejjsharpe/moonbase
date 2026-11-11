import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Layer, ManagedRuntime } from 'effect';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { LocalHostService } from '@moonbase/contracts/services';
import {
  makeChatClient,
  makeConnectionClient,
  makeProviderSetupClient,
} from '@moonbase/application/runtime/clients';
import { LoopbackConnectionLive } from '@moonbase/pi-runtime/loopback';
import {
  RemoteChatLive,
  RemoteLocalHostLive,
  RemoteProviderSetupLive,
} from '@moonbase/pi-runtime/remote';
import { findDaemonCommand } from '../src/main/daemon-command.ts';
import { bounded, prepareDaemonRoot, startDaemonCommand } from './daemon-process.ts';

// Runs against the package that `bun run package` made; `test:package` runs it.
const contents = resolve(
  `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Moonbase.app/Contents`,
);

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
appendFileSync(logs + '/helpers.jsonl', JSON.stringify({ command: server.command, args: server.args, env: server.env, tools: tools.map((tool) => tool.name) }) + '\\n');
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
  const daemon = findDaemonCommand(
    {
      packaged: true,
      resourcesPath: join(contents, 'Resources'),
      bundleDirectory: join(contents, 'Resources/app.asar'),
    },
    '',
  );
  const [bundle] = daemon.args as [string];
  await access(daemon.command);
  await access(bundle);
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
  const started = startDaemonCommand(
    { command: daemon.command, args: [bundle, directory] },
    {
      // Only the system PATH, as an app launched from Finder has.
      PATH: '/usr/bin:/bin',
      HOME: root,
      TMPDIR: root,
      PI_CLAUDE_CODE_COMMAND: claude,
    },
  );
  let runtime: ManagedRuntime.ManagedRuntime<unknown, unknown> | undefined;
  try {
    const ready = await bounded(started.ready);
    const identity = JSON.parse(await readFile(join(directory, 'identity.json'), 'utf8'));
    const session = { host: identity.host, actorId: identity.actorId };
    assert.deepEqual(ready.host, identity.host);
    const clients = ManagedRuntime.make(
      Layer.mergeAll(
        RemoteChatLive,
        RemoteLocalHostLive,
        RemoteProviderSetupLive({ host: ready.host, sameMachine: true, openUrl: async () => {} }),
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
      folders.approveFolder({ host: session.host, requestId: 'approve', path: project }),
    );
    const chat = makeChatClient(clients);
    const created = await chat.command('createChat', {
      session,
      requestId: 'create',
      title: 'Packaged smoke',
      settings: { cwd: project, model: { provider: 'claude-code', modelId: 'claude-opus-5-5' } },
    });
    const target = created.conversation.target;
    await chat.command('sendChat', { target, requestId: 'send', text: 'Hello packaged daemon' });
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
    await assert.rejects(access(join(directory, 'endpoint.json')), { code: 'ENOENT' });
  } finally {
    await runtime?.dispose();
    await started.stop('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});
