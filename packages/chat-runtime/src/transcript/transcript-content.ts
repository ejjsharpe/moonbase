import { Effect, Option, Stream } from 'effect';
import {
  chatContentChunkBytes,
  chatManifestPageSize,
  type ChatInput,
  type ChatOutput,
  type ChatTranscriptSelection,
  type ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import {
  InvalidChatRequestError,
  TranscriptChangedError,
  type ChatError,
} from '@moonbase/contracts/chat-errors';
import { openTranscriptCursor, writeCursor } from '../cursors.ts';
import { hashJson } from '../hash-json.ts';
import { readSavedTranscript, type EntryReader } from './entry-transcript.ts';
import { getLiveTranscript } from './live-transcript.ts';
import { listEntryParts, projectManifest } from './manifest.ts';
import {
  getRevision,
  hashPrefix,
  isAvailable,
  type Part,
  type TranscriptParts,
} from './transcript-part.ts';

const findPart = (parts: TranscriptParts['parts'], partId: string) =>
  Effect.map(
    Stream.runHead(Stream.filter(parts, (part) => part.id === partId)),
    Option.getOrUndefined,
  );
/** Checks that the selection's fixed prefix still matches the part's value. */
const checkSelection = (
  part: Part | undefined,
  selection: ChatTranscriptSelection,
): Effect.Effect<Part, ChatError> => {
  if (!part || !isAvailable(part))
    return Effect.fail(new InvalidChatRequestError({ problem: 'part' }));
  if (
    selection.bytes > part.value.length ||
    (selection.bytes === part.value.length
      ? getRevision(part)
      : hashPrefix(part, selection.bytes)) !== selection.revision
  )
    return Effect.fail(new TranscriptChangedError({ change: 'prefix' }));
  return Effect.succeed(part);
};
const readSelectedPart = (
  reader: EntryReader,
  source: ChatTranscriptSource,
  selection: ChatTranscriptSelection,
) =>
  Effect.gen(function* () {
    if (source.kind === 'entry') {
      const transcript = yield* readSavedTranscript(reader, source.target, source.entryId);
      return yield* checkSelection(
        transcript.parts.find((part) => part.id === selection.partId),
        selection,
      );
    }
    const readPart = Effect.flatMap(getLiveTranscript(reader, source), (transcript) =>
      findPart(transcript.parts, selection.partId),
    );
    const part = yield* checkSelection(yield* readPart, selection);
    // A live selection is served only while its source is still current.
    const current = yield* readPart;
    if (!current || !isAvailable(current))
      return yield* new TranscriptChangedError({ change: 'part' });
    yield* checkSelection(current, selection);
    return part;
  });
export const readTranscriptContent = (
  reader: EntryReader,
  input: ChatInput<'getChatTranscriptContent'>,
): Effect.Effect<ChatOutput<'getChatTranscriptContent'>, ChatError> =>
  Effect.gen(function* () {
    const { source, selection } = input;
    if (!selection) {
      const cursor = input.cursor
        ? yield* openTranscriptCursor(input.cursor, 'manifest', hashJson(source))
        : undefined;
      const transcript =
        source.kind === 'entry'
          ? listEntryParts(yield* readSavedTranscript(reader, source.target, source.entryId))
          : yield* getLiveTranscript(reader, source);
      return {
        kind: 'manifest' as const,
        cursor: input.cursor ?? null,
        ...(yield* projectManifest(
          source,
          transcript,
          cursor?.position ?? 0,
          chatManifestPageSize,
          cursor ? (cursor.revision ?? '') : undefined,
        )),
      };
    }
    const binding = hashJson({ source, selection });
    const offset = input.cursor
      ? (yield* openTranscriptCursor(input.cursor, 'content', binding)).position
      : 0;
    const part = yield* readSelectedPart(reader, source, selection);
    if (offset > selection.bytes)
      return yield* new InvalidChatRequestError({ problem: 'content-position' });
    const bytes = part.value;
    let end = Math.min(offset + chatContentChunkBytes, selection.bytes);
    if (part.encoding === 'utf8') {
      while (end < selection.bytes && (bytes[end] & 0xc0) === 0x80) end--;
      if (
        (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) ||
        (selection.bytes < bytes.length && (bytes[selection.bytes] & 0xc0) === 0x80)
      )
        return yield* new InvalidChatRequestError({ problem: 'content-split' });
    }
    return {
      kind: 'content' as const,
      cursor: input.cursor ?? null,
      source,
      selection,
      offset,
      encoding: part.encoding,
      data: bytes.subarray(offset, end).toString(part.encoding),
      nextCursor:
        end < selection.bytes
          ? yield* writeCursor({ kind: 'content', binding, position: end })
          : null,
    };
  });
