import { LRUCache } from 'lru-cache';
import { Schema } from 'effect';
import type {
  ChatTarget,
  ChatTranscriptSource,
  ChatTranscriptSelection,
} from '@moonbase/contracts/chat';
import {
  ChatIdentifierSchema,
  ChatTranscriptSelectionSchema,
  ChatTranscriptSourceSchema,
} from '@moonbase/contracts/chat-schema';
import { optional, struct } from '@moonbase/contracts/schema';
import { sameTarget } from './saved.ts';
import { countTranscriptBytes, makeTranscriptFailure } from './transcript-read.ts';

export type TranscriptEntryAnchor = {
  entryId: string;
  partId?: string;
  offset: number;
  source?: never;
};
export type TranscriptLiveAnchor = ChatTranscriptSelection & {
  backendId: string;
  source: Extract<ChatTranscriptSource, { kind: 'live' }>;
  offset: number;
  entryId?: never;
};
export type TranscriptViewAnchor = TranscriptEntryAnchor | TranscriptLiveAnchor;
export type TranscriptView = { anchor: TranscriptViewAnchor | null; expanded: string[] };

/** Renderer-owned keys (expansions, backend IDs) are opaque, bounded, well-formed text. */
const opaqueKey = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      !!value.trim() &&
      value.isWellFormed() &&
      !value.includes('\0') &&
      new TextEncoder().encode(value).length <= 256,
  ),
);
const TranscriptViewSchema = struct({
  anchor: Schema.NullOr(
    Schema.Union([
      // Optional keys accept `undefined` (as the types allow) and omit it.
      struct({
        entryId: ChatIdentifierSchema,
        partId: optional(ChatIdentifierSchema),
        offset: Schema.Finite,
        source: optional(Schema.Never),
      }),
      struct({
        ...ChatTranscriptSelectionSchema.fields,
        backendId: opaqueKey,
        source: ChatTranscriptSourceSchema,
        offset: Schema.Finite,
        entryId: optional(Schema.Never),
      }),
    ]),
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

/** Decodes a view for one backend and target into a fresh, frozen value. */
export function decodeTranscriptView(
  backend: string,
  target: ChatTarget,
  view: TranscriptView,
): TranscriptView {
  let decoded: typeof TranscriptViewSchema.Type;
  try {
    decoded = decodeView(view);
  } catch {
    throw makeTranscriptFailure('Invalid transcript view.');
  }
  const anchor = decoded.anchor;
  if (anchor?.source) {
    if (
      anchor.source.kind !== 'live' ||
      anchor.backendId !== backend ||
      !sameTarget(anchor.source.target, target)
    )
      throw makeTranscriptFailure('Live transcript anchor belongs to another backend or target.');
  } else if (anchor?.entryId === 'live')
    throw makeTranscriptFailure('Use a durable entry identity or an exact live-part anchor.');
  return freeze({
    anchor: anchor as TranscriptViewAnchor | null,
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
    const decoded = decodeTranscriptView(backend, target, view);
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
