import { ApplicationError } from '@moonbase/application/client';
import { maximumChatInputBytes, maximumChatReplyBytes, type ChatCommand, type ChatInput, type ChatOutput, type ChatSession, type ChatTarget, type ChatSummary, type ChatHistoryPage, type ChatSnapshot, type ChatSendReceipt, type ChatStopTarget } from '@moonbase/application/chat-client';
import type { ChatHostTarget } from '@moonbase/application/host-client';

export const fail = (code: ApplicationError['code'], message: string): never => { throw new ApplicationError({code, message}); };
export function object(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('InvalidInput', 'Expected a chat object.');
  const record = value as Record<string, unknown>;
  if (keys && Object.keys(record).some(key => !keys.includes(key))) fail('InvalidInput', 'Unexpected chat fields.');
  return record;
}
export function string(value: unknown, bytes: number, empty = false): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || (!empty && !value.trim()) || Buffer.byteLength(value) > bytes)
    return fail('InvalidInput', 'Chat text is empty, invalid Unicode, or exceeds its limit.');
  return value;
}
export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) return fail('InvalidInput', 'Invalid chat identity.');
  return value;
}
export function host(value: unknown): ChatHostTarget {
  const data = object(value, ['hostId', 'storeId']); return {hostId: id(data.hostId), storeId: id(data.storeId)};
}
export const sameHost = (a: ChatHostTarget, b: ChatHostTarget) => a.hostId === b.hostId && a.storeId === b.storeId;
export function session(value: unknown): ChatSession {
  const data = object(value, ['host', 'actorId']); return {host: host(data.host), actorId: id(data.actorId)};
}
export function target(value: unknown): ChatTarget {
  const data = object(value, ['host', 'actorId', 'conversationId']);
  return {host: host(data.host), actorId: id(data.actorId), conversationId: id(data.conversationId)};
}
export const sameTarget = (a: ChatTarget, b: ChatTarget) => sameHost(a.host,b.host) && a.actorId === b.actorId && a.conversationId === b.conversationId;
export function stopTarget(value: unknown): ChatStopTarget {
  const data = object(value, ['target','submissionId','taskId']);
  return {target: target(data.target), submissionId: id(data.submissionId), taskId: data.taskId === null ? null : id(data.taskId)};
}
export function cursor(value: unknown): string { return string(value, 1024); }
export const commands = ['getChatHost','listChats','createChat','getChat','getChatHistory','sendChat','getChatSend','stopChat'] as const;
export function command(value: unknown): ChatCommand {
  if (!commands.includes(value as ChatCommand)) return fail('InvalidInput', 'Unknown chat operation.');
  return value as ChatCommand;
}
export function input<K extends ChatCommand>(operation: K, value: unknown): ChatInput<K> {
  let result: unknown;
  switch(operation) {
    case 'getChatHost': {const d=object(value,['host']); result={host:host(d.host)}; break;}
    case 'listChats': {const d=object(value,['session','cursor']); result={session:session(d.session),...(d.cursor === undefined ? {} : {cursor:cursor(d.cursor)})}; break;}
    case 'createChat': {const d=object(value,['session','requestId','title']); result={session:session(d.session),requestId:id(d.requestId),title:string(d.title,200)}; break;}
    case 'getChat': {const d=object(value,['target']); result={target:target(d.target)}; break;}
    case 'getChatHistory': {const d=object(value,['target','cursor']); result={target:target(d.target),cursor:cursor(d.cursor)}; break;}
    case 'sendChat': {const d=object(value,['target','requestId','text']); result={target:target(d.target),requestId:id(d.requestId),text:string(d.text,maximumChatInputBytes)}; break;}
    case 'getChatSend': {const d=object(value,['target','requestId']); result={target:target(d.target),requestId:id(d.requestId)}; break;}
    case 'stopChat': {const d=object(value,['stop','requestId']); result={stop:stopTarget(d.stop),requestId:id(d.requestId)}; break;}
  }
  return result as ChatInput<K>;
}
export function sized<T>(value:T):T { if(Buffer.byteLength(JSON.stringify(value))>maximumChatReplyBytes-256) fail('InvalidInput','Chat reply exceeds its delivery limit.'); return value; }
export function preview(text: string, bytes = 4096) {
  let result='', used=0; for(const char of text.toWellFormed()) {const size=Buffer.byteLength(char); if(used+size>bytes) break; result+=char; used+=size;}
  return {text:result,truncated:result.length<text.length};
}
function bool(value: unknown): boolean { if(typeof value!=='boolean') return fail('Incompatible','Invalid chat flag.'); return value; }
function one<T extends string>(value:unknown, options:readonly T[]):T {if(!options.includes(value as T)) return fail('Incompatible','Invalid chat status.'); return value as T;}
function array(value: unknown, max: number):unknown[] {if(!Array.isArray(value)||value.length>max) return fail('Incompatible','Chat list exceeds its limit.'); return value;}
function summary(value: unknown): ChatSummary {
  const d=object(value); const createdAt=string(d.createdAt,64); if(!Number.isFinite(Date.parse(createdAt))) fail('Incompatible','Invalid chat timestamp.');
  return {target:target(d.target),title:string(d.title,200),createdAt,cwd:string(d.cwd,4096),model:string(d.model,512)};
}
function history(value:unknown):ChatHistoryPage {const d=object(value); return {entries:array(d.entries,32).map(value=>{
  const e=object(value); return {id:id(e.id),role:one(e.role,['user','assistant','tool','system'] as const),text:string(e.text,4096,true),truncated:bool(e.truncated),...(e.toolName===undefined?{}:{toolName:string(e.toolName,128)}),...(e.isError===undefined?{}:{isError:bool(e.isError)})};
}),olderCursor:d.olderCursor===null?null:cursor(d.olderCursor)};}
function snapshot(value:unknown):ChatSnapshot {
  const d=object(value); let run:ChatSnapshot['run']=null;
  if(d.run!==null) {const r=object(d.run); run={stop:stopTarget(r.stop),state:one(r.state,['running','stopping','deferred'] as const),text:string(r.text,4096,true),truncated:bool(r.truncated),tools:array(r.tools,8).map(value=>{const t=object(value); return {taskId:id(t.taskId),name:string(t.name,128),state:one(t.state,['running','completed','failed'] as const),text:string(t.text,4096,true),truncated:bool(t.truncated)};})};}
  const conversation=summary(d.conversation); if(run&&!sameTarget(run.stop.target,conversation.target)) fail('Incompatible','Run target differs from its conversation.');
  return {...history(d),conversation,run,state:one(d.state,['idle','running','stopped','failed','uncertain'] as const),...(d.message===undefined?{}:{message:string(d.message,512)})};
}
function receipt(value:unknown): ChatSendReceipt {const d=object(value); const base={target:target(d.target),requestId:id(d.requestId)};
  if(d.admission==='reserved'&&d.submissionId===null) return {...base,admission:'reserved',submissionId:null};
  if(d.admission==='admitted') return {...base,admission:'admitted',submissionId:id(d.submissionId)};
  return fail('Incompatible','Invalid Send receipt.');
}
/** Project network results explicitly; TypeScript types grant no remote authority. */
export function output<K extends ChatCommand>(operation:K,value:unknown,request:ChatInput<K>):ChatOutput<K> {
  const d=value===null?null:object(value); let result:unknown;
  switch(operation) {
    case 'getChatHost': {const x=d!; result={...session({host:x.host,actorId:x.actorId}),cwd:string(x.cwd,4096),model:string(x.model,512)}; break;}
    case 'listChats': result={conversations:array(d!.conversations,32).map(summary),nextCursor:d!.nextCursor===null?null:cursor(d!.nextCursor)}; break;
    case 'createChat': result={requestId:id(d!.requestId),conversation:summary(d!.conversation)}; break;
    case 'getChat': result=snapshot(value); break;
    case 'getChatHistory': result=history(value); break;
    case 'sendChat': result=receipt(value); break;
    case 'getChatSend': result=value===null?null:receipt(value); break;
    case 'stopChat': result={stop:stopTarget(d!.stop),requestId:id(d!.requestId),outcome:one(d!.outcome,['stopped','terminal','superseded','pending'] as const)}; break;
  }
  const r=result as Record<string,unknown>|null, q=request as Record<string,unknown>;
  const requestedSession=q.session as ChatSession|undefined;
  if(requestedSession) {
    const summaries=operation==='listChats'?(r!.conversations as ChatSummary[]):[(r!.conversation as ChatSummary)];
    if(summaries.some(s=>!sameHost(s.target.host,requestedSession.host)||s.target.actorId!==requestedSession.actorId)) fail('Incompatible','Chat authority changed.');
  }
  if(operation==='getChatHost'&&!sameHost((r!.host as ChatHostTarget),q.host as ChatHostTarget)) fail('Incompatible','Chat host changed.');
  if(q.target&&r) {const actual=operation==='getChat'?(r.conversation as ChatSummary).target:r.target as ChatTarget|undefined; if(actual&&!sameTarget(actual,q.target as ChatTarget)) fail('Incompatible','Chat target changed.');}
  if(q.requestId&&r?.requestId!==undefined&&q.requestId!==r.requestId) fail('Incompatible','Chat request identity changed.');
  if(operation==='stopChat'&&JSON.stringify(r!.stop)!==JSON.stringify(q.stop)) fail('Incompatible','Stop authority changed.');
  return sized(result) as ChatOutput<K>;
}
