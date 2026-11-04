import type { ChatTarget } from '@moonbase/contracts/chat';
import { countTranscriptBytes, makeTranscriptFailure } from './transcript-read.ts';

export type TranscriptView = {
  anchor: { entryId: string; partId?: string; offset: number } | null;
  expanded: string[];
};
const emptyView = (): TranscriptView => ({ anchor: null, expanded: [] });
const identifier = (value: string) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.isWellFormed() &&
  !value.includes('\0') &&
  new TextEncoder().encode(value).length <= 256;
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
    if (
      !Array.isArray(view.expanded) ||
      view.expanded.some((id) => !identifier(id)) ||
      (view.anchor &&
        (!identifier(view.anchor.entryId) ||
          (view.anchor.partId !== undefined && !identifier(view.anchor.partId)) ||
          !Number.isFinite(view.anchor.offset)))
    )
      throw makeTranscriptFailure('Invalid transcript view.', 'Incompatible');
    const key = this.key(backend, target);
    this.views.delete(key);
    this.views.set(
      key,
      structuredClone({ anchor: view.anchor, expanded: [...new Set(view.expanded)].slice(-128) }),
    );
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
