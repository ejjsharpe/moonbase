import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import {ApplicationError} from '@moonbase/application/client';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime-client';
import { Harness, createRegistry, defineExtension, defineTool, type Registry } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import {CodingTools} from '@earendil-works/pi-durable/tools';
import {readFile} from 'node:fs/promises';
import {BACKGROUND_CONTEXT} from '@earendil-works/chord/context';
import { PiRuntimeLive } from '../src/index.ts';
import type { ChatSnapshot, ChatTarget } from '@moonbase/application/chat-client';

const session={host:{hostId:'test-host',storeId:'test-store'},actorId:'personal'};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until<T>(get:()=>Promise<T>,ready:(value:T)=>boolean):Promise<T>{for(let i=0;i<300;i++){const value=await get();if(ready(value))return value;await delay(10);}throw Error('Condition did not settle.');}
async function fixture(t:{after:(fn:()=>Promise<void>)=>void},registry?:Registry,fauxOptions:Parameters<typeof fauxProvider>[0]={}) {
  const directory=await mkdtemp(join(tmpdir(),'moonbase-pi-')),faux=fauxProvider({tokensPerSecond:100000,...fauxOptions}),models=createModels();models.setProvider(faux.provider);
  const config={...session,cwd:directory,databasePath:join(directory,'chat.sqlite'),model:{provider:faux.provider.id,modelId:faux.getModel().id},models,registry};
  let runtime=ManagedRuntime.make(PiRuntimeLive(config));
  t.after(async()=>{await runtime.dispose();await rm(directory,{recursive:true,force:true});});
  return {faux,config,get client(){return makeChatClient(runtime);},async restart(){await runtime.dispose();runtime=ManagedRuntime.make(PiRuntimeLive(config));},async dispose(){await runtime.dispose();},async create(requestId='create'){return (await makeChatClient(runtime).command('createChat',{session,requestId,title:'Saved chat'})).conversation.target;}};
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

for(const admitted of [false,true]) test(`interrupted ${admitted?'admitted binding':'reservation'} recovers without implicit resubmission`,async t=>{
  const original=Harness.open;let fail=true;
  mock.method(Harness,'open',async(...args:Parameters<typeof original>)=>{
    const harness=await original(...args),get=harness.conversation.bind(harness);
    harness.conversation=async(...values:Parameters<typeof get>)=>{const conversation=await get(...values);if(conversation){const submit=conversation.submit.bind(conversation);conversation.submit=async(...input:Parameters<typeof submit>)=>{
      if(fail){fail=false;if(admitted)await submit(...input);throw Error('Controlled lost admission response');}return submit(...input);
    };}return conversation;};return harness;
  });t.after(async()=>mock.restoreAll());
  const f=await fixture(t),target=await f.create();f.faux.setResponses([fauxAssistantMessage('Once')]);const input={target,requestId:'lost',text:'Retained'};
  await assert.rejects(f.client.command('sendChat',input),{code:'Uncertain'});
  await f.restart();const receipt=await f.client.command('getChatSend',{target,requestId:'lost'});assert.equal(receipt?.admission,admitted?'admitted':'reserved');
  const before=f.faux.state.callCount;await f.client.command('getChat',{target});await f.client.command('listChats',{session});assert.equal(f.faux.state.callCount,before);
  if(!admitted){assert.equal(before,0);assert.equal((await f.client.command('getChat',{target})).state,'uncertain');}
  assert.equal((await f.client.command('sendChat',input)).admission,'admitted');await until(()=>f.client.command('getChat',{target}),s=>s.run===null&&s.entries.some(e=>e.text==='Once'));assert.equal(f.faux.state.callCount,1);
});
test('caller cancellation after persisted admission closes only its wait',async t=>{
  const original=Harness.open;let entered!:()=>void,release!:()=>void;const pending=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  mock.method(Harness,'open',async(...args:Parameters<typeof original>)=>{const harness=await original(...args),get=harness.conversation.bind(harness);harness.conversation=async(...values:Parameters<typeof get>)=>{const conversation=await get(...values);if(conversation){const submit=conversation.submit.bind(conversation);conversation.submit=async(...input:Parameters<typeof submit>)=>{const receipt=await submit(...input);entered();await gate;return receipt;};}return conversation;};return harness;});
  t.after(async()=>{release();mock.restoreAll();});const f=await fixture(t),target=await f.create();f.faux.setResponses([fauxAssistantMessage('Continued')]);const abort=new AbortController();
  const input={target,requestId:'cancelled-wait',text:'Keep running'},call=f.client.command('sendChat',input,{signal:abort.signal});await pending;abort.abort();await assert.rejects(call,{code:'Cancelled'});release();
  await until(()=>f.client.command('getChat',{target}),s=>s.run===null&&s.entries.some(e=>e.text==='Continued'));assert.equal((await f.client.command('getChatSend',{target,requestId:input.requestId}))?.admission,'admitted');assert.equal(f.faux.state.callCount,1);
});
test('counted tools publish bounded progress; old task Stop cannot follow generation handover',async t=>{
  let tools=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);const registry=createRegistry();registry.install(defineExtension({name:'controlled',tools:[defineTool({name:'counted',description:'Controlled counter',parameters:Type.Object({}),execute:async(_,api,ctx)=>{tools++;api.output(('😀\\"\n').repeat(5000));await api.details({privateUnused:'x'.repeat(20000)},ctx);await Promise.race([gate,new Promise<void>(resolve=>{if(ctx.abortSignal?.aborted)return resolve();ctx.abortSignal?.addEventListener('abort',()=>resolve(),{once:true});})]);return {output:[{type:'text',text:'Counted'}]};}})]}));
  const f=await fixture(t,registry),target=await f.create();t.after(async()=>release());let next!:()=>void,finish!:()=>void;const entered=new Promise<void>(r=>next=r),done=new Promise<void>(r=>finish=r);
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('counted',{}),{stopReason:'toolUse'}),async()=>{next();await done;return fauxAssistantMessage('Final');}]);
  await f.client.command('sendChat',{target,requestId:'tools',text:'Run counted tool'});
  const active=await until(()=>f.client.command('getChat',{target}),s=>!!s.run?.tools.some(t=>t.text.length));const old=active.run!.stop;
  assert.equal(tools,1);assert(active.run!.tools.every(t=>Buffer.byteLength(t.text)<=4096&&t.text.isWellFormed()));assert(Buffer.byteLength(JSON.stringify(active))<=256*1024);
  release();await entered;const successor=await f.client.command('getChat',{target});assert.notEqual(successor.run!.stop.taskId,old.taskId);assert.equal(successor.run!.stop.submissionId,old.submissionId);
  const outcome=await f.client.command('stopChat',{stop:old,requestId:'old-task'});assert.ok(['terminal','superseded'].includes(outcome.outcome));finish();await until(()=>f.client.command('getChat',{target}),s=>s.run===null&&s.entries.some(e=>e.text==='Final'));assert.equal(tools,1);
  await f.restart();assert.equal((await f.client.command('getChatSend',{target,requestId:'tools'}))?.admission,'admitted');assert.equal(tools,1);assert.equal(f.faux.state.callCount,2);
});
test('bounded escaped Unicode history pages retain every durable entry ID without skips',async t=>{
  const f=await fixture(t,undefined,{tokenSize:{min:65536,max:65536}}),target=await f.create(),text=('😀\\"\n\u0001\u0000').repeat(2000);f.faux.setResponses(Array.from({length:40},()=>fauxAssistantMessage(text)));
  for(let i=0;i<40;i++){await f.client.command('sendChat',{target,requestId:'message-'+i,text:'Question '+i});await until(()=>f.client.command('getChat',{target}),s=>!s.run&&s.state==='idle');}
  let page=await f.client.command('getChat',{target});const seen=new Set<string>();let count=0;
  while(true){assert(page.entries.length<=32);assert(Buffer.byteLength(JSON.stringify(page))<=256*1024);for(const entry of page.entries){assert(!seen.has(entry.id));seen.add(entry.id);assert(entry.text.isWellFormed());assert(Buffer.byteLength(entry.text)<=4096);if(entry.role==='assistant'){assert(entry.truncated);count++;}}
    if(!page.olderCursor)break;const older=await f.client.command('getChatHistory',{target,cursor:page.olderCursor});page={...page,...older};}
  assert.equal(count,40);
  for(const bad of ['\ud800','\0','x'.repeat(32769)])await assert.rejects(f.client.command('sendChat',{target,requestId:'invalid',text:bad}),{code:'InvalidInput'});
  const other=await f.create('other');const initial=await f.client.command('getChat',{target});assert(initial.olderCursor);await assert.rejects(f.client.command('getChatHistory',{target:other,cursor:initial.olderCursor}),{code:'InvalidInput'});
});
test('real SQLite full failure is visible and old committed chats survive reopen',async t=>{
  const original=NodeSqliteDatabase.prototype.transaction;let database:NodeSqliteDatabase|undefined;
  mock.method(NodeSqliteDatabase.prototype,'transaction',function<T>(this:NodeSqliteDatabase,callback:Parameters<typeof original>[0]){database=this;return original.call(this,callback) as Promise<T>;});
  const f=await fixture(t),target=await f.create();mock.restoreAll();const pages=await database!.get<{page_count:number}>('PRAGMA page_count');await database!.exec('PRAGMA max_page_count='+pages!.page_count);
  await assert.rejects(f.client.command('sendChat',{target,requestId:'full',text:'x'.repeat(32768)}),e=>!!e&&typeof e==='object'&&'code'in e&&['Persistence','Uncertain'].includes(String(e.code)));
  await assert.rejects(f.client.command('getChatHost',{host:session.host}),{code:'Persistence'});assert.equal(f.faux.state.callCount,0);
  await f.restart();assert.deepEqual((await f.client.command('listChats',{session})).conversations[0].target,target);assert.equal(await f.client.command('getChatSend',{target,requestId:'full'}),null);
});

