import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime-client';
import { PiRuntimeLive } from '../src/index.ts';
import type { ChatSnapshot, ChatTarget } from '@moonbase/application/chat-client';

const session={host:{hostId:'test-host',storeId:'test-store'},actorId:'personal'};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until<T>(get:()=>Promise<T>,ready:(value:T)=>boolean):Promise<T>{for(let i=0;i<300;i++){const value=await get();if(ready(value))return value;await delay(10);}throw Error('Condition did not settle.');}
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}) {
  const directory=await mkdtemp(join(tmpdir(),'moonbase-pi-')),faux=fauxProvider({tokensPerSecond:100000}),models=createModels();models.setProvider(faux.provider);
  const config={...session,cwd:directory,databasePath:join(directory,'chat.sqlite'),model:{provider:faux.provider.id,modelId:faux.getModel().id},models};
  let runtime=ManagedRuntime.make(PiRuntimeLive(config));
  t.after(async()=>{await runtime.dispose();await rm(directory,{recursive:true,force:true});});
  return {faux,config,get client(){return makeChatClient(runtime);},async restart(){await runtime.dispose();runtime=ManagedRuntime.make(PiRuntimeLive(config));},async create(requestId='create'){return (await makeChatClient(runtime).command('createChat',{session,requestId,title:'Saved chat'})).conversation.target;}};
}
test('atomic creation retries and actor/request immutable binding survive restart',async t=>{
  const f=await fixture(t);const target=await f.create();assert.deepEqual(await f.create(),target);
  await assert.rejects(f.client.command('createChat',{session,requestId:'create',title:'Changed'}),{code:'InvalidInput'});
  const list=await f.client.command('listChats',{session});assert.equal(list.conversations.length,1);
  await f.restart();assert.deepEqual(await f.create(),target);assert.equal(f.faux.state.callCount,0);
  await assert.rejects(f.client.command('listChats',{session:{...session,actorId:'other'}}),{code:'Unauthorized'});
});
test('duplicate/lost Send, read-only lookup, restart and cross-operation reuse never resend',async t=>{
  const f=await fixture(t),target=await f.create();f.faux.setResponses([fauxAssistantMessage('Hello')]);
  const input={target,requestId:'send',text:'Question'};
  const receipts=await Promise.all([f.client.command('sendChat',input),f.client.command('sendChat',input)]);assert.deepEqual(receipts[0],receipts[1]);
  await until(()=>f.client.command('getChat',{target}),s=>s.run===null&&s.entries.some(e=>e.text==='Hello'));
  assert.equal(f.faux.state.callCount,1);
  await assert.rejects(f.client.command('sendChat',{...input,text:'changed'}),{code:'InvalidInput'});
  await assert.rejects(f.client.command('sendChat',{...input,requestId:'create'}),{code:'InvalidInput'});
  assert.equal(await f.client.command('getChatSend',{target,requestId:'unknown'}),null);
  await f.restart();assert.deepEqual(await f.client.command('getChatSend',{target,requestId:'send'}),receipts[0]);assert.deepEqual(await f.client.command('sendChat',input),receipts[0]);assert.equal(f.faux.state.callCount,1);
});
test('busy reservation stays visible; view unsubscribe and caller cancellation never Stop admitted work',async t=>{
  const f=await fixture(t),target=await f.create();let release!:()=>void;const gate=new Promise<void>(r=>release=r);t.after(async()=>release());
  f.faux.setResponses([async()=>{await gate;return fauxAssistantMessage('Detached completion');}]);
  await f.client.command('sendChat',{target,requestId:'one',text:'Start'});
  const events:ChatSnapshot[]=[];const off=f.client.watch({target},s=>events.push(s),error=>{throw error;});
  await until(()=>f.client.command('getChat',{target}),s=>!!s.run);off();const count=events.length;
  await assert.rejects(f.client.command('sendChat',{target,requestId:'two',text:'Busy'}),{code:'Conflict'});
  assert.equal((await f.client.command('getChatSend',{target,requestId:'two'}))?.admission,'reserved');
  const abort=new AbortController();abort.abort();await assert.rejects(f.client.command('sendChat',{target,requestId:'never',text:'Never'},{signal:abort.signal}),{code:'Cancelled'});
  assert.equal(await f.client.command('getChatSend',{target,requestId:'never'}),null);
  release();await until(()=>f.client.command('getChat',{target}),s=>s.run===null&&s.entries.some(e=>e.text==='Detached completion'));assert.equal(events.length,count);assert.equal(f.faux.state.callCount,1);
});
test('exact task Stop settles and cannot abort a later task',async t=>{
  const f=await fixture(t),target=await f.create();f.faux.setResponses([fauxAssistantMessage('a'.repeat(10000))]);
  await f.client.command('sendChat',{target,requestId:'one',text:'First'});
  const current=await until(()=>f.client.command('getChat',{target}),s=>!!s.run);const stop=current.run!.stop;
  const result=await f.client.command('stopChat',{stop,requestId:'stop'});assert.ok(['stopped','terminal','pending'].includes(result.outcome));
  await until(()=>f.client.command('getChat',{target}),s=>s.run===null);
  f.faux.setResponses([fauxAssistantMessage('Later')]);await f.client.command('sendChat',{target,requestId:'two',text:'Second'});
  const old=await f.client.command('stopChat',{stop,requestId:'stop'});assert.ok(['terminal','superseded'].includes(old.outcome));
  await until(()=>f.client.command('getChat',{target}),s=>s.run===null&&s.entries.some(e=>e.text==='Later'));
  await assert.rejects(f.client.command('stopChat',{stop:{...stop,taskId:null},requestId:'stop'}),{code:'InvalidInput'});
});
