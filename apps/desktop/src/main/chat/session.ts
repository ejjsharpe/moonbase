import { randomBytes, randomUUID } from 'node:crypto';
import type { ManagedRuntime } from 'effect';
import type { ObservationClose } from '@moonbase/contracts/common';
import { LRUCache } from 'lru-cache';
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
import {
  fields,
  record,
  requestId,
  errorReply,
  invalid,
  isChatWatchKind,
  type Reply,
  type TranscriptImage,
} from '../../ipc/chat-wire.ts';
import {
  copyTranscript,
  decodeTranscriptCopy,
  decodeTranscriptImage,
  decodeTranscriptLink,
  readTranscriptImage,
  transcriptImagePath,
  type NativeTranscriptActions,
  type TranscriptImageReader,
} from './transcript-native.ts';
import { IpcLifetime } from '../ipc-lifetime.ts';

/** Images mount with a fresh URL, so an unrequested binding can lapse. */
export const transcriptImageTokenLifetime = 10 * 60 * 1000;
/** Concurrent stored-image reads; later ones queue, leaving request capacity for Stop and other commands. */
const maximumImageReads = 6;
/** Image requests the renderer never aborts must not grow the queue without bound. */
const maximumQueuedImageReads = 64;
type ImageBinding = { key: string; image: TranscriptImage };
type ImageReadWaiter = { resolve(): void; reject(error: ApplicationError): void };
const makeImageReadCancelledError = () =>
  new ApplicationError({ code: 'Cancelled', message: 'Image read cancelled.' });
const makeImageReadsBusyError = () =>
  new ApplicationError({ code: 'Unavailable', message: 'Image reads are busy.' });

