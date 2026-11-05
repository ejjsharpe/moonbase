import type { ManagedRuntime } from 'effect';
import { decodeConnectionInput, isConnectionCommand } from '@moonbase/contracts/connection-schema';
import type { ProviderSetupClient } from '@moonbase/contracts/providers';
import { decodeProviderInput, isProviderCommand } from '@moonbase/contracts/providers-schema';
import { decodeChatInput, isChatCommand } from '@moonbase/contracts/chat-schema';
import { ApplicationError } from '@moonbase/contracts/workspace';
import {
  maximumChatRequestBytes,
  type ChatClient,
  type ChatCommand,
  type ChatSession,
} from '@moonbase/contracts/chat';
import type { ConnectionClient, ConnectionCommand } from '@moonbase/contracts/connection';
import { fields, record, requestId, errorDTO, invalid, type Reply } from './wire.ts';
import {
  copyTranscript,
  decodeTranscriptCopy,
  decodeTranscriptLink,
  type NativeTranscriptActions,
} from './transcript-native.ts';
import { IpcLifetime } from '../ipc-lifetime.ts';

/** A window's bounded IPC waits and observations; commands still enter shared application handlers. */
export class ChatIpcSession {
  private lifetime: IpcLifetime;
  private chat: ChatClient;
  private connection: ConnectionClient | null;
  private capabilities: {
    providers?: ProviderSetupClient;
    transcript?: NativeTranscriptActions;
  };
  private copies = 0;
  readonly context: ChatSession;
  private emit: (id: string, result: Reply) => void;
  constructor(
    runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
    chat: ChatClient,
    connection: ConnectionClient | null,
    context: ChatSession,
    emit: (id: string, result: Reply) => void,
    capabilities: {
      providers?: ProviderSetupClient;
      transcript?: NativeTranscriptActions;
    } = {},
  ) {
    this.lifetime = new IpcLifetime(runtime, 64, errorDTO);
    this.chat = chat;
    this.connection = connection;
    this.context = context;
    this.emit = emit;
    this.capabilities = capabilities;
  }
  private authority(value: unknown) {
    const v = record(value);
    if (v.host !== undefined) {
      const h = record(v.host);
      fields(h, ['hostId', 'storeId']);
      if (h.hostId !== this.context.host.hostId || h.storeId !== this.context.host.storeId)
        throw new ApplicationError({
          code: 'Unauthorized',
          message: 'Use the configured host and store.',
        });
    }
    if (v.actorId !== undefined && v.actorId !== this.context.actorId)
      throw new ApplicationError({ code: 'Unauthorized', message: 'Use the configured actor.' });
    for (const name of ['target', 'session', 'stop', 'source'])
      if (v[name] !== undefined) this.authority(v[name]);
  }
  async call(kind: unknown, operation: unknown, input: unknown, id: unknown): Promise<Reply> {
    requestId(id);
    const watch = kind === 'watch-chat' || kind === 'watch-connection';
    if (this.lifetime.getAdmissionError(id, watch)) invalid();
    if (typeof operation !== 'string') invalid();
    try {
      if (Buffer.byteLength(JSON.stringify(input)) > maximumChatRequestBytes) invalid();
    } catch {
      invalid();
    }
    let v = record(input);
    if (kind === 'transcript') {
      if (!this.capabilities.transcript || !['copy', 'open-link'].includes(operation as string))
        invalid();
      if (operation === 'copy') {
        if (this.copies >= 2) invalid();
        v = decodeTranscriptCopy(v);
        this.authority(v);
      } else v = { url: decodeTranscriptLink(v) };
    } else if (kind === 'chat') {
      if (!isChatCommand(operation)) return invalid();
      v = decodeChatInput(operation, v);
      this.authority(v);
    } else if (kind === 'providers') {
      if (!this.capabilities.providers || !isProviderCommand(operation)) return invalid();
      v = decodeProviderInput(operation, v);
    } else if (kind === 'connection') {
      if (!this.connection) return invalid();
      if (!isConnectionCommand(operation)) invalid();
      v = decodeConnectionInput(operation as ConnectionCommand, v);
    } else if (kind === 'watch-chat') {
      if (operation !== '') invalid();
      v = decodeChatInput('getChat', v);
      this.authority(v);
    } else if (kind === 'watch-connection') {
      if (!this.connection) return invalid();
      if (operation !== '') invalid();
      fields(v, []);
    } else invalid();
    const request = this.lifetime.reserveRequest(id, watch);
    const live = request.isLive;
    try {
      if (kind === 'watch-chat' || kind === 'watch-connection') {
        const receive = (value: unknown) => {
            if (live()) this.emit(id, { ok: true, value });
          },
          error = (e: ApplicationError) => {
            if (live()) this.emit(id, errorDTO(e));
          };
        await request.acquireWatch(() =>
          kind === 'watch-chat'
            ? this.chat.watch(v as never, receive, error)
            : this.connection!.watch(receive, error),
        );
        return { ok: true, value: null };
      }
      if (kind === 'transcript') {
        if (operation === 'copy') {
          this.copies++;
          try {
            await copyTranscript(this.chat, v as never, request, this.capabilities.transcript!);
          } finally {
            this.copies--;
          }
        } else {
          if (!live())
            throw new ApplicationError({ code: 'Cancelled', message: 'Link opening cancelled.' });
          try {
            await this.capabilities.transcript!.openExternal(v.url as string);
          } catch {
            throw new ApplicationError({
              code: 'Unavailable',
              message: 'Could not open the link in your browser. Try again.',
            });
          }
          if (!live())
            throw new ApplicationError({
              code: 'Cancelled',
              message: 'Link opening was cancelled after it began.',
            });
        }
        return { ok: true, value: null };
      }
      if (kind === 'chat' && operation === 'createChat') {
        const settings = (v as { settings?: unknown }).settings;
        if ((this.connection === null) !== (settings !== undefined)) return invalid();
      }
      let value: unknown;
      if (kind === 'providers')
        value = await this.capabilities.providers!.command(operation as never, v as never, {
          signal: request.signal,
        });
      else if (kind === 'chat')
        value = await this.chat.command(operation as ChatCommand, v as never, {
          signal: request.signal,
        });
      else
        value = await this.connection!.command(operation as ConnectionCommand, v as never, {
          signal: request.signal,
        });
      return { ok: true, value };
    } catch (e) {
      request.fail();
      return errorDTO(e);
    } finally {
      await request.finish();
    }
  }
  cancel(id: unknown): Promise<Reply> {
    requestId(id);
    return this.lifetime.cancel(id);
  }
  releaseDocument() {
    return this.lifetime.releaseDocument();
  }
  dispose() {
    return this.lifetime.dispose();
  }
  get count() {
    return this.lifetime.count;
  }
}
