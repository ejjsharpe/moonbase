import { createContext, useCallback, useContext, useReducer } from 'react';

/** Values kept per transcript view. The oldest go first beyond this many. */
const retainedValues = 256;

/**
 * Row state the reader can see, kept outside the rows. A virtualized row unmounts while it is
 * scrolled away, so state a row shows (such as a disclosure the reader folded) lives here for as
 * long as the transcript view does. Remembered expansions live in view memory instead.
 */
export class TranscriptRowStore {
  private values = new Map<string, unknown>();
  read<T>(key: string, fallback: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : fallback;
  }
  write(key: string, value: unknown) {
    this.values.delete(key);
    this.values.set(key, value);
    for (const oldest of this.values.keys()) {
      if (this.values.size <= retainedValues) break;
      this.values.delete(oldest);
    }
  }
}
export const TranscriptRowState = createContext<TranscriptRowStore | null>(null);

/** Like `useState`, but stored under `key` in the transcript's row store when there is one. */
export function useRowState<T>(key: string | null, initial: T): [T, (value: T) => void] {
  const store = useContext(TranscriptRowState);
  const [local, setLocal] = useReducer((_: T, value: T) => value, initial);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const set = useCallback(
    (value: T) => {
      if (store && key !== null) {
        store.write(key, value);
        rerender();
      } else setLocal(value);
    },
    [store, key],
  );
  return [store && key !== null ? store.read(key, initial) : local, set];
}
