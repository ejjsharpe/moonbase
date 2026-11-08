import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type * as Esbuild from 'esbuild';
import { writeBrokenClaude, writeFakeClaude } from './fake-claude.ts';

const require = createRequire(new URL('../../../package.json', import.meta.url));

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
  const [directory, working, broken] = process.argv.slice(2);
  let command = working;
  const values = new Map();
  const credentials = {read:async(id)=>values.get(id),list:async()=>[],modify:async(id,fn)=>{const v=await fn(values.get(id));if(v)values.set(id,v);return values.get(id)},delete:async(id)=>{values.delete(id)}};
  const models = createLocalModels(credentials);
  const subscription = createClaudeCodeSubscription({ findCommand: async () => command, helperEnv: { ELECTRON_RUN_AS_NODE: '1' } });
  models.setProvider(subscription);
  const session = {host:{hostId:'claude-code',storeId:'claude-code-store'},actorId:'owner'};
  const runtime = ManagedRuntime.make(Layer.merge(
    LocalPiRuntimeLive({...session,models,databasePath:join(directory,'chat.sqlite')}),
    ProviderSetupLive({models,openUrl:async()=>{},deviceId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',getCheckProblem:(id)=>id===subscription.id?subscription.getCheckProblem():undefined}),
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
    assert.equal(signedOut.providers.find((provider) => provider.id === 'claude-code').problem, undefined);
    delete process.env.FAKE_CLAUDE_LOGGED_OUT;
    // A CLI that can't start says why, rather than reading as signed out.
    command = broken;
    const failing = (await providers.command('getProviders', {})).providers.find((provider) => provider.id === 'claude-code');
    assert.equal(failing.configured, false);
    assert.match(failing.problem, /status check failed \\(exit 127\\).*moonbase-missing-node/s);
    command = working;
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
    // Claude Code runs in this process's cwd, so the prompt states the chat's.
    const workers = (await readFile(join(directory,'workers.log'),'utf8')).trim().split('\\n').map((line) => JSON.parse(line));
    assert(workers.length > 0);
    for (const worker of workers) assert(worker.system.includes('<working-directory>\\nThe working directory is ' + directory + ','), worker.system);
    console.log(JSON.stringify({claudeCode:true}));
  } finally { await runtime.dispose(); await closeClaudeCodeProcesses(); }
}
main().catch((error)=>{console.error(error);process.exitCode=1;});`;

// The library ships TypeScript source, which only a bundle can load.
async function bundleScript(contents: string, outfile: string) {
  const esbuild = require('esbuild') as typeof Esbuild;
  await esbuild.build({
    stdin: { contents, loader: 'ts', resolveDir: new URL('..', import.meta.url).pathname },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    banner: {
      js: "import { createRequire as moonbaseRequire } from 'node:module';const require=moonbaseRequire(import.meta.url);",
    },
  });
}

test('a Claude subscription runs through Claude Code in bundled Electron, with Pi executing tools', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-claude-code-')));
  try {
    const bundle = join(directory, 'bundle'),
      file = join(bundle, 'claude-code.mjs'),
      command = await writeFakeClaude(directory);
    await mkdir(join(directory, 'broken'));
    const broken = await writeBrokenClaude(join(directory, 'broken'));
    await bundleScript(qualification, file);
    // The desktop build copies this helper beside its bundle in the same way.
    const library = dirname(
      createRequire(import.meta.url).resolve('@earendil-works/pi-claude-code/package.json'),
    );
    await cp(join(library, 'src/inert-mcp.mjs'), join(bundle, 'inert-mcp.mjs'));
    const result = await promisify(execFile)(
      require('electron') as string,
      [file, directory, command, broken],
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

const discovery = `
import { createModels } from '@earendil-works/pi-ai/models';
import { createClaudeCodeSubscription } from './src/claude-code.ts';
const models = createModels();
const subscription = createClaudeCodeSubscription();
models.setProvider(subscription);
const configured = !!(await models.checkAuth('claude-code'));
console.log(JSON.stringify({ configured, problem: subscription.getCheckProblem() ?? null }));`;

test('Claude Code is found on the caller PATH before its install locations, and runs from a bare GUI PATH', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-claude-find-')));
  try {
    const file = join(directory, 'discovery.mjs'),
      home = join(directory, 'home'),
      installed = join(home, '.local/bin'),
      onPath = join(directory, 'path-bin');
    await bundleScript(discovery, file);
    await mkdir(installed, { recursive: true });
    await mkdir(onPath);
    await mkdir(join(directory, 'path-logs'));
    await mkdir(join(directory, 'installed-logs'));
    // Every case gives an earlier candidate than any real install, so none can run the real CLI.
    const run = async (path: string) =>
      JSON.parse(
        (
          await promisify(execFile)(process.execPath, [file], {
            env: { PATH: path, HOME: home },
            timeout: 30000,
          })
        ).stdout,
      ) as { configured: boolean; problem: string | null };
    // A stale copy in an install location doesn't shadow the one on the caller's PATH.
    await writeBrokenClaude(installed);
    await writeFakeClaude(join(directory, 'path-logs'), onPath);
    assert.deepEqual(await run(`${onPath}:/usr/bin:/bin`), { configured: true, problem: null });
    assert.match(
      await readFile(join(directory, 'path-logs/invocations.log'), 'utf8'),
      /"auth","status"/,
    );
    // From Finder's PATH, the broken install location is all there is, and it says why.
    const failed = await run('/usr/bin:/bin');
    assert.equal(failed.configured, false);
    assert.match(failed.problem ?? '', /status check failed \(exit 127\)/);
    // A working npm-style install there runs, though its `node` isn't on that PATH.
    await rm(join(installed, 'claude'));
    await writeFakeClaude(join(directory, 'installed-logs'), installed);
    assert.deepEqual(await run('/usr/bin:/bin'), { configured: true, problem: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
