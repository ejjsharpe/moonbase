import { decodeChatInput, isChatCommand } from '@moonbase/application/chat-schema';
import { ApplicationError } from '@moonbase/application/client';
import type { ChatClient, ChatCommand, ChatSession } from '@moonbase/application/chat-client';
import type { ConnectionClient, ConnectionCommand } from '@moonbase/application/connection-client';
import {
  connectionFields,
  fields,
  record,
  requestId,
  errorDTO,
  invalid,
  type Reply,
} from './wire.ts';

/** A window's bounded IPC waits and observations; commands still enter shared application handlers. */
export class ChatIpcSession {
  private work = new Map<
    string,
    {
      stop: () => void | Promise<void>;
      complete: () => void;
      completion: Promise<void>;
      watch: boolean;
      closing?: Promise<void>;
      cancelled: boolean;
    }
  >();
  private generation = 0;
  private closed = false;
  private cleanup: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;
  private closing = new Map<string, Promise<Reply>>();
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
    const watch = kind === 'watch-chat' || kind === 'watch-connection';
    if (
      this.closed ||
      this.work.has(id) ||
      this.closing.has(id) ||
      [...this.work.values()].filter((request) => request.watch === watch).length >= 64
    )
      invalid();
    if (typeof operation !== 'string' || JSON.stringify(input).length > 65536) return invalid();
    let v = record(input);
    if (kind === 'chat') {
      if (!isChatCommand(operation)) return invalid();
      v = decodeChatInput(operation, v);
      this.authority(v);
    } else if (kind === 'connection') {
      if (!Object.hasOwn(connectionFields, operation)) invalid();
      const spec = connectionFields[operation as ConnectionCommand];
      if (!spec) invalid();
      fields(v, spec);
    } else if (kind === 'watch-chat') {
      if (operation !== '') invalid();
      v = decodeChatInput('getChat', v);
      this.authority(v);
    } else if (kind === 'watch-connection') {
      if (operation !== '') invalid();
      fields(v, []);
    } else invalid();
    const abort = new AbortController();
    const generation = this.generation,
      done = Promise.withResolvers<void>(),
      request = {
        stop: (): void | Promise<void> => abort.abort(),
        complete: () => done.resolve(),
        completion: done.promise,
        watch: kind === 'watch-chat' || kind === 'watch-connection',
        cancelled: false,
        closing: undefined as Promise<void> | undefined,
      };
    const live = () => !this.closed && generation === this.generation && !request.cancelled;
    this.work.set(id, request);
    try {
      if (kind === 'watch-chat' || kind === 'watch-connection') {
        const receive = (value: unknown) => {
            if (live()) this.emit(id, { ok: true, value });
          },
          error = (e: ApplicationError) => {
            if (live()) this.emit(id, errorDTO(e));
          };
        request.stop =
          kind === 'watch-chat'
            ? this.chat.watch(v as never, receive, error)
            : this.connection.watch(receive, error);
        if (!live()) await this.closeRequest(id, request);
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
      if (!request.closing) request.watch = false;
      return errorDTO(e);
    } finally {
      if (!request.watch) {
        if (this.work.get(id) === request) this.work.delete(id);
        request.complete();
      }
    }
  }
  private closeRequest(
    id: string,
    request: {
      stop: () => void | Promise<void>;
      complete: () => void;
      completion: Promise<void>;
      watch: boolean;
      cancelled: boolean;
      closing?: Promise<void>;
    },
  ): Promise<void> {
    if (!request.closing) {
      request.cancelled = true;
      request.closing = (async () => {
        try {
          await request.stop();
          if (!request.watch) await request.completion;
        } finally {
          if (this.work.get(id) === request) this.work.delete(id);
        }
      })();
    }
    return request.closing;
  }
  cancel(id: unknown): Promise<Reply> {
    requestId(id);
    const previous = this.closing.get(id);
    if (previous) return previous;
    const request = this.work.get(id);
    if (!request) return Promise.resolve({ ok: true, value: null });
    const completion = this.closeRequest(id, request).then<Reply, Reply>(
      () => ({ ok: true, value: null }),
      errorDTO,
    );
    this.closing.set(id, completion);
    return completion;
  }
  releaseDocument() {
    this.generation++;
    const pending = [...this.work].map(([id, request]) => this.closeRequest(id, request));
    this.work.clear();
    this.closing.clear();
    const previous = this.cleanup;
    this.cleanup = (async () => {
      const results = await Promise.allSettled([previous, ...pending]);
      const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
      if (failures.length)
        throw new ApplicationError({
          code: 'Unavailable',
          message: failures.map((error) => ApplicationError.fromUnknown(error).message).join('; '),
        });
    })();
    return this.cleanup;
  }
  dispose() {
    if (!this.disposal) {
      this.closed = true;
      this.disposal = this.releaseDocument();
    }
    return this.disposal;
  }
  get count() {
    return this.work.size;
  }
}
