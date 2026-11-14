import { LRUCache } from 'lru-cache';
import type {
  ChatOutput,
  ChatSnapshot,
  ChatTranscriptSelection,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import {
  countDecodedTranscriptBytes,
  countTranscriptBytes,
  makeTranscriptFailure,
} from './transcript-read.ts';
import {
  measureTranscriptValue,
  transcriptLimits,
  type TranscriptContentState,
} from './transcript-state.ts';

type ContentReply = Extract<ChatOutput<'getChatTranscriptContent'>, { kind: 'content' }>;

function measureContent(content: TranscriptContentState) {
  let bytes = countTranscriptBytes({ ...content, chunks: [] });
  for (const chunk of content.chunks) bytes += measureTranscriptValue(chunk);
  return bytes;
}

/** Whether a snapshot's summary of the selected part no longer matches the selection read. */
export function isContentChanged(
  content: TranscriptContentState,
  snapshot: Pick<ChatSnapshot, 'entries' | 'run'>,
) {
  const { source, selection } = content;
  const transcript =
    source.kind === 'live'
      ? snapshot.run?.transcript
      : snapshot.entries.find((entry) => entry.id === source.entryId)?.transcript;
  const part = transcript?.parts.find((part) => part.partId === selection.partId);
  return (
    !!part &&
    (part.bytes !== selection.bytes ||
      part.revision !== selection.revision ||
      part.availability !== 'available')
  );
}

/** Selected part content, bounded by bytes and evicted by least-recent selection. */
export class TranscriptContentCache {
  private contents = new LRUCache<string, TranscriptContentState>({
    max: 128,
    maxSize: transcriptLimits.contentBytes,
    sizeCalculation: measureContent,
  });
  peek(key: string) {
    return this.contents.peek(key);
  }
  /** Most recent first is the cache's order; presentation lists oldest first. */
  listContents() {
    return [...this.contents.values()].reverse();
  }
  /**
   * Writing a selection makes it most recent. Only that selection is trimmed (oldest chunks first)
   * to fit the budget alone; the LRU then evicts whole least-recent selections.
   */
  write(key: string, content: TranscriptContentState) {
    let size = measureContent(content);
    while (size > transcriptLimits.contentBytes && content.chunks.length) {
      size -= measureTranscriptValue(content.chunks[0]);
      const chunks = content.chunks.slice(1);
      content = { ...content, chunks, retainedFrom: chunks[0]?.offset ?? content.loadedBytes };
    }
    this.contents.set(key, content);
  }
  /** Returns the retained selection, or starts an empty partial one (always, on restart). */
  open(
    key: string,
    source: ChatTranscriptSource,
    selection: ChatTranscriptSelection,
    restart: boolean,
  ) {
    const content = (restart ? undefined : this.contents.peek(key)) ?? {
      source,
      selection,
      chunks: [],
      loadedBytes: 0,
      loadedText: 0,
      retainedFrom: 0,
      nextCursor: null,
      status: 'partial',
      error: null,
    };
    this.write(key, content);
    return content;
  }
  /** Updates status fields on the retained selection, or on `fallback` if it was evicted. */
  mark(
    key: string,
    change: Partial<Pick<TranscriptContentState, 'status' | 'error'>>,
    fallback?: TranscriptContentState,
  ) {
    const content = this.contents.peek(key) ?? fallback;
    if (content) this.write(key, { ...content, ...change });
  }
  /** Appends the next contiguous chunk after `before`, the state the read started from. */
  append(key: string, before: TranscriptContentState, reply: ContentReply) {
    if (reply.offset !== before.loadedBytes)
      throw makeTranscriptFailure('Transcript content has a missing or overlapping chunk.');
    const loadedBytes = reply.offset + countDecodedTranscriptBytes(reply);
    const chunk = {
      source: before.source,
      selection: before.selection,
      offset: reply.offset,
      textOffset: before.loadedText,
      encoding: reply.encoding,
      data: reply.data,
    };
    const chunks = [...(this.contents.peek(key)?.chunks ?? []), chunk];
    this.write(key, {
      ...before,
      chunks,
      retainedFrom: chunks[0]?.offset ?? loadedBytes,
      loadedBytes,
      loadedText: before.loadedText + (reply.encoding === 'utf8' ? reply.data.length : 0),
      nextCursor: reply.nextCursor,
      status: reply.nextCursor ? 'partial' : 'complete',
      error: null,
    });
  }
  /** Marks each selection `isStale` accepts as source-changed and returns their keys. */
  markStale(isStale: (content: TranscriptContentState) => boolean) {
    const stale: string[] = [];
    // write() reorders the LRU, so iterate a key snapshot and read live values.
    for (const key of Array.from(this.contents.keys())) {
      const content = this.contents.peek(key);
      if (!content || !isStale(content)) continue;
      this.write(key, {
        ...content,
        status: 'source-changed',
        error: 'Transcript source changed or is stale. Reload the selected part.',
      });
      stale.push(key);
    }
    return stale;
  }
  /** Live selections can no longer prove their source; loading stored ones failed. */
  markFailed(failure: string) {
    for (const key of Array.from(this.contents.keys())) {
      const content = this.contents.peek(key);
      if (content?.source.kind === 'live' || content?.status === 'loading')
        this.write(key, {
          ...content,
          status: content.source.kind === 'live' ? 'source-changed' : 'error',
          error: failure,
        });
    }
  }
  clear() {
    this.contents.clear();
  }
}
