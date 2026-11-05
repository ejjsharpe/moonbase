import type {
  ChatTarget,
  ChatTranscriptSource,
  ChatTranscriptSelection,
} from '@moonbase/contracts/chat';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
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
const emptyView = (): TranscriptView => ({ anchor: null, expanded: [] });
const identifier = (value: string) =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.isWellFormed() &&
  !value.includes('\0') &&
  new TextEncoder().encode(value).length <= 256;

export function decodeTranscriptView(
  backend: string,
  target: ChatTarget,
  view: TranscriptView,
): TranscriptView {
  if (
    !Array.isArray(view.expanded) ||
    view.expanded.some((id) => !identifier(id)) ||
    (view.anchor && !Number.isFinite(view.anchor.offset))
  )
    throw makeTranscriptFailure('Invalid transcript view.');
  let anchor: TranscriptViewAnchor | null = null;
  if (view.anchor?.source) {
    const live = view.anchor;
    const input = decodeChatInput('getChatTranscriptContent', {
      source: live.source,
      selection: { partId: live.partId, bytes: live.bytes, revision: live.revision },
    });
    if (
      input.source.kind !== 'live' ||
      live.entryId !== undefined ||
      !identifier(live.backendId) ||
      live.backendId !== backend ||
      !sameTarget(input.source.target, target)
    )
      throw makeTranscriptFailure('Live transcript anchor belongs to another backend or target.');
    anchor = { backendId: backend, source: input.source, ...input.selection!, offset: live.offset };
  } else if (view.anchor) {
    if (
      !identifier(view.anchor.entryId!) ||
      view.anchor.entryId === 'live' ||
      (view.anchor.partId !== undefined && !identifier(view.anchor.partId))
    )
      throw makeTranscriptFailure('Use a durable entry identity or an exact live-part anchor.');
    anchor = {
      entryId: view.anchor.entryId!,
      ...(view.anchor.partId !== undefined ? { partId: view.anchor.partId } : {}),
      offset: view.anchor.offset,
    };
  }
  return structuredClone({ anchor, expanded: [...new Set(view.expanded)].slice(-128) });
}

/** Content-free, application-lifetime LRU. A standalone model owns one by default. */
export class TranscriptViewMemory {
  private views = new Map<string, TranscriptView>();
  get(backend: string, target: ChatTarget): TranscriptView {
    const key = this.key(backend, target),
      value = this.views.get(key);
    if (!value) return emptyView();
    this.views.delete(key);
    this.views.set(key, value);
    return structuredClone(value);
  }
  set(backend: string, target: ChatTarget, view: TranscriptView) {
    const captured = decodeTranscriptView(backend, target, view);
    const key = this.key(backend, target);
    this.views.delete(key);
    this.views.set(key, captured);
    while (this.views.size > 64 || countTranscriptBytes([...this.views]) > 256 * 1024)
      this.views.delete(this.views.keys().next().value!);
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
