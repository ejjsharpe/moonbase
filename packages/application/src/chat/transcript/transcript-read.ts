import { Effect, Queue, Stream } from 'effect';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import type {
  ChatInput,
  ChatOutput,
  ChatTranscriptSource,
  ChatTranscriptSelection,
} from '@moonbase/contracts/chat';
import { checkTranscript, TranscriptReadError } from './transcript-errors.ts';

type ContentInput = ChatInput<'getChatTranscriptContent'>;
type ContentReply = ChatOutput<'getChatTranscriptContent'>;
/** A read of one page of a source; its boundary has already decoded and bounded the reply. */
export type TranscriptRead<E> = (input: ContentInput) => Effect.Effect<ContentReply, E>;
export type TranscriptChunk = {
  source: ChatTranscriptSource;
  selection: ChatTranscriptSelection;
  offset: number;
  /** UTF16 base when retained for presentation; wire offsets remain bytes. */
  textOffset?: number;
  encoding: 'utf8' | 'base64';
  data: string;
};
export type TranscriptReadProgress = { parts: number; bytes: number };
export const countTranscriptBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** Constant-space cycle detection for opaque manifest continuations. */
export function trackTranscriptCursor() {
  let checkpoint: string | null = null,
    power = 1,
    distance = 0;
  return (cursor: string | null, next: string | null) => {
    if (next === null) return;
    if (next === cursor || next === checkpoint)
      throw new TranscriptReadError({ problem: 'cursor-stalled' });
    if (++distance === power) {
      checkpoint = next;
      power *= 2;
      distance = 0;
    }
  };
}
/** Checks that a reply echoes the input it answers; the ChatClient boundary checked its shape. */
export function checkTranscriptReply(
  input: ChatInput<'getChatTranscriptContent'>,
  reply: ChatOutput<'getChatTranscriptContent'>,
) {
  if (
    !areJsonValuesEqual(reply.source, input.source) ||
    reply.cursor !== (input.cursor ?? null) ||
    (input.selection
      ? reply.kind !== 'content' || !areJsonValuesEqual(reply.selection, input.selection)
      : reply.kind !== 'manifest')
  )
    throw new TranscriptReadError({ problem: 'reply-mismatch' });
  if (
    reply.kind === 'manifest' &&
    new Set(reply.parts.map((part) => part.partId)).size !== reply.parts.length
  )
    throw new TranscriptReadError({ problem: 'manifest-repeats-part' });
  return reply;
}
export function countDecodedTranscriptBytes(chunk: Pick<TranscriptChunk, 'encoding' | 'data'>) {
  return chunk.encoding === 'utf8'
    ? new TextEncoder().encode(chunk.data).length
    : atob(chunk.data).length;
}

/** A fixed source to stream, independent of presentation/cache retention. */
export type TranscriptIterationOptions<E> = {
  read: TranscriptRead<E>;
  source: ChatTranscriptSource;
  selection?: ChatTranscriptSelection;
  /** Required for live evidence; the caller owns observation/final native-write authority. */
  isCurrent?: () => boolean;
  onProgress?: (progress: TranscriptReadProgress) => void;
};

/**
 * Streams a source's selected part, or every part its manifest lists, in order, validating each
 * echo, chunk and continuation. It reads at most one chunk ahead of its consumer; stopping the
 * stream interrupts the read under way.
 */
export function streamTranscriptSource<E>(
  options: TranscriptIterationOptions<E>,
): Stream.Stream<TranscriptChunk, TranscriptReadError | E> {
  const { read, isCurrent, onProgress } = options;
  // Captured now, so a caller changing its source later reads what it asked for.
  const { source, selection } = structuredClone(
    options.selection
      ? { source: options.source, selection: options.selection }
      : { source: options.source },
  );
  return Stream.callback<TranscriptChunk, TranscriptReadError | E>(
    (queue) =>
      Effect.gen(function* () {
        if (source.kind === 'live' && !isCurrent)
          return yield* new TranscriptReadError({ problem: 'live-authority' });
        const check = checkTranscript(() => {
          if (isCurrent && !isCurrent())
            throw new TranscriptReadError({ problem: 'source-changed' });
        });
        const readChecked = (input: ContentInput) =>
          check.pipe(
            Effect.andThen(read(input)),
            Effect.tap(check),
            Effect.flatMap((reply) => checkTranscript(() => checkTranscriptReply(input, reply))),
          );
        const advance = trackTranscriptCursor();
        let manifestCursor: string | null = null,
          parts = 0,
          bytes = 0;
        do {
          let selections = selection ? [selection] : [];
          let next: string | null = null;
          if (!selection) {
            const manifest: ContentReply = yield* readChecked({
              source,
              ...(manifestCursor ? { cursor: manifestCursor } : {}),
            });
            if (manifest.kind !== 'manifest')
              return yield* new TranscriptReadError({ problem: 'expected-manifest' });
            next = manifest.nextCursor;
            selections = [];
            for (const part of manifest.parts) {
              if (part.availability !== 'available')
                return yield* new TranscriptReadError({ problem: 'content-unavailable' });
              selections.push({ partId: part.partId, bytes: part.bytes, revision: part.revision });
            }
          }
          for (const selected of selections) {
            let cursor: string | null = null,
              offset = 0;
            let encoding: TranscriptChunk['encoding'] | undefined;
            do {
              const chunk: ContentReply = yield* readChecked({
                source,
                selection: selected,
                ...(cursor ? { cursor } : {}),
              });
              if (chunk.kind !== 'content' || chunk.offset !== offset)
                return yield* new TranscriptReadError({ problem: 'chunk-gap' });
              if (encoding && encoding !== chunk.encoding)
                return yield* new TranscriptReadError({ problem: 'encoding-changed' });
              encoding = chunk.encoding;
              const size = countDecodedTranscriptBytes(chunk);
              offset += size;
              bytes += size;
              cursor = chunk.nextCursor;
              yield* check;
              onProgress?.({ parts, bytes });
              yield* check;
              yield* Queue.offer(queue, {
                source: structuredClone(source),
                selection: { ...selected },
                offset: chunk.offset,
                encoding: chunk.encoding,
                data: chunk.data,
              });
            } while (cursor !== null);
            if (offset !== selected.bytes)
              return yield* new TranscriptReadError({ problem: 'content-incomplete' });
            parts++;
          }
          yield* checkTranscript(() => advance(manifestCursor, next));
          manifestCursor = next;
        } while (manifestCursor !== null);
        yield* check;
        onProgress?.({ parts, bytes });
        yield* check;
        yield* Queue.end(queue);
      }),
    { bufferSize: 1 },
  );
}
