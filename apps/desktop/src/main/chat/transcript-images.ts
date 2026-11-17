import { randomBytes } from 'node:crypto';
import { Effect, Fiber, FiberSet, Option, Semaphore } from 'effect';
import { LRUCache } from 'lru-cache';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { TranscriptImage } from '../../ipc/chat-rpcs.ts';
import { transcriptImagePath, type TranscriptImageReader } from './transcript-native.ts';

/** Images mount with a fresh URL, so an unrequested binding can lapse. */
export const transcriptImageTokenLifetime = 10 * 60 * 1000;
/** Concurrent stored-image reads; later ones queue. */
const maximumImageReads = 6;
/** Image requests the renderer never aborts must not grow the queue without bound. */
const maximumQueuedImageReads = 64;
type ImageBinding = { key: string; image: TranscriptImage };

/** One chat target's transcript image URLs for one document, and the reads they start. */
export type TranscriptImages = {
  /** A URL for `image`; an equal binding reuses its URL and refreshes its age. */
  issue(image: TranscriptImage): Effect.Effect<string>;
  find(token: string): TranscriptImageReader | undefined;
  /** Revokes every issued URL and cancels the reads, running or waiting, that they started. */
  readonly revoke: Effect.Effect<void>;
};

/**
 * The image URLs a document's target issues, while the scope is open. Tokens are random and
 * expire unless requested; at most `maximumImageReads` reads run at once and
 * `maximumQueuedImageReads` more wait, and others are refused as busy. Closing the scope revokes
 * them all and cancels their reads.
 */
export const makeTranscriptImages = (
  read: (image: TranscriptImage) => Effect.Effect<Uint8Array<ArrayBuffer>, ApplicationError>,
  /** lru-cache clock for image URL expiry; tests inject one. */
  perf?: { now(): number },
) =>
  Effect.gen(function* () {
    /** Image identity to its current token, so equal bindings reuse one URL. */
    const tokens = new Map<string, string>();
    const images = new LRUCache<string, ImageBinding>({
      max: 256,
      ttl: transcriptImageTokenLifetime,
      ttlResolution: 0,
      updateAgeOnGet: true,
      ...(perf ? { perf } : {}),
      dispose: ({ key }, token) => {
        if (tokens.get(key) === token) tokens.delete(key);
      },
    });
    const permits = yield* Semaphore.make(maximumImageReads);
    /** A place for each read running or waiting; one asked for when none is free is busy. */
    const places = yield* Semaphore.make(maximumImageReads + maximumQueuedImageReads);
    const reads = yield* FiberSet.make<Uint8Array<ArrayBuffer>, ApplicationError>();
    yield* Effect.addFinalizer(() => Effect.sync(() => images.clear()));
    const readImage = (image: TranscriptImage) =>
      places
        .withPermitsIfAvailable(1)(
          Effect.flatMap(FiberSet.run(reads, permits.withPermit(read(image))), (fiber) =>
            Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))),
          ),
        )
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ApplicationError({ code: 'Unavailable', message: 'Image reads are busy.' }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
    return {
      issue: (image) =>
        Effect.sync(() => {
          const key = JSON.stringify(image);
          const issued = tokens.get(key);
          if (issued && images.get(issued))
            return `moonbase://editor${transcriptImagePath}${issued}`;
          const token = randomBytes(32).toString('base64url');
          images.set(token, { key, image });
          tokens.set(key, token);
          return `moonbase://editor${transcriptImagePath}${token}`;
        }),
      find: (token) => {
        const image = images.get(token)?.image;
        return image && { image, read: readImage(image) };
      },
      revoke: Effect.andThen(
        Effect.sync(() => images.clear()),
        FiberSet.clear(reads),
      ),
    } satisfies TranscriptImages;
  });
