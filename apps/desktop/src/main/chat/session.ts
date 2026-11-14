import { randomBytes } from 'node:crypto';
import { Effect, Exit, Fiber, Scope, type ManagedRuntime } from 'effect';
import { LRUCache } from 'lru-cache';
import { normalizeApplicationError } from '@moonbase/effect';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatClient, ChatSession } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import type { ProviderSetupClient } from '@moonbase/contracts/providers';
import type { TranscriptImage } from '../../ipc/chat-rpcs.ts';
import {
  readTranscriptImage,
  transcriptImagePath,
  type NativeTranscriptActions,
  type TranscriptImageReader,
} from './transcript-native.ts';

/** Images mount with a fresh URL, so an unrequested binding can lapse. */
export const transcriptImageTokenLifetime = 10 * 60 * 1000;
/** Concurrent stored-image reads; later ones queue. */
const maximumImageReads = 6;
/** Image requests the renderer never aborts must not grow the queue without bound. */
const maximumQueuedImageReads = 64;
/** Copies one session runs at once; another is refused as busy. */
export const maximumTranscriptCopies = 2;
type ImageBinding = { key: string; image: TranscriptImage };
type ImageReadWaiter = { resolve(): void; reject(error: ApplicationError): void };
const makeImageReadCancelledError = () =>
  new ApplicationError({ code: 'Cancelled', message: 'Image read cancelled.' });
const makeImageReadsBusyError = () =>
  new ApplicationError({ code: 'Unavailable', message: 'Image reads are busy.' });

/**
 * One chat target's clients for the window's current document, with the transcript image URLs it
 * issued and the Copies it runs. The IPC handlers check requests against its context.
 */
export class ChatIpcSession {
  readonly chat: ChatClient;
  readonly connection: ConnectionClient | null;
  readonly capabilities: ChatIpcCapabilities;
  readonly context: ChatSession;
  /** Copies running; at most `maximumTranscriptCopies`. */
  copies = 0;
  private runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>;
  /** Opaque image URL tokens; they expire unless requested, and the session revokes them on close. */
  private images: LRUCache<string, ImageBinding>;
  /** Image identity to its current token, so equal bindings reuse one URL. */
  private imageTokens = new Map<string, string>();
  private imageReads = 0;
  private imageReadQueue: ImageReadWaiter[] = [];
  /** Running image reads; revoking the URLs closes it, which cancels them. */
  private reads: Scope.Closeable;
  private closed = false;
  constructor(
    runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
    chat: ChatClient,
    backend: ChatIpcBackend,
    context: ChatSession,
    capabilities: ChatIpcCapabilities = {},
  ) {
    this.runtime = runtime;
    this.chat = chat;
    this.connection = backend.mode === 'remote' ? backend.connection : null;
    this.context = context;
    this.capabilities = capabilities;
    this.reads = Scope.forkUnsafe(runtime.scope, 'parallel');
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
  /** Why `value` may not name what it names: another host and store, or another actor. */
  authority(value: unknown): 'host' | 'actor' | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const v = value as Record<string, unknown>;
    const host = v.host as { hostId?: unknown; storeId?: unknown } | undefined;
    if (
      host !== undefined &&
      (host.hostId !== this.context.host.hostId || host.storeId !== this.context.host.storeId)
    )
      return 'host';
    if (v.actorId !== undefined && v.actorId !== this.context.actorId) return 'actor';
    for (const name of ['target', 'session', 'stop', 'source']) {
      const refusal = this.authority(v[name]);
      if (refusal) return refusal;
    }
    return undefined;
  }
  /** A URL for `image`, or none once the session is disposed. */
  issueImage(image: TranscriptImage) {
    if (this.closed) return undefined;
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
  /** Revokes every issued URL, fails queued reads and cancels running ones. */
  revokeImages() {
    this.images.clear();
    const queued = this.imageReadQueue;
    this.imageReadQueue = [];
    for (const waiter of queued) waiter.reject(makeImageReadCancelledError());
    const reads = this.reads;
    this.reads = Scope.forkUnsafe(this.runtime.scope, 'parallel');
    return runApplicationEffect(this.runtime, Scope.close(reads, Exit.void));
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
      const reads = this.reads;
      const read = Effect.tryPromise({
        try: (readSignal) =>
          readTranscriptImage(this.chat, image, {
            signal: readSignal,
            reportCleanup: (error) => this.capabilities.reportCleanup?.(error),
          }),
        catch: normalizeApplicationError,
      });
      return await runApplicationEffect(
        this.runtime,
        Effect.gen(function* () {
          const fiber = yield* Effect.forkIn(read, reads);
          return yield* Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
        }),
        { signal },
      );
    } finally {
      this.releaseImageRead();
    }
  }
  dispose() {
    this.closed = true;
    return this.revokeImages();
  }
}
/** What a session's backend is: a local daemon's chat, or a remote host's with its connection. */
export type ChatIpcBackend = { mode: 'local' } | { mode: 'remote'; connection: ConnectionClient };
export type ChatIpcCapabilities = {
  providers?: ProviderSetupClient;
  transcript?: NativeTranscriptActions;
  /** Reports a cleanup failure no request is left to answer with. */
  reportCleanup?: (error: unknown) => void;
  /** lru-cache clock for image URL expiry; tests inject one. */
  perf?: { now(): number };
};
