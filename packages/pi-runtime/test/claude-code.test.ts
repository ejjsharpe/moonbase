import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type * as Esbuild from 'esbuild';

const require = createRequire(new URL('../../../package.json', import.meta.url));

// A stand-in for the Claude Code CLI: it reports a subscription login, starts the inert tool
// inventory exactly as Claude Code would and streams scripted turns without any network.
const fakeClaude = (node: string, directory: string) => `#!${node}
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
const directory = ${JSON.stringify(directory)};
appendFileSync(directory + '/invocations.log', JSON.stringify(process.argv.slice(2, 4)) + '\\n');
if (process.argv.includes('auth') && process.argv.includes('status')) {
  const loggedIn = !process.env.FAKE_CLAUDE_LOGGED_OUT;
  console.log(JSON.stringify(loggedIn ? { loggedIn, authMethod: 'claude.ai', subscriptionType: 'max' } : { loggedIn }));
  process.exit(0);
}
const config = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]);
const server = config.mcpServers.pi;
const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const replies = readline.createInterface({ input: mcp.stdout });
const tools = await new Promise((resolve, reject) => {
  mcp.once('exit', (code) => reject(Error('MCP helper exited ' + code)));
  replies.on('line', (line) => { const reply = JSON.parse(line); if (reply.id === 2) resolve(reply.result.tools); });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\\n');
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\\n');
});
writeFileSync(directory + '/mcp-tools.json', JSON.stringify(tools.map((tool) => tool.name)));
const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const send = (value) => console.log(JSON.stringify(value));
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
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
  const answered = frame.message.content.some((block) => block.type === 'tool_result');
  const block = answered
    ? { type: 'text', text: 'Done' }
    : { type: 'tool_use', id: 'tool_write', name: 'mcp__pi__write', input: { path: 'claude.txt', content: 'Written through Claude Code' } };
  const events = [
    { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], usage } },
    { type: 'content_block_start', index: 0, content_block: answered ? { type: 'text', text: '' } : { ...block, input: {} } },
    { type: 'content_block_delta', index: 0, delta: answered ? { type: 'text_delta', text: 'Done' } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: answered ? 'end_turn' : 'tool_use' }, usage },
    { type: 'message_stop' },
  ];
  for (const event of events) send({ type: 'stream_event', event });
  send({ type: 'assistant', message: { id: 'm', role: 'assistant', content: [block], stop_reason: answered ? 'end_turn' : 'tool_use', usage } });
  send({ type: 'result', subtype: answered ? 'success' : 'error_max_turns', is_error: !answered, num_turns: 1, usage, user_message_uuids: [frame.uuid] });
}
mcp.kill();
`;

