import { ApplicationError } from '@moonbase/application/client';
import type { ChatClient, ChatCommand, ChatSession } from '@moonbase/application/chat-client';
import type { ConnectionClient, ConnectionCommand } from '@moonbase/application/connection-client';
import {
  chatFields,
  connectionFields,
  fields,
  record,
  requestId,
  errorDTO,
  invalid,
  type Reply,
} from './wire.ts';

/** A window's bounded IPC waits and observations; commands still enter shared application handlers. */
export class ProofSession {
  private work = new Map<string, () => void>();
  private chat: ChatClient;
  private connection: ConnectionClient;
  readonly context: ChatSession;
  private emit: (id: string, result: Reply) => void;
  constructor(
    chat: ChatClient,
    connection: ConnectionClient,
    context: ChatSession,
    emit: (id: string, result: Reply) => void,
  ) {
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
    if (this.work.has(id) || this.work.size >= 64) invalid();
    if (typeof operation !== 'string' || JSON.stringify(input).length > 65536) return invalid();
    const v = record(input);
    if (kind === 'chat') {
      if (!Object.hasOwn(chatFields, operation)) invalid();
      const spec = chatFields[operation as ChatCommand];
      if (!spec) invalid();
      fields(v, spec[0], spec[1]);
      this.authority(v);
    } else if (kind === 'connection') {
      if (!Object.hasOwn(connectionFields, operation)) invalid();
      const spec = connectionFields[operation as ConnectionCommand];
      if (!spec) invalid();
      fields(v, spec);
    } else if (kind === 'watch-chat') {
      if (operation !== '') invalid();
      fields(v, ['target']);
      this.authority(v);
    } else if (kind === 'watch-connection') {
      if (operation !== '') invalid();
      fields(v, []);
    } else invalid();
    const abort = new AbortController();
    let stop = () => abort.abort();
    this.work.set(id, () => stop());
    try {
      if (kind === 'watch-chat' || kind === 'watch-connection') {
        const receive = (value: unknown) => this.emit(id, { ok: true, value }),
          error = (e: ApplicationError) => this.emit(id, errorDTO(e));
        stop =
          kind === 'watch-chat'
            ? this.chat.watch(v as never, receive, error)
            : this.connection.watch(receive, error);
        return { ok: true, value: null };
      }
      const value =
        kind === 'chat'
          ? await this.chat.command(operation as ChatCommand, v as never, { signal: abort.signal })
          : await this.connection.command(operation as ConnectionCommand, v as never, {
              signal: abort.signal,
            });
      return { ok: true, value };
    } catch (e) {
      return errorDTO(e);
    } finally {
      if (kind !== 'watch-chat' && kind !== 'watch-connection') this.work.delete(id);
    }
  }
  cancel(id: unknown) {
    requestId(id);
    this.work.get(id)?.();
    this.work.delete(id);
  }
  dispose() {
    for (const stop of this.work.values()) stop();
    this.work.clear();
  }
  get count() {
    return this.work.size;
  }
}
