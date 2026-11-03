import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type * as Esbuild from 'esbuild';

const require = createRequire(new URL('../../../package.json', import.meta.url));
test('bundled production local layer runs tools on pinned Electron Node24 and statically loads provider OAuth with network disabled', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-electron-local-')));
  try {
    const file = join(directory, 'local.mjs');
    const source = `
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { LocalPiRuntimeLive, PiRuntimeLive } from './src/index.ts';
import { createLocalModels } from './src/local-models.ts';
async function main() {
  assert.equal(process.versions.electron, '45.1.0'); assert.equal(process.versions.node, '24.22.1');
  globalThis.fetch = async () => { throw Error('Network is disabled in this qualification.'); };
  const directory = process.argv[2], models = createModels(), faux = fauxProvider({tokensPerSecond:100000}); models.setProvider(faux.provider);
  const session = {host:{hostId:'electron-local',storeId:'electron-local-store'},actorId:'owner'};
  const model = {provider:faux.provider.id,modelId:faux.getModel().id};
  const runtime = ManagedRuntime.make(LocalPiRuntimeLive({...session,models,databasePath:join(directory,'chat.sqlite')}));
  const client = makeChatClient(runtime);
  try {
    const created = await client.command('createChat',{session,requestId:'create',title:'Embedded tools',settings:{cwd:directory,model}});
    faux.setResponses([fauxAssistantMessage(fauxToolCall('write',{path:'embedded.txt',content:'Electron local tools'}),{stopReason:'toolUse'}),fauxAssistantMessage('Done')]);
    await client.command('sendChat',{target:created.conversation.target,requestId:'send',text:'Write a file'});
    let done=false;for(let i=0;i<300;i++){const s=await client.command('getChat',{target:created.conversation.target});if(s.entries.some(e=>e.text==='Done')&&!s.run){done=true;break;}await new Promise(r=>setTimeout(r,10));}
    assert(done);assert.equal(await readFile(join(directory,'embedded.txt'),'utf8'),'Electron local tools');
  } finally { await runtime.dispose(); }
  const remote = ManagedRuntime.make(PiRuntimeLive({...session,models,cwd:directory,model,databasePath:join(directory,'host.sqlite')}));
  try { await assert.rejects(makeChatClient(remote).command('getChatHost',{host:session.host}),{code:'Incompatible'}); } finally { await remote.dispose(); }
  const values = new Map();
  const credentials = {read:async(id)=>values.get(id),list:async()=>[],modify:async(id,fn)=>{const v=await fn(values.get(id));if(v)values.set(id,v);return values.get(id)},delete:async(id)=>{values.delete(id)}};
  const installed = createLocalModels(credentials);
  assert.equal(installed.getProviders().length,5);
  const abort = new AbortController(); let opened=false;
  await assert.rejects(installed.login('openai','oauth', {signal:abort.signal,prompt:async()=>{throw Error('Controlled cancellation')},notify:(event)=>{if(event.type==='auth_url'){assert.equal(new URL(event.url).hostname,'auth.openai.com');opened=true;abort.abort();}}},{getDeviceId:()=> 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',agentName:'Moonbase'}));
  assert(opened, 'Bundled current ChatGPT OAuth did not load');
  for (const id of ['openai-api-key','anthropic','google','openrouter']) {
    await installed.login(id,'api_key',{prompt:async()=> 'controlled-key',notify:()=>{}});
    assert(await installed.checkAuth(id));
  }
  console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,localTools:true,bundledOAuth:true,network:false}));
}
main().catch(()=>{console.error('Embedded local qualification failed');process.exitCode=1;});`;
    const esbuild = require('esbuild') as typeof Esbuild;
    await esbuild.build({
      stdin: {
        contents: source,
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
    const result = await promisify(execFile)(require('electron') as string, [file, directory], {
      env: { ...process.env, PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
      timeout: 30000,
    });
    assert.match(result.stdout, /"localTools":true/);
    assert.match(result.stdout, /"bundledOAuth":true/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