const qualification = `
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ManagedRuntime, Layer } from 'effect';
import { makeChatClient, makeProviderSetupClient } from '@moonbase/application/runtime/clients';
import { LocalPiRuntimeLive } from './src/index.ts';
import { createLocalModels } from './src/local-models.ts';
import { ProviderSetupLive } from './src/providers.ts';
import { closeClaudeCodeProcesses, createClaudeCodeSubscription } from './src/claude-code.ts';
async function main() {
  assert(process.versions.electron);
  // Like the desktop main process, children must not inherit Node mode except through helperEnv.
  delete process.env.ELECTRON_RUN_AS_NODE;
  globalThis.fetch = async () => { throw Error('Network is disabled in this qualification.'); };
  const [directory, command] = process.argv.slice(2);
  const values = new Map();
  const credentials = {read:async(id)=>values.get(id),list:async()=>[],modify:async(id,fn)=>{const v=await fn(values.get(id));if(v)values.set(id,v);return values.get(id)},delete:async(id)=>{values.delete(id)}};
  const models = createLocalModels(credentials);
  models.setProvider(createClaudeCodeSubscription({ findCommand: async () => command, helperEnv: { ELECTRON_RUN_AS_NODE: '1' } }));
  const session = {host:{hostId:'claude-code',storeId:'claude-code-store'},actorId:'owner'};
  const runtime = ManagedRuntime.make(Layer.merge(
    LocalPiRuntimeLive({...session,models,databasePath:join(directory,'chat.sqlite')}),
    ProviderSetupLive({models,openUrl:async()=>{},deviceId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'}),
  ));
  try {
    const providers = makeProviderSetupClient(runtime, 'document');
    const status = await providers.command('getProviders', {});
    const claude = status.providers.find((provider) => provider.id === 'claude-code');
    assert.equal(claude.auth, 'claude_code');
    assert.equal(claude.configured, true);
    assert.deepEqual(claude.defaultModel, {model:{provider:'claude-code',modelId:'claude-opus-5-5'},reasoningEffort:'high'});
    await assert.rejects(providers.command('startProviderLogin', {providerId:'claude-code'}), {code:'InvalidInput'});
    await assert.rejects(providers.command('logoutProvider', {providerId:'claude-code'}), {code:'InvalidInput'});
    process.env.FAKE_CLAUDE_LOGGED_OUT = '1';
    const signedOut = await providers.command('getProviders', {});
    assert.equal(signedOut.providers.find((provider) => provider.id === 'claude-code').configured, false);
    delete process.env.FAKE_CLAUDE_LOGGED_OUT;
    const client = makeChatClient(runtime);
    const created = await client.command('createChat',{session,requestId:'create',title:'Claude subscription',settings:{cwd:directory,model:claude.defaultModel.model,reasoningEffort:'high'}});
    await client.command('sendChat',{target:created.conversation.target,requestId:'send',text:'Write a file'});
    let state;
    for (let i = 0; i < 500; i++) {
      state = await client.command('getChat',{target:created.conversation.target});
      if (state.entries.some((entry) => entry.text === 'Done') && !state.run) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(state.entries.some((entry) => entry.text === 'Done'), JSON.stringify(state.entries));
    assert.equal(await readFile(join(directory,'claude.txt'),'utf8'),'Written through Claude Code');
    console.log(JSON.stringify({claudeCode:true}));
  } finally { await runtime.dispose(); await closeClaudeCodeProcesses(); }
}
main().catch((error)=>{console.error(error);process.exitCode=1;});`;

test('a Claude subscription runs through Claude Code in bundled Electron, with Pi executing tools', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-claude-code-')));
  try {
    const bundle = join(directory, 'bundle'),
      file = join(bundle, 'claude-code.mjs'),
      command = join(directory, 'claude');
    await writeFile(command, fakeClaude(process.execPath, directory));
    await chmod(command, 0o755);
    const esbuild = require('esbuild') as typeof Esbuild;
    await esbuild.build({
      stdin: {
        contents: qualification,
        loader: 'ts',
        resolveDir: new URL('..', import.meta.url).pathname,
      },
      outfile: file,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent',
      banner: {
        js: "import { createRequire as moonbaseRequire } from 'node:module';const require=moonbaseRequire(import.meta.url);",
      },
    });
    // The desktop build copies this helper beside its bundle in the same way.
    const library = dirname(
      createRequire(import.meta.url).resolve('@earendil-works/pi-claude-code/package.json'),
    );
    await cp(join(library, 'src/inert-mcp.mjs'), join(bundle, 'inert-mcp.mjs'));
    const result = await promisify(execFile)(
      require('electron') as string,
      [file, directory, command],
      {
        env: { PATH: '/usr/bin:/bin', HOME: directory, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 30000,
      },
    ).catch((error: { stdout?: string; stderr?: string }) => {
      throw Error(`${error.stderr ?? ''}${error.stdout ?? ''}`);
    });
    assert.match(result.stdout, /"claudeCode":true/);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'mcp-tools.json'), 'utf8')).sort(), [
      'bash',
      'edit',
      'read',
      'write',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