test('ten actual tools retain only eight live previews and view disposal never stops them',async t=>{
  let calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r),registry=createRegistry();registry.install(defineExtension({name:'many',tools:[defineTool({name:'many',description:'Bounded live fixture',parameters:Type.Object({}),execute:async(_,api,ctx)=>{
    calls++;api.output(('\\"\u0001😀').repeat(5000));await api.details({held:true},ctx);await Promise.race([gate,new Promise<void>(resolve=>{if(ctx.abortSignal?.aborted)return resolve();ctx.abortSignal?.addEventListener('abort',()=>resolve(),{once:true});})]);return {output:[{type:'text',text:'Done'}]};
  }})]}));const f=await fixture(t,registry,{tokenSize:{min:65536,max:65536}}),target=await f.create();
  try{f.faux.setResponses([fauxAssistantMessage(Array.from({length:10},(_,i)=>fauxToolCall('many',{}, {id:'tool-'+i})),{stopReason:'toolUse'}),fauxAssistantMessage('All complete')]);
    const snapshots:ChatSnapshot[]=[],off=f.client.watch({target},s=>snapshots.push(s),e=>{throw e;});await f.client.command('sendChat',{target,requestId:'many',text:'Ten tools'});
    await until(()=>Promise.resolve(calls),n=>n===10);const view=await until(()=>f.client.command('getChat',{target}),s=>s.run?.tools.length===8&&s.run.tools.every(t=>t.text.length>0));
    assert.equal(view.run!.tools.length,8);assert(Buffer.byteLength(JSON.stringify(view))<=256*1024);off();const before=snapshots.length;release();await until(()=>f.client.command('getChat',{target}),s=>!s.run&&s.entries.some(e=>e.text==='All complete'));assert.equal(snapshots.length,before);assert.equal(calls,10);
  }finally{release();}
});
test('null-task Stop never falls through to active work; captured task Stop cooperatively joins it',async t=>{
  let entered=0;const registry=createRegistry();registry.install(defineExtension({name:'cooperative',tools:[defineTool({name:'wait',description:'Wait for explicit cancellation',parameters:Type.Object({}),execute:async(_,api,ctx)=>{
    entered++;api.output('Waiting');await api.details({waiting:true},ctx);await new Promise<void>(resolve=>{if(ctx.abortSignal?.aborted)return resolve();ctx.abortSignal?.addEventListener('abort',()=>resolve(),{once:true});});return {output:[{type:'text',text:'Joined'}]};
  }})]}));const f=await fixture(t,registry),target=await f.create();f.faux.setResponses([fauxAssistantMessage(fauxToolCall('wait',{}),{stopReason:'toolUse'})]);await f.client.command('sendChat',{target,requestId:'active',text:'Wait'});
  const active=await until(()=>f.client.command('getChat',{target}),s=>entered===1&&!!s.run?.tools.length);const stop=active.run!.stop;
  assert.equal((await f.client.command('stopChat',{stop:{...stop,taskId:null},requestId:'queued-only'})).outcome,'superseded');assert.equal((await f.client.command('getChat',{target})).run?.stop.taskId,stop.taskId);
  const result=await f.client.command('stopChat',{stop,requestId:'task'});assert.equal(result.outcome,'stopped');const terminal=await until(()=>f.client.command('getChat',{target}),s=>!s.run);assert.equal(terminal.state,'stopped');assert.equal(entered,1);
});
test('watch limits, pending unsubscribe/root disposal and arbitrary failing release stay observable without leaking storage',async t=>{
  const f=await fixture(t),target=await f.create();await f.restart();const original=Harness.open;let acquired!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>acquired=r),gate=new Promise<void>(r=>release=r);let subscriptions=0;
  mock.method(Harness,'open',async(...args:Parameters<typeof original>)=>{const harness=await original(...args);acquired();await gate;const subscribe=harness.subscribeCommits.bind(harness);harness.subscribeCommits=(...args)=>{const off=subscribe(...args);subscriptions++;return ()=>{subscriptions--;off();};};return harness;});
  try{const errors:unknown[]=[],off=f.client.watch({target},()=>{},e=>errors.push(e));await entered;off();const closing=f.dispose();release();await closing;assert.equal(subscriptions,0);assert.equal(errors.length,0);}
  finally{release();mock.restoreAll();}
  await f.restart();const events:ChatSnapshot[]=[],errors:unknown[]=[],stops=Array.from({length:65},()=>f.client.watch({target},s=>events.push(s),e=>errors.push(e)));await until(()=>Promise.resolve(errors.length),n=>n===1);assert.equal((errors[0] as {code:string}).code,'Unavailable');for(const off of stops)off();
  await f.restart();
  const canary='private-throwing-unsubscribe-canary';mock.method(Harness,'open',async(...args:Parameters<typeof original>)=>{const harness=await original(...args),subscribe=harness.subscribeCommits.bind(harness);harness.subscribeCommits=(...args)=>{const off=subscribe(...args);return ()=>{off();throw new Proxy({}, {get(){throw canary;}});};};return harness;});
  await f.restart();let observed=false;const failures:unknown[]=[],off=f.client.watch({target},()=>observed=true,e=>failures.push(e));await until(()=>Promise.resolve(observed),Boolean);off();await until(()=>Promise.resolve(failures.length),n=>n===1);assert(!JSON.stringify(failures).includes(canary));mock.restoreAll();
});

