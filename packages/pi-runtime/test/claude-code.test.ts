import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type * as Esbuild from 'esbuild';
import { writeFakeClaude } from './fake-claude.ts';

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
      command = await writeFakeClaude(directory);
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
