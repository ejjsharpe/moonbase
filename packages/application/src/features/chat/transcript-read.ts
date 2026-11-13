import { ApplicationError } from '@moonbase/contracts/errors';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import {
  decodeChatInput,
  type ChatClient,
  type ChatInput,
  type ChatOutput,
  type ChatTranscriptSource,
  type ChatTranscriptSelection,
} from '@moonbase/contracts/chat';

/** A ChatClient read; its boundary has already decoded and bounded the reply. */
export type TranscriptRead = (
  input: ChatInput<'getChatTranscriptContent'>,
  options: { signal?: AbortSignal },
) => Promise<ChatOutput<'getChatTranscriptContent'>>;
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
export const makeTranscriptFailure = (
  message: string,
  code: 'Incompatible' | 'Conflict' | 'Cancelled' | 'Unavailable' = 'Incompatible',
) => new ApplicationError({ code, message });

/** Constant-space cycle detection for opaque manifest continuations. */
export function trackTranscriptCursor() {
  let checkpoint: string | null = null,
    power = 1,
    distance = 0;
  return (cursor: string | null, next: string | null) => {
    if (next === null) return;
    if (next === cursor || next === checkpoint)
      throw makeTranscriptFailure('Transcript cursor did not advance.');
    if (++distance === power) {
      checkpoint = next;
      power *= 2;
      distance = 0;
    }
  };
}
function checkTranscriptRead(signal?: AbortSignal, isCurrent?: () => boolean) {
  if (signal?.aborted) throw makeTranscriptFailure('Transcript read cancelled.', 'Cancelled');
  if (isCurrent && !isCurrent())
    throw makeTranscriptFailure('Transcript source changed or is stale.', 'Conflict');
}
/** Cancel the caller's wait even when the reader ignores the signal. */
function awaitTranscriptRead<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(makeTranscriptFailure('Transcript read cancelled.', 'Cancelled'));
    };
    pending.then(
      (value) => {
        signal.removeEventListener('abort', cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}
/** Reads one page for an input the caller has already decoded and owns. */
async function readTranscript(
  read: TranscriptRead,
  input: ChatInput<'getChatTranscriptContent'>,
  signal?: AbortSignal,
  isCurrent?: () => boolean,
) {
  checkTranscriptRead(signal, isCurrent);
  const reply = await awaitTranscriptRead(read(input, { signal }), signal);
  checkTranscriptRead(signal, isCurrent);
  return checkTranscriptReply(input, reply);
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
    throw makeTranscriptFailure('Transcript reply does not match the captured selection.');
  if (
    reply.kind === 'manifest' &&
    new Set(reply.parts.map((part) => part.partId)).size !== reply.parts.length
  )
    throw makeTranscriptFailure('Transcript manifest repeats a part.');
  return reply;
}
export function countDecodedTranscriptBytes(chunk: Pick<TranscriptChunk, 'encoding' | 'data'>) {
  return chunk.encoding === 'utf8'
    ? new TextEncoder().encode(chunk.data).length
    : atob(chunk.data).length;
}

/** Streams a fixed source, independent of presentation/cache retention. Failures reject iteration. */
export type TranscriptIterationOptions = {
  read: TranscriptRead;
  source: ChatTranscriptSource;
  selection?: ChatTranscriptSelection;
  signal?: AbortSignal;
  /** Required for live evidence; the caller owns observation/final native-write authority. */
  isCurrent?: () => boolean;
  onProgress?: (progress: TranscriptReadProgress) => void;
};
export function iterateTranscriptSource(
  options: TranscriptIterationOptions,
): AsyncGenerator<TranscriptChunk> {
  const captured = decodeChatInput(
    'getChatTranscriptContent',
    options.selection
      ? { source: options.source, selection: options.selection }
      : { source: options.source },
  );
  return iterateSource({ ...options, ...captured });
}
async function* iterateSource(
  options: TranscriptIterationOptions,
): AsyncGenerator<TranscriptChunk> {
  const { read, signal, isCurrent, onProgress } = options;
  const { source, selection } = options;
  if (source.kind === 'live' && !isCurrent)
    throw makeTranscriptFailure(
      'Live transcript reads require current observation authority.',
      'Conflict',
    );
  const advance = trackTranscriptCursor();
  let manifestCursor: string | null = null,
    parts = 0,
    bytes = 0;
  do {
    const manifest: Extract<ChatOutput<'getChatTranscriptContent'>, { kind: 'manifest' }> | null =
      selection
        ? null
        : await readTranscript(
            read,
            { source, ...(manifestCursor ? { cursor: manifestCursor } : {}) },
            signal,
            isCurrent,
          ).then((reply) => {
            if (reply.kind !== 'manifest')
              throw makeTranscriptFailure('Expected a transcript manifest.');
            return reply;
          });
    const selections = selection
      ? [selection]
      : manifest!.parts.map((part) => {
          if (part.availability !== 'available')
            throw makeTranscriptFailure(
              'Selected transcript content is unavailable.',
              'Unavailable',
            );
          return { partId: part.partId, bytes: part.bytes, revision: part.revision };
        });
    for (const selected of selections) {
      let cursor: string | null = null,
        offset = 0;
      let encoding: TranscriptChunk['encoding'] | undefined;
      do {
        const chunk = await readTranscript(
          read,
          { source, selection: selected, ...(cursor ? { cursor } : {}) },
          signal,
          isCurrent,
        );
        if (chunk.kind !== 'content' || chunk.offset !== offset)
          throw makeTranscriptFailure('Transcript content has a missing or overlapping chunk.');
        if (encoding && encoding !== chunk.encoding)
          throw makeTranscriptFailure('Transcript encoding changed within a selected part.');
        encoding = chunk.encoding;
        const size = countDecodedTranscriptBytes(chunk);
        offset += size;
        bytes += size;
        cursor = chunk.nextCursor;
        checkTranscriptRead(signal, isCurrent);
        onProgress?.({ parts, bytes });
        checkTranscriptRead(signal, isCurrent);
        yield {
          source: structuredClone(source),
          selection: { ...selected },
          offset: chunk.offset,
          encoding: chunk.encoding,
          data: chunk.data,
        };
        checkTranscriptRead(signal, isCurrent);
      } while (cursor !== null);
      if (offset !== selected.bytes)
        throw makeTranscriptFailure('Transcript content is incomplete.');
      parts++;
    }
    const next: string | null = manifest?.nextCursor ?? null;
    advance(manifestCursor, next);
    manifestCursor = next;
  } while (manifestCursor !== null);
  checkTranscriptRead(signal, isCurrent);
  onProgress?.({ parts, bytes });
  checkTranscriptRead(signal, isCurrent);
}

export function makeTranscriptReader(client: ChatClient): TranscriptRead {
  return (input, options) => client.command('getChatTranscriptContent', input, options);
}