test('model failure remains failed across restart and never exposes raw provider diagnostics',async t=>{
  const f=await fixture(t),target=await f.create(),secret='private-provider-diagnostic-canary';f.faux.setResponses([fauxAssistantMessage('',{stopReason:'error',errorMessage:secret})]);
  await f.client.command('sendChat',{target,requestId:'failure',text:'Fail safely'});const failed=await until(()=>f.client.command('getChat',{target}),s=>!s.run&&s.state==='failed');assert(!JSON.stringify(failed).includes(secret));
  await f.restart();const recovered=await f.client.command('getChat',{target});assert.equal(recovered.state,'failed');assert(!JSON.stringify(recovered).includes(secret));assert.equal(f.faux.state.callCount,1);
});
test('fixed store authority rejects model/cwd/actor/host retargeting without executing work',async t=>{
  const f=await fixture(t);await f.create();await f.dispose();
  const alternate=fauxProvider({provider:'alternate',models:[{id:'alternate'}]});f.config.models.setProvider(alternate.provider);
  for(const change of [{model:{provider:'alternate',modelId:'alternate'}},{actorId:'other'},{host:{...session.host,storeId:'other'}},{cwd:tmpdir()}]) {
    const runtime=ManagedRuntime.make(PiRuntimeLive({...f.config,...change}));try{await assert.rejects(makeChatClient(runtime).command('getChatHost',{host:change.host??session.host}),{code:'Incompatible'});}finally{await runtime.dispose();}
  }
  await f.restart();assert.equal((await f.client.command('listChats',{session})).conversations.length,1);assert.equal(f.faux.state.callCount,0);
});