/** A window's bounded IPC waits and observations; commands still enter shared application handlers. */
export class ChatIpcSession {
  private lifetime: IpcLifetime;
  private chat: ChatClient;
  private connection: ConnectionClient | null;
  private capabilities: ChatIpcCapabilities;
  private copies = 0;
  /** Opaque image URL tokens; they expire unless requested, and the session revokes them on close. */
  private images: LRUCache<string, ImageBinding>;
  /** Image identity to its current token, so equal bindings reuse one URL. */
  private imageTokens = new Map<string, string>();
  private imageReads = 0;
  private imageReadQueue: ImageReadWaiter[] = [];
  /** In-flight image request IDs, cancelled when their URLs are revoked. */
  private imageRequests = new Set<string>();
  private closed = false;
  readonly context: ChatSession;
  private emit: (id: string, result: Reply) => void;
  constructor(
    runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
    chat: ChatClient,
    backend: ChatIpcBackend,
    context: ChatSession,
    emit: (id: string, result: Reply) => void,
    capabilities: ChatIpcCapabilities = {},
  ) {
    this.lifetime = new IpcLifetime(runtime, 64, errorReply);
    this.chat = chat;
    this.connection = backend.mode === 'remote' ? backend.connection : null;
    this.context = context;
    this.emit = emit;
    this.capabilities = capabilities;
    this.images = new LRUCache({
      max: 256,
      ttl: transcriptImageTokenLifetime,
      ttlResolution: 0,
      updateAgeOnGet: true,
      ...(capabilities.perf ? { perf: capabilities.perf } : {}),
      dispose: ({ key }, token) => {
        if (this.imageTokens.get(key) === token) this.imageTokens.delete(key);
      },
    });
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
    const watch = isChatWatchKind(kind);
    if (this.lifetime.getAdmissionError(id, watch)) invalid();
    if (typeof operation !== 'string') invalid();
    try {
      if (Buffer.byteLength(JSON.stringify(input)) > maximumChatRequestBytes) invalid();
    } catch {
      invalid();
    }
    let v = record(input);
    if (kind === 'transcript' && operation === 'image') {
      const image = decodeTranscriptImage(v);
      this.authority(image);
      return { ok: true, value: this.issueImage(image) };
    }
    if (kind === 'transcript') {
      if (!this.capabilities.transcript || !['copy', 'open-link'].includes(operation as string))
        invalid();
      if (operation === 'copy') {
        if (this.copies >= 2)
          throw new ApplicationError({
            code: 'Unavailable',
            message: 'Another Copy is in progress. Try again when it finishes.',
          });
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
    } else if (kind === 'watch-chat-list') {
      if (operation !== '') invalid();
      v = { session: decodeChatInput('listChats', v).session };
      this.authority(v);
    } else if (kind === 'watch-connection' || kind === 'watch-providers') {
      if (kind === 'watch-connection' ? !this.connection : !this.capabilities.providers)
        return invalid();
      if (operation !== '') invalid();
      fields(v, []);
    } else invalid();
    const request = this.lifetime.reserveRequest(id, watch);
    const live = request.isLive;
    try {
      if (watch) {
        const receive = (value: unknown) => {
            if (live()) this.emit(id, { ok: true, value });
          },
          delivered = (e: ApplicationError) => {
            failed = true;
            if (live()) this.emit(id, errorReply(e));
          };
        let failed = false;
        await request.acquireWatch(() => {
          let close: ObservationClose;
          if (kind === 'watch-chat') close = this.chat.watch(v as never, receive, delivered);
          else if (kind === 'watch-chat-list')
            close = this.chat.watchChatList(v as never, receive, delivered);
          else if (kind === 'watch-providers')
            close = this.capabilities.providers!.watch(receive, delivered);
          else close = this.connection!.watch(receive, delivered);
          // A failure the watch delivered is its outcome, not a failure to clean it up.
          return () =>
            close().catch((cause: unknown) => (failed ? undefined : Promise.reject(cause)));
        });
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
      let value: unknown;
      if (kind === 'providers')
        value = await this.capabilities.providers!.command(operation as never, v as never, {
          signal: request.signal,
        });
      else if (kind === 'chat')
        value = await this.chat.command(operation as ChatCommand, v as never, {
          signal: request.signal,
        });
      else if (operation === 'getConnection')
        value = await this.connection!.command(operation, v as never, { signal: request.signal });
      else {
        // Image URLs belong to the connection that issued them, including ones issued mid-change.
        this.revokeImages();
        try {
          value = await this.connection!.command(operation as ConnectionCommand, v as never, {
            signal: request.signal,
          });
        } finally {
          this.revokeImages();
        }
      }
      return { ok: true, value };
    } catch (e) {
      request.fail();
      return errorReply(e);
    } finally {
      await request.finish();
    }
  }
  private issueImage(image: TranscriptImage) {
    const key = JSON.stringify(image);
    const issued = this.imageTokens.get(key);
    // Reuse refreshes the binding's age and recency.
    if (issued && this.images.get(issued))
      return `moonbase://editor${transcriptImagePath}${issued}`;
    const token = randomBytes(32).toString('base64url');
    this.images.set(token, { key, image });
    this.imageTokens.set(key, token);
    return `moonbase://editor${transcriptImagePath}${token}`;
  }
  findImage(token: string): TranscriptImageReader | undefined {
    const image = this.images.get(token)?.image;
    return image && { image, read: (signal) => this.readImage(image, signal) };
  }
  /** Revokes every issued URL, fails queued reads and cancels in-flight ones. */
  private revokeImages() {
    this.images.clear();
    const queued = this.imageReadQueue;
    this.imageReadQueue = [];
    for (const waiter of queued) waiter.reject(makeImageReadCancelledError());
    for (const id of this.imageRequests) void this.lifetime.cancel(id);
  }
  private async acquireImageRead(signal: AbortSignal) {
    if (this.closed || signal.aborted) throw makeImageReadCancelledError();
    if (this.imageReads < maximumImageReads) {
      this.imageReads++;
      return;
    }
    if (this.imageReadQueue.length >= maximumQueuedImageReads) throw makeImageReadsBusyError();
    const queued = Promise.withResolvers<void>();
    const waiter: ImageReadWaiter = { resolve: queued.resolve, reject: queued.reject };
    const abort = () => {
      this.imageReadQueue = this.imageReadQueue.filter((next) => next !== waiter);
      queued.reject(makeImageReadCancelledError());
    };
    signal.addEventListener('abort', abort, { once: true });
    this.imageReadQueue.push(waiter);
    try {
      await queued.promise;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  private releaseImageRead() {
    const next = this.imageReadQueue.shift();
    // Hand the slot straight to the next waiter so the count never exceeds the limit.
    if (next) next.resolve();
    else this.imageReads--;
  }
  private async readImage(image: TranscriptImage, signal: AbortSignal) {
    await this.acquireImageRead(signal);
    try {
      const id = `image:${randomUUID()}`;
      if (signal.aborted || this.lifetime.getAdmissionError(id, false))
        throw makeImageReadsBusyError();
      const request = this.lifetime.reserveRequest(id, false);
      const cancel = () => void this.lifetime.cancel(id);
      signal.addEventListener('abort', cancel, { once: true });
      this.imageRequests.add(id);
      try {
        return await readTranscriptImage(this.chat, image, request);
      } finally {
        this.imageRequests.delete(id);
        signal.removeEventListener('abort', cancel);
        await request.finish();
      }
    } finally {
      this.releaseImageRead();
    }
  }
  cancel(id: unknown): Promise<Reply> {
    requestId(id);
    return this.lifetime.cancel(id);
  }
  dispose() {
    this.closed = true;
    this.revokeImages();
    return this.lifetime.dispose();
  }
  get count() {
    return this.lifetime.count;
  }
}
/** What a session's backend is: a local daemon's chat, or a remote host's with its connection. */
export type ChatIpcBackend = { mode: 'local' } | { mode: 'remote'; connection: ConnectionClient };
export type ChatIpcCapabilities = {
  providers?: ProviderSetupClient;
  transcript?: NativeTranscriptActions;
  /** lru-cache clock for image URL expiry; tests inject one. */
  perf?: { now(): number };
};
