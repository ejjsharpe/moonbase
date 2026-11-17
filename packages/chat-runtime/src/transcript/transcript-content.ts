import type { Harness } from '@earendil-works/pi-durable';
import {
  chatContentChunkBytes,
  chatManifestPageSize,
  type ChatInput,
  type ChatOutput,
  type ChatTranscriptSelection,
  type ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { InvalidChatRequestError, TranscriptChangedError } from '@moonbase/contracts/chat-errors';
import { openTranscriptCursor, writeCursor } from '../cursors.ts';
import { hashJson } from '../hash-json.ts';
import { readSavedTranscript } from './entry-transcript.ts';
import { getLiveTranscript } from './live-transcript.ts';
import { projectManifest } from './manifest.ts';
import {
  getRevision,
  hashPrefix,
  isAvailable,
  type Part,
  type TranscriptParts,
} from './transcript-part.ts';

async function findPart(parts: TranscriptParts['parts'], partId: string) {
  for await (const part of parts) if (part.id === partId) return part;
  return undefined;
}
/** Checks that the selection's fixed prefix still matches the part's value. */
function checkSelection(part: Part | undefined, selection: ChatTranscriptSelection): Part {
  if (!part || !isAvailable(part)) throw new InvalidChatRequestError({ problem: 'part' });
  if (
    selection.bytes > part.value.length ||
    (selection.bytes === part.value.length
      ? getRevision(part)
      : hashPrefix(part, selection.bytes)) !== selection.revision
  )
    throw new TranscriptChangedError({ change: 'prefix' });
  return part;
}
async function readSelectedPart(
  harness: Harness,
  source: ChatTranscriptSource,
  selection: ChatTranscriptSelection,
  signal?: AbortSignal,
) {
  if (source.kind === 'entry') {
    const transcript = await readSavedTranscript(harness, source.target, source.entryId, signal);
    return checkSelection(
      transcript.parts.find((part) => part.id === selection.partId),
      selection,
    );
  }
  const transcript = await getLiveTranscript(harness, source, { signal });
  const part = checkSelection(await findPart(transcript.parts, selection.partId), selection);
  // A live selection is served only while its source is still current.
  const current = await findPart(
    (await getLiveTranscript(harness, source, { signal })).parts,
    selection.partId,
  );
  if (!current || !isAvailable(current)) throw new TranscriptChangedError({ change: 'part' });
  checkSelection(current, selection);
  signal?.throwIfAborted();
  return part;
}
export async function readTranscriptContent(
  harness: Harness,
  input: ChatInput<'getChatTranscriptContent'>,
  signal?: AbortSignal,
): Promise<ChatOutput<'getChatTranscriptContent'>> {
  const { source, selection } = input;
  signal?.throwIfAborted();
  if (!selection) {
    const cursor = input.cursor
      ? openTranscriptCursor(input.cursor, 'manifest', hashJson(source))
      : undefined;
    const transcript =
      source.kind === 'entry'
        ? await readSavedTranscript(harness, source.target, source.entryId, signal)
        : await getLiveTranscript(harness, source, { signal });
    signal?.throwIfAborted();
    return {
      kind: 'manifest',
      cursor: input.cursor ?? null,
      ...(await projectManifest(
        source,
        transcript,
        cursor?.position ?? 0,
        chatManifestPageSize,
        cursor ? (cursor.revision ?? '') : undefined,
      )),
    };
  }
  const binding = hashJson({ source, selection });
  const offset = input.cursor ? openTranscriptCursor(input.cursor, 'content', binding).position : 0;
  const part = await readSelectedPart(harness, source, selection, signal);
  signal?.throwIfAborted();
  if (offset > selection.bytes) throw new InvalidChatRequestError({ problem: 'content-position' });
  const bytes = part.value;
  let end = Math.min(offset + chatContentChunkBytes, selection.bytes);
  if (part.encoding === 'utf8') {
    while (end < selection.bytes && (bytes[end] & 0xc0) === 0x80) end--;
    if (
      (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) ||
      (selection.bytes < bytes.length && (bytes[selection.bytes] & 0xc0) === 0x80)
    )
      throw new InvalidChatRequestError({ problem: 'content-split' });
  }
  return {
    kind: 'content',
    cursor: input.cursor ?? null,
    source,
    selection,
    offset,
    encoding: part.encoding,
    data: bytes.subarray(offset, end).toString(part.encoding),
    nextCursor:
      end < selection.bytes ? writeCursor({ kind: 'content', binding, position: end }) : null,
  };
}
