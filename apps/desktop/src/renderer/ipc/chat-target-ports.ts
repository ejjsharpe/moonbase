import { Effect, Stream } from 'effect';
import { chatInputSchemas } from '@moonbase/contracts/chat-schema';
import { connectionInputSchemas } from '@moonbase/contracts/connection-schema';
import { providerInputSchemas } from '@moonbase/contracts/providers-schema';
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
    const call = (tag: string, payload: unknown) =>
      callEffect(tag as Tag, payload as Payload<Tag>, refusedChat).pipe(Effect.provideContext(ipc));
    const watch = (tag: string, payload: unknown) =>
      watchStream(tag as Tag, payload as Payload<Tag>, refusedChat).pipe(
        Stream.provideContext(ipc),
      );
    const commands = (operations: readonly string[], payload: (input: unknown) => unknown) =>
      Object.fromEntries(
        operations.map((operation) => [
          operation,
          (input: unknown) => call(operation, payload(input)),
        ]),
      );
    const chat = {
      ...commands(Object.keys(chatInputSchemas), (input) => ({ backendId, input })),
      watch: ({ target }: { target: unknown }) => watch('watchChat', { backendId, target }),
      watchChatList: ({ session }: { session: unknown }) =>
        watch('watchChatList', { backendId, session }),
    } as unknown as ChatPort;
    const providers = {
      ...commands(Object.keys(providerInputSchemas), (input) => ({ backendId, input })),
      watch: () => watch('watchProviders', { backendId }),
    } as unknown as ProviderSetupPort;
    const connection = {
      ...commands(Object.keys(connectionInputSchemas), (input) => ({ input })),
      watch: () => watch('watchConnection', undefined),
    } as unknown as ConnectionPort;
    return { chat, providers, connection };
  });
