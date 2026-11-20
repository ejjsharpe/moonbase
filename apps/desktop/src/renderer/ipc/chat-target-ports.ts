import { Effect, Stream } from 'effect';
import type { ChatPort, ConnectionPort, ProviderSetupPort } from '@moonbase/application/chat';
import type { ChatTargetId } from '../../ipc/chat-rpcs.ts';
import type { DesktopIpc } from './desktop-ipc.ts';
import { callEffect, watchStream, type Payload, type Refusal, type Tag } from './ipc-failures.ts';

const refusedChat: Refusal = 'chat-request';
/**
 * One chat target's chat, provider setup and (for the remote host) connection ports: each command
 * and watch is main's procedure over this document's IPC port, failing with the error main sends
 * or the renderer's own.
 */
export const makeChatTargetPorts = (backendId: ChatTargetId) =>
  Effect.map(Effect.context<DesktopIpc>(), (ipc) => {
    const call = <T extends Tag>(tag: T, payload: Payload<T>) =>
      callEffect(tag, payload, refusedChat).pipe(Effect.provideContext(ipc));
    const watch = <T extends Tag>(tag: T, payload: Payload<T>) =>
      watchStream(tag, payload, refusedChat).pipe(Stream.provideContext(ipc));
    const chat: ChatPort = {
      getChatHost: (input) => call('getChatHost', { backendId, input }),
      listChats: (input) => call('listChats', { backendId, input }),
      createChat: (input) => call('createChat', { backendId, input }),
      getChat: (input) => call('getChat', { backendId, input }),
      getChatHistory: (input) => call('getChatHistory', { backendId, input }),
      getChatTranscriptContent: (input) => call('getChatTranscriptContent', { backendId, input }),
      findChatTranscript: (input) => call('findChatTranscript', { backendId, input }),
      getChatHistoryAround: (input) => call('getChatHistoryAround', { backendId, input }),
      sendChat: (input) => call('sendChat', { backendId, input }),
      getChatSend: (input) => call('getChatSend', { backendId, input }),
      stopChat: (input) => call('stopChat', { backendId, input }),
      settleChat: (input) => call('settleChat', { backendId, input }),
      findChatFiles: (input) => call('findChatFiles', { backendId, input }),
      watch: ({ target }) => watch('watchChat', { backendId, target }),
      watchChatList: ({ session }) => watch('watchChatList', { backendId, session }),
    };
    const providers: ProviderSetupPort = {
      getProviders: (input) => call('getProviders', { backendId, input }),
      startProviderLogin: (input) => call('startProviderLogin', { backendId, input }),
      answerProviderPrompt: (input) => call('answerProviderPrompt', { backendId, input }),
      cancelProviderLogin: (input) => call('cancelProviderLogin', { backendId, input }),
      openProviderUrl: (input) => call('openProviderUrl', { backendId, input }),
      logoutProvider: (input) => call('logoutProvider', { backendId, input }),
      watch: () => watch('watchProviders', { backendId }),
    };
    const connection: ConnectionPort = {
      getConnection: (input) => call('getConnection', { input }),
      connect: (input) => call('connect', { input }),
      disconnect: (input) => call('disconnect', { input }),
      watch: () => watch('watchConnection', undefined),
    };
    return { chat, providers, connection };
  });