test('completed failing tool activity is projected as failed while another tool remains live',async t=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),registry=createRegistry();registry.install(defineExtension({name:'tool-status',tools:[
    defineTool({name:'fails',description:'Controlled error result',parameters:Type.Object({}),execute:async()=>({isError:true,output:[{type:'text',text:'Controlled tool failure'}]})}),
    defineTool({name:'holds',description:'Hold the round open',parameters:Type.Object({}),execute:async(_,api,ctx)=>{api.output('Holding');await api.details({held:true},ctx);await Promise.race([gate,new Promise<void>(resolve=>{if(ctx.abortSignal?.aborted)return resolve();ctx.abortSignal?.addEventListener('abort',()=>resolve(),{once:true});})]);return {output:[{type:'text',text:'Released'}]};}}),
  ]}));const f=await fixture(t,registry,{tokenSize:{min:65536,max:65536}}),target=await f.create();
  try{f.faux.setResponses([fauxAssistantMessage([fauxToolCall('fails',{}),fauxToolCall('holds',{})],{stopReason:'toolUse'}),fauxAssistantMessage('Finished')]);await f.client.command('sendChat',{target,requestId:'status',text:'Show tool states'});const view=await until(()=>f.client.command('getChat',{target}),s=>!!s.run?.tools.some(t=>t.name==='fails'&&t.state!=='running'));assert.equal(view.run!.tools.find(t=>t.name==='fails')!.state,'failed');}
  finally{release();}
});

