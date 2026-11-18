import { randomUUID } from 'node:crypto';
import { Effect, Ref, Semaphore } from 'effect';
import { TranscriptNativeError } from '../../ipc/ipc-errors.ts';
import type { ChatTargetId } from '../../ipc/chat-rpcs.ts';
import type { ChatBackends } from './chat-backends.ts';
import { makeTranscriptImages, type TranscriptImages } from './transcript-images.ts';
import { readTranscriptImage, type TranscriptImageReader } from './transcript-native.ts';

/** Copies one target runs at once for a document; another is refused as busy. */
export const maximumTranscriptCopies = 2;
/** What one document holds of one chat target: its image URLs and the Copies it runs. */
export type ChatDocumentTarget = {
  images: TranscriptImages;
  /** A permit for each Copy that may run at once; one asked for when none is free is busy. */
  copies: Semaphore.Semaphore;
};
export type ChatDocument = {
  /** The document's provider setup owner on each target. */
  id: string;
  targets: Readonly<Record<ChatTargetId, ChatDocumentTarget>>;
};

/**
 * What the window's document holds of its chat targets, while the scope (the document's) is open.
 * Closing it revokes its image URLs and cancels their reads, and releases its provider sign-ins;
 * Quit skips that, since it closes the daemon connections, which releases every owner.
 */
export const makeChatDocument = (
  backends: Pick<ChatBackends, 'findTarget' | 'releaseOwner'>,
  options: {
    readonly isClosing: Effect.Effect<boolean>;
    /** lru-cache clock for image URL expiry; tests inject one. */
    perf?: { now(): number };
  },
) =>
  Effect.gen(function* () {
    const id = randomUUID();
    yield* Effect.addFinalizer(() =>
      Effect.flatMap(options.isClosing, (closing) =>
        closing ? Effect.void : backends.releaseOwner(id).pipe(Effect.orDie),
      ),
    );
    const makeTarget = (target: ChatTargetId) =>
      Effect.gen(function* () {
        const images = yield* makeTranscriptImages(
          (image) =>
            Effect.flatMap(backends.findTarget(target), (clients) =>
              clients
                ? readTranscriptImage(clients.chat, image)
                : Effect.fail(new TranscriptNativeError({ problem: 'image-cancelled' })),
            ),
          options.perf,
        );
        return { images, copies: yield* Semaphore.make(maximumTranscriptCopies) };
      });
    return {
      id,
      targets: { local: yield* makeTarget('local'), remote: yield* makeTarget('remote') },
    } satisfies ChatDocument;
  });

export type ChatDocumentOptions = Parameters<typeof makeChatDocument>[1];
/**
 * The window's chat documents: `open` makes one in the scope (a document's), the current one
 * until it closes, whose image URLs the `moonbase:` protocol serves.
 */
export const makeChatDocuments = (
  backends: Pick<ChatBackends, 'findTarget' | 'releaseOwner'>,
  options: ChatDocumentOptions,
) =>
  Effect.gen(function* () {
    const current = yield* Ref.make<ChatDocument | undefined>(undefined);
    return {
      open: Effect.gen(function* () {
        const document = yield* makeChatDocument(backends, options);
        yield* Effect.acquireRelease(Ref.set(current, document), () =>
          Ref.update(current, (open) => (open === document ? undefined : open)),
        );
        return document;
      }),
      /** The current document's image for `token`, as a synchronous lookup. */
      findImages: Effect.map(
        Ref.get(current),
        (document) =>
          (token: string): TranscriptImageReader | undefined =>
            document &&
            (document.targets.local.images.find(token) ??
              document.targets.remote.images.find(token)),
      ),
    };
  });
export type ChatDocuments = Effect.Success<ReturnType<typeof makeChatDocuments>>;
