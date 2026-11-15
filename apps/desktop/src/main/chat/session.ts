import { randomBytes } from 'node:crypto';
import { Effect, Exit, Fiber, Option, Scope, Semaphore } from 'effect';
import { LRUCache } from 'lru-cache';
import { normalizeApplicationError } from '@moonbase/effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatClient, ChatSession } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';
import type { ProviderSetupClient } from '@moonbase/contracts/providers';
import type { TranscriptImage } from '../../ipc/chat-rpcs.ts';
import {
  readTranscriptImage,
  transcriptImagePath,
  type NativeTranscriptActions,
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
/** An issued image and its read, which runs in the session's reads. */
export type SessionImage = {
  image: TranscriptImage;
  read: Effect.Effect<Uint8Array<ArrayBuffer>, ApplicationError>;
};
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
  /** A permit for each Copy that may run at once; one asked for when none is free is busy. */
  readonly copyPermits = Semaphore.makeUnsafe(maximumTranscriptCopies);
  /** Opaque image URL tokens; they expire unless requested, and the session revokes them on close. */
  private images: LRUCache<string, ImageBinding>;
  /** Image identity to its current token, so equal bindings reuse one URL. */
  private imageTokens = new Map<string, string>();
  /** Reads running at once; the rest wait for a permit. */
  private imageReadPermits = Semaphore.makeUnsafe(maximumImageReads);
  /** A place for each read running or waiting; one asked for when none is free is busy. */
  private imageReadPlaces = Semaphore.makeUnsafe(maximumImageReads + maximumQueuedImageReads);
  /** Image reads, running and waiting; revoking the URLs closes it, which cancels them. */
  private reads = Scope.makeUnsafe('parallel');
  private closed = false;
  constructor(
    chat: ChatClient,
    backend: ChatIpcBackend,
    context: ChatSession,
    capabilities: ChatIpcCapabilities = {},
  ) {
    this.chat = chat;
    this.connection = backend.mode === 'remote' ? backend.connection : null;
    this.context = context;
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
  /** Why `value` may not name what it names: another host and store, or another actor. */
  checkHostAndActor(value: unknown): 'host' | 'actor' | undefined {
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
      const refusal = this.checkHostAndActor(v[name]);
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
  findImage(token: string): SessionImage | undefined {
    const image = this.images.get(token)?.image;
    return image && { image, read: this.readImage(image) };
  }
  /** Revokes every issued URL and cancels the reads, running or waiting, that they started. */
  readonly revokeImages: Effect.Effect<void> = Effect.suspend(() => {
    this.images.clear();
    const reads = this.reads;
    if (!this.closed) this.reads = Scope.makeUnsafe('parallel');
    return Scope.close(reads, Exit.void);
  });
  /**
   * Reads `image` in the session's reads: at most `maximumImageReads` at once, and at most
   * `maximumQueuedImageReads` more waiting, refusing others as busy.
   */
  private readImage(image: TranscriptImage): SessionImage['read'] {
    const read = this.imageReadPermits.withPermit(
      Effect.tryPromise({
        try: (signal) =>
          readTranscriptImage(this.chat, image, {
            signal,
            reportCleanup: (error) => this.capabilities.reportCleanup?.(error),
          }),
        catch: normalizeApplicationError,
      }),
    );
    return Effect.suspend(() => {
      if (this.closed) return Effect.fail(makeImageReadCancelledError());
      const reads = this.reads;
      // A place is taken and given its release in one step, so an interruption leaks none.
      return this.imageReadPlaces
        .withPermitsIfAvailable(1)(
          Effect.flatMap(Effect.forkIn(read, reads), (fiber) =>
            Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))),
          ),
        )
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(makeImageReadsBusyError()),
              onSome: Effect.succeed,
            }),
          ),
        );
    });
  }
  /** Revokes the session's URLs and ends its reads for good. */
  readonly dispose: Effect.Effect<void> = Effect.suspend(() => {
    this.closed = true;
    return this.revokeImages;
  });
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