test('selected Pi coding-tool runtime executes in the fixed cwd once and retained Send does not rerun native work after reopen',async t=>{
  const registry=createRegistry();registry.install(CodingTools);const f=await fixture(t,registry,{tokenSize:{min:65536,max:65536}}),target=await f.create();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('bash',{command:'printf x >> counted.txt; printf "%s" "$$" > native.pid'}),{stopReason:'toolUse'}),fauxAssistantMessage('Native complete')]);
  const input={target,requestId:'native',text:'One controlled native effect'};const receipt=await f.client.command('sendChat',input);await until(()=>f.client.command('getChat',{target}),s=>!s.run&&s.entries.some(e=>e.text==='Native complete'));
  assert.equal(await readFile(join(f.config.cwd,'counted.txt'),'utf8'),'x');const pid=Number(await readFile(join(f.config.cwd,'native.pid'),'utf8'));assert.throws(()=>process.kill(pid,0),(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code==='ESRCH');
  await f.restart();assert.deepEqual(await f.client.command('sendChat',input),receipt);assert.equal(await readFile(join(f.config.cwd,'counted.txt'),'utf8'),'x');assert.equal(f.faux.state.callCount,2);
});

test('null-task Stop withdraws an actual Pi-queued submission while preserving the unrelated active input',async t=>{
  const original=Harness.open;let harness:Harness|undefined;mock.method(Harness,'open',async(...args:Parameters<typeof original>)=>harness=await original(...args));
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),f=await fixture(t),target=await f.create();
  try{f.faux.setResponses([async()=>{await gate;return fauxAssistantMessage('Active input completed');}]);await f.client.command('sendChat',{target,requestId:'active',text:'Preserve this active work'});
    const active=await until(()=>f.client.command('getChat',{target}),s=>!!s.run),stop=active.run!.stop;
    // Public Pi admission creates the queued condition; production Moonbase Send always uses whenBusy:reject.
    const conversation=await harness!.conversation(Number(target.conversationId) as import('@earendil-works/pi-durable').ConversationId,BACKGROUND_CONTEXT);
    const queued=await conversation!.submit({type:'input',content:'Withdraw only this queued input',requestId:'controlled-pi-queued',whenBusy:'followUp'},BACKGROUND_CONTEXT);assert.equal((await queued.status(BACKGROUND_CONTEXT)).status,'queued');
    const withdrawn=await f.client.command('stopChat',{stop:{target,submissionId:String(queued.id),taskId:null},requestId:'queued-stop'});assert.equal(withdrawn.outcome,'stopped');assert.equal((await f.client.command('getChat',{target})).run!.stop.taskId,stop.taskId);
    release();const final=await until(()=>f.client.command('getChat',{target}),s=>!s.run&&s.entries.some(e=>e.text==='Active input completed'));assert(!final.entries.some(e=>e.text.includes('Withdraw only')));assert.equal(f.faux.state.callCount,1);
  }finally{release();mock.restoreAll();}
});

