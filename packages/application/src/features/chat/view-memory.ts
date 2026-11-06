import { LRUCache } from 'lru-cache';
import { Schema } from 'effect';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { ChatIdentifierSchema } from '@moonbase/contracts/chat-schema';
import { optional, struct } from '@moonbase/contracts/schema';
import { countTranscriptBytes, makeTranscriptFailure } from './transcript-read.ts';

/**
 * A reading position: the row at the top of the viewport (a `TranscriptRow` key), optionally the
 * part inside it, and the pixels from the viewport top to that row or part.
 */
export type TranscriptViewAnchor = { key: string; partId?: string; offset: number };
export type TranscriptView = { anchor: TranscriptViewAnchor | null; expanded: string[] };

/** Renderer-owned keys (expansions) are opaque, bounded, well-formed text. */
const opaqueKey = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      !!value.trim() &&
      value.isWellFormed() &&
      !value.includes('\0') &&
      new TextEncoder().encode(value).length <= 256,
  ),
);
const rowKey = opaqueKey.check(Schema.makeFilter((value) => /^(entry|live|tool):./.test(value)));
const TranscriptViewSchema = struct({
  anchor: Schema.NullOr(
    // Optional keys accept `undefined` (as the types allow) and omit it.
    struct({ key: rowKey, partId: optional(ChatIdentifierSchema), offset: Schema.Finite }),
  ),
  expanded: Schema.mutable(Schema.Array(opaqueKey)),
});
const decodeView = Schema.decodeUnknownSync(TranscriptViewSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
const emptyView: TranscriptView = Object.freeze({
  anchor: null,
  expanded: Object.freeze([]),
}) as never;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Decodes a view into a fresh, frozen value. */
export function decodeTranscriptView(view: TranscriptView): TranscriptView {
  let decoded: typeof TranscriptViewSchema.Type;
  try {
    decoded = decodeView(view);
  } catch {
    throw makeTranscriptFailure('Invalid transcript view.');
  }
  return freeze({
    anchor: decoded.anchor,
    expanded: [...new Set(decoded.expanded)].slice(-128),
  });
}

/** Content-free, application-lifetime LRU of frozen views. A standalone model owns one by default. */
export class TranscriptViewMemory {
  private views = new LRUCache<string, TranscriptView>({
    max: 64,
    maxSize: 256 * 1024,
    sizeCalculation: (view, key) =>
      countTranscriptBytes(view) + new TextEncoder().encode(key).length,
  });
  get(backend: string, target: ChatTarget): TranscriptView {
    return this.views.get(this.key(backend, target)) ?? emptyView;
  }
  /** Returns the decoded view that was remembered. */
  set(backend: string, target: ChatTarget, view: TranscriptView): TranscriptView {
    const decoded = decodeTranscriptView(view);
    this.views.set(this.key(backend, target), decoded);
    return decoded;
  }
  clear() {
    this.views.clear();
  }
  private key(backend: string, target: ChatTarget) {
    return JSON.stringify([
      backend,
      target.host.hostId,
      target.host.storeId,
      target.actorId,
      target.conversationId,
    ]);
  }
}
