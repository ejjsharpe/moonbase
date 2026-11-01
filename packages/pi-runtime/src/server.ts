import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Effect } from 'effect';
import type { ChatClient } from '@moonbase/application/chat-client';
import { createHostHealthReply, validateHostHealth } from '@moonbase/application/host-health';
import { chatHostVersion, chatProtocolVersion, type ChatHostTarget } from '@moonbase/application/host-client';
import { releaseResource } from '@moonbase/application/services';
import { ApplicationError } from '@moonbase/application/client';
import * as P from './protocol.ts';
import * as V from './validation.ts';

export type ChatServerConfiguration={host:ChatHostTarget;token:string;port:number};
/** The injected client is bound to the consumer's process root and shared handlers. */
export const serveChat=(config:ChatServerConfiguration,client:ChatClient)=>Effect.acquireRelease(Effect.tryPromise({try:async()=>{
  const expected=V.host(config.host),token=P.token(config.token);if(!Number.isInteger(config.port)||config.port<0||config.port>65535)V.fail('InvalidInput','Choose a valid loopback host port.');
  const health=validateHostHealth({...expected,protocol:chatProtocolVersion,version:chatHostVersion,capabilities:['chat-v0']},expected);
  const configuration=V.output('getChatHost',await client.command('getChatHost',{host:expected}),{host:expected});
  if(JSON.stringify(configuration).includes(token))V.fail('InvalidInput','Keep the private host key separate from public chat identities and settings.');
  const grants=new Map<string,{nonce:string;expires:number}>();
  let closed=false,active=0;
  const server=createServer((request,response)=>{if(active>=128){response.writeHead(503);response.end();return;}active++;void handle(request,response).catch(()=>{if(!response.headersSent){response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({ok:false,error:P.publicError(null)}));}else response.destroy();}).finally(()=>{active--;});});
  server.requestTimeout=20000;server.headersTimeout=10000;server.maxConnections=128;server.keepAliveTimeout=1000;
  async function handle(request:IncomingMessage,response:ServerResponse) {
    if(closed){response.writeHead(503);response.end();return;}
    response.setHeader('Cache-Control','no-store');
    if(request.method==='GET'&&request.url==='/v1/health') {
      try{await client.command('getChatHost',{host:expected});const value=createHostHealthReply({token,nonce:request.headers['x-moonbase-nonce'] as string|undefined,authorization:request.headers.authorization,health});response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(value));}
      catch(error){response.writeHead(ApplicationError.is(error)&&error.code==='Unauthorized'?401:503,{'content-type':'application/json'});response.end(JSON.stringify({ok:false,error:P.publicError(error)}));}return;
    }
    const clientNonce=request.headers['x-moonbase-nonce'];
    const auth=P.authorization(request.headers.authorization);
    if(!P.validNonce(clientNonce)){response.writeHead(401);response.end();return;}
    const send=(status:number,value:unknown,challenge?:string)=>{
      const body=JSON.stringify(value);if(Buffer.byteLength(body)>256*1024)V.fail('InvalidInput','Chat reply exceeds its delivery limit.');
      response.setHeader('X-Moonbase-Nonce',clientNonce);if(challenge)response.setHeader('X-Moonbase-Challenge',challenge);
      response.setHeader('X-Moonbase-Proof',challenge?P.mac(token,'response',clientNonce,challenge,status,P.hash(body)):P.mac(token,'challenge-response',clientNonce,status,P.hash(body)));
      response.writeHead(status,{'content-type':'application/json'});response.end(body);
    };
    if(request.method==='GET'&&request.url==='/v1/chat/challenge') {
      if(!P.proof(auth,P.mac(token,'challenge-request',clientNonce,'GET','/v1/chat/challenge'))){response.writeHead(401);response.end();return;}
      try{
        await client.command('getChatHost',{host:expected});
        const now=performance.now();for(const [challenge,grant]of grants)if(grant.expires<=now)grants.delete(challenge);
        if(grants.size>=128)return send(429,{ok:false,error:{code:'Unavailable',message:'Chat authentication capacity is full; retry later.'}});
        const challenge=P.nonce();grants.set(challenge,{nonce:clientNonce,expires:now+20000});send(200,{challenge,health});
      }catch(error){send(503,{ok:false,error:P.publicError(error)});}return;
    }
    if(request.method!=='POST'||request.url!=='/v1/chat'){response.writeHead(404);response.end();return;}
    const challenge=request.headers['x-moonbase-challenge'];
    if(!P.validNonce(challenge)){response.writeHead(401);response.end();return;}
    const chunks:Buffer[]=[];let length=0,authenticated=false;let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      timer=setTimeout(()=>request.destroy(),20000);
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']??''))V.fail('InvalidInput','Chat request must be JSON.');
      for await(const chunk of request){length+=chunk.length;if(length>64*1024)V.fail('InvalidInput','Chat input exceeds its transport limit.');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks,length),grant=grants.get(challenge);
      if(!grant||grant.nonce!==clientNonce||grant.expires<=performance.now()||!P.proof(auth,P.mac(token,'request',clientNonce,challenge,'POST','/v1/chat',P.hash(bytes)))){response.writeHead(401);response.end();return;}
      // No await may separate checking a grant from consuming it.
      grants.delete(challenge);
      authenticated=true;
      const envelope=V.object(P.json(bytes),['operation','input']),operation=V.command(envelope.operation),input=V.input(operation,envelope.input);
      const value=V.output(operation,await client.command(operation,input),input);send(200,{ok:true,value},challenge);
    }catch(error){
      if(authenticated)send(400,{ok:false,error:P.publicError(error)},challenge);
      else if(!response.destroyed){response.writeHead(400);response.end();}
    }finally{clearTimeout(timer);}
  }
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(config.port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')V.fail('Unavailable','Chat loopback listener did not open.');
  return {origin:`http://127.0.0.1:${(address as import('node:net').AddressInfo).port}`,close:async()=>{closed=true;grants.clear();await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}};
},catch:error=>ApplicationError.is(error)?error:new ApplicationError({code:'Unavailable',message:'Chat host could not acquire its loopback listener or backing service.'})}),server=>releaseResource(()=>server.close()));