for(const typed of [false,true]) test(`R1 create reply-read failure after real commit is uncertain (${typed?'typed':'unknown'}) and exact retry survives restart`,async t=>{
  const original=Harness.open;let harness:Harness|undefined;mock.method(Harness,'open',async(...args:Parameters<typeof original>)=>harness=await original(...args));
  const f=await fixture(t);await f.client.command('getChatHost',{host:session.host});mock.restoreAll();
  const committed:string[]=[];const off=harness!.subscribeCommits(publication=>{for(const change of publication.changes)if(change.type==='conversation')committed.push(String(change.value.id));});
  const snapshot=harness!.snapshot.bind(harness!);let reads=0;
  mock.method(harness!,'snapshot',async(...args:Parameters<typeof snapshot>)=>{if(reads++===0)throw typed?new ApplicationError({code:'Persistence',message:'Controlled post-commit read failure'}):Error('Controlled post-commit read failure');return snapshot(...args);});
  const input={session,requestId:'committed-create',title:'Original saved chat'};let failure:unknown;
  try{await f.client.command('createChat',input).catch(error=>{failure=error;});}finally{mock.restoreAll();off();}
  assert.equal(committed.length,1);assert.equal((await f.client.command('listChats',{session})).conversations.length,1);
  await f.restart();const recovered=await f.client.command('createChat',input);assert.equal(recovered.conversation.target.conversationId,committed[0]);assert.deepEqual(await f.client.command('createChat',input),recovered);
  await assert.rejects(f.client.command('createChat',{...input,title:'Changed'}),{code:'InvalidInput'});assert.equal((await f.client.command('listChats',{session})).conversations.length,1);assert.equal(f.faux.state.callCount,0);
  assert.equal((failure as {code?:string})?.code,'Uncertain','a real committed conversation appeared definitively rejected');
});

test('R1 lost typed commit acknowledgement stays uncertain while proven create validation stays definite',async t=>{
  const original=Harness.open;let harness:Harness|undefined;mock.method(Harness,'open',async(...args:Parameters<typeof original>)=>harness=await original(...args));
  const f=await fixture(t);await f.client.command('getChatHost',{host:session.host});mock.restoreAll();const committed:string[]=[];
  const off=harness!.subscribeCommits(publication=>{for(const change of publication.changes)if(change.type==='conversation')committed.push(String(change.value.id));});
  const commit=harness!.commit.bind(harness!);let calls=0;mock.method(harness!,'commit',async(...args:Parameters<typeof commit>)=>{calls++;await commit(...args);throw new ApplicationError({code:'Persistence',message:'Controlled lost commit acknowledgement'});});
  const input={session,requestId:'lost-commit',title:'Committed'};
  try{await assert.rejects(f.client.command('createChat',{...input,title:''}),{code:'InvalidInput'});await assert.rejects(f.client.command('createChat',{...input,session:{...session,actorId:'other'}}),{code:'Unauthorized'});assert.equal(calls,0);await assert.rejects(f.client.command('createChat',input),{code:'Uncertain'});}
  finally{mock.restoreAll();off();}
  assert.equal(committed.length,1);await f.restart();const recovered=await f.client.command('createChat',input);assert.equal(recovered.conversation.target.conversationId,committed[0]);await assert.rejects(f.client.command('createChat',{...input,title:'Changed'}),{code:'InvalidInput'});assert.equal((await f.client.command('listChats',{session})).conversations.length,1);assert.equal(f.faux.state.callCount,0);
});
