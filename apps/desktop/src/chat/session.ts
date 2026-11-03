import type { ManagedRuntime } from 'effect';
import { decodeConnectionInput, isConnectionCommand } from '@moonbase/contracts/connection-schema';
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
import { IpcLifetime } from '../ipc-lifetime.ts';

/** A window's bounded IPC waits and observations; commands still enter shared application handlers. */
export class ChatIpcSession {
  private lifetime: IpcLifetime;
  private chat: ChatClient;
  private connection: ConnectionClient;
  readonly context: ChatSession;
  private emit: (id: string, result: Reply) => void;
  constructor(
    runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
    chat: ChatClient,
    connection: ConnectionClient,
    context: ChatSession,
    emit: (id: string, result: Reply) => void,
  ) {
    this.lifetime = new IpcLifetime(runtime, 64, errorDTO);
    this.chat = chat;
    this.connection = connection;
    this.context = context;
    this.emit = emit;
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
    for (const name of ['target', 'session', 'stop'])
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
    if (kind === 'chat') {
      if (!isChatCommand(operation)) return invalid();
      v = decodeChatInput(operation, v);
      this.authority(v);
    } else if (kind === 'connection') {
      if (!isConnectionCommand(operation)) invalid();
      v = decodeConnectionInput(operation as ConnectionCommand, v);
    } else if (kind === 'watch-chat') {
      if (operation !== '') invalid();
      v = decodeChatInput('getChat', v);
      this.authority(v);
    } else if (kind === 'watch-connection') {
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
            : this.connection.watch(receive, error),
        );
        return { ok: true, value: null };
      }
      const value =
        kind === 'chat'
          ? await this.chat.command(operation as ChatCommand, v as never, {
              signal: request.signal,
            })
          : await this.connection.command(operation as ConnectionCommand, v as never, {
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
