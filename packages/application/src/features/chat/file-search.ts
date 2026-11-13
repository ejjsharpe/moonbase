import { normalizeApplicationError } from '@moonbase/effect';
import type { ChatFileMatch, ChatOutput } from '@moonbase/contracts/chat';

export type ChatFileSearchSnapshot = {
  /** The query the matches answer, or null before any answer. */
  query: string | null;
  matches: ChatFileMatch[];
  partial: boolean;
  busy: boolean;
  error: string | null;
};
type Find = (
  query: string,
  options: { cwd?: string; signal: AbortSignal },
) => Promise<ChatOutput<'findChatFiles'>>;
const idle: ChatFileSearchSnapshot = {
  query: null,
  matches: [],
  partial: false,
  busy: false,
  error: null,
};

/**
 * One composer's file picker: each search cancels the one before it, and only the latest answer is
 * shown. Earlier matches stay visible while a newer query is in flight.
 */
export class ChatFileSearch {
  private snapshot = idle;
  private readonly listeners = new Set<() => void>();
  private current?: AbortController;
  private disposed = false;
  private readonly find: Find;
  constructor(find: Find) {
    this.find = find;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private update(change: Partial<ChatFileSearchSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  search(query: string, cwd?: string) {
    if (this.disposed) return;
    this.current?.abort();
    const controller = (this.current = new AbortController());
    this.update({ busy: true });
    this.find(query, { ...(cwd ? { cwd } : {}), signal: controller.signal }).then(
      (result) => {
        if (this.current !== controller) return;
        this.current = undefined;
        this.update({
          query,
          matches: result.matches,
          partial: result.partial,
          busy: false,
          error: null,
        });
      },
      (error) => {
        if (this.current !== controller) return;
        this.current = undefined;
        this.update({
          query,
          matches: [],
          partial: false,
          busy: false,
          error: normalizeApplicationError(error).message,
        });
      },
    );
  }
  /** Cancels any search and forgets its matches. */
  clear() {
    this.current?.abort();
    this.current = undefined;
    if (this.snapshot !== idle) this.update(idle);
  }
  dispose() {
    this.clear();
    this.disposed = true;
    this.listeners.clear();
  }
}
