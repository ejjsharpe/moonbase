import { Effect, Layer, Stream, Schedule } from 'effect';
import { ApplicationError } from '@moonbase/application/client';
import type { ChatCommand, ChatInput, ChatOutput, ChatTarget } from '@moonbase/application/chat-client';
import { ChatService, ConnectionService, type ChatServiceShape } from '@moonbase/application/services';
import { validateHostHealth } from '@moonbase/application/host-health';
import * as P from './protocol.ts';
import * as V from './validation.ts';

/** Client graph imports no engine, SQLite, provider or local workspace implementation. */
export const RemoteChatLive:Layer.Layer<ChatService,never,ConnectionService>=Layer.effect(ChatService,Effect.gen(function*(){
  const connections=yield* ConnectionService;
  const call=<K extends ChatCommand>(operation:K,unknown:ChatInput<K>):Effect.Effect<ChatOutput<K>,ApplicationError>=>Effect.gen(function*(){
    const input=yield* Effect.try({try:()=>V.input(operation,unknown),catch:ApplicationError.fromUnknown});
    const shape=input as {host?:{hostId:string;storeId:string};session?:{host:{hostId:string;storeId:string}};target?:ChatTarget;stop?:{target:ChatTarget}};
    const host=shape.host??shape.session?.host??shape.target?.host??shape.stop!.target.host;
    const endpoint=yield* connections.endpoint({host});
    const assertGeneration=Effect.flatMap(connections.endpoint({host}),current=>current.connectionId===endpoint.connectionId&&current.origin===endpoint.origin&&current.token===endpoint.token&&V.sameHost(current.expected,endpoint.expected)?Effect.void:Effect.fail(new ApplicationError({code:'Unavailable',message:'Connection generation changed; query through the selected authority again.'})));
    const prepared=yield* Effect.try({try:()=>({origin:P.origin(endpoint),nonce:P.nonce()}),catch:ApplicationError.fromUnknown});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    return yield* Effect.ensuring(Effect.gen(function*(){
      const challenge=yield* Effect.tryPromise({try:async signal=>{
        const response=await fetch(`${prepared.origin}/v1/chat/challenge`,{headers:{'X-Moonbase-Nonce':prepared.nonce,Authorization:`Moonbase-RPC-HMAC-SHA256 ${P.mac(endpoint.token,'challenge-request',prepared.nonce,'GET','/v1/chat/challenge')}`},redirect:'error',signal:AbortSignal.any([signal,controller.signal]),cache:'no-store',credentials:'omit'});
        const bytes=await P.responseBytes(response,8192);
        if(response.headers.get('x-moonbase-nonce')!==prepared.nonce||!P.proof(response.headers.get('x-moonbase-proof'),P.mac(endpoint.token,'challenge-response',prepared.nonce,response.status,P.hash(bytes))))V.fail('Unauthorized','Chat host did not prove its challenge.');
        if(response.status!==200)V.fail('Unavailable','Chat host could not issue a challenge.');
        const data=V.object(P.json(bytes));validateHostHealth(data.health,host);if(!P.validNonce(data.challenge))V.fail('Incompatible','Chat host returned an invalid challenge.');return data.challenge as string;
      },catch:error=>ApplicationError.is(error)?error:new ApplicationError({code:'Unavailable',message:'Chat challenge could not be verified within its deadline.'})});
      yield* assertGeneration;
      const result=yield* Effect.tryPromise({try:async signal=>{
        const body=JSON.stringify({operation,input});if(Buffer.byteLength(body)>64*1024)V.fail('InvalidInput','Chat input exceeds its transport limit.');
        const response=await fetch(`${prepared.origin}/v1/chat`,{method:'POST',body,headers:{'content-type':'application/json','X-Moonbase-Nonce':prepared.nonce,'X-Moonbase-Challenge':challenge,Authorization:`Moonbase-RPC-HMAC-SHA256 ${P.mac(endpoint.token,'request',prepared.nonce,challenge,'POST','/v1/chat',P.hash(body))}`},redirect:'error',signal:AbortSignal.any([signal,controller.signal]),cache:'no-store',credentials:'omit'});
        const bytes=await P.responseBytes(response,256*1024);
        if(response.headers.get('x-moonbase-nonce')!==prepared.nonce||response.headers.get('x-moonbase-challenge')!==challenge||!P.proof(response.headers.get('x-moonbase-proof'),P.mac(endpoint.token,'response',prepared.nonce,challenge,response.status,P.hash(bytes))))V.fail('Unauthorized','Chat host did not prove its response.');
        const envelope=V.object(P.json(bytes));
        if(envelope.ok!==true){const error=V.object(envelope.error);const code=P.codes.find(x=>x===error.code);if(!code)V.fail('Incompatible','Chat returned an invalid error.');throw new ApplicationError({code:code!,message:P.publicError(new ApplicationError({code:code!,message:''})).message});}
        if(response.status!==200)V.fail('Incompatible','Chat reply has an unexpected status.');return V.output(operation,envelope.value,input);
      },catch:error=>ApplicationError.is(error)?error:new ApplicationError({code:'Uncertain',message:'Chat reply was lost. Query the original request; do not invent another Send.'})});
      yield* assertGeneration;return result;
    }),Effect.sync(()=>{clearTimeout(timer);controller.abort();}));
  });
  return {getChatHost:d=>call('getChatHost',d),listChats:d=>call('listChats',d),createChat:d=>call('createChat',d),getChat:d=>call('getChat',d),getChatHistory:d=>call('getChatHistory',d),sendChat:d=>call('sendChat',d),getChatSend:d=>call('getChatSend',d),stopChat:d=>call('stopChat',d),watch:({target})=>Stream.fromEffectSchedule(call('getChat',{target}),Schedule.spaced('250 millis'))} satisfies ChatServiceShape;
}));
