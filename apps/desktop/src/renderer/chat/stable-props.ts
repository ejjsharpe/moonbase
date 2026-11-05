import { useMemo, useState } from 'react';
import type { ChatTranscriptSource } from '@moonbase/contracts/chat';

/**
 * Transcript rows memoize on their props. Snapshots arrive as fresh objects on every update, so
 * these keep the previous value while it is structurally unchanged.
 */
const empty: readonly never[] = [];

/** Keeps `value` while its JSON form is unchanged. Use for small values only. */
export function useStableValue<T>(value: T): T {
  const key = JSON.stringify(value);
  const [kept, setKept] = useState({ key, value });
  if (kept.key === key) return kept.value;
  setKept({ key, value });
  return value;
}

type KeptItems<T> = { list: readonly T[]; items: Map<string, { json: string; item: T }> };
/** Keeps each item, by `getKey`, while its JSON form is unchanged, and the list while all are. */
export function useStableItems<T>(items: readonly T[], getKey: (item: T) => string): readonly T[] {
  const [kept, setKept] = useState<KeptItems<T>>({ list: empty, items: new Map() });
  const next = new Map<string, { json: string; item: T }>();
  const list = items.map((item) => {
    const key = getKey(item),
      json = JSON.stringify(item),
      old = kept.items.get(key);
    const reused = old?.json === json ? old.item : item;
    next.set(key, { json, item: reused });
    return reused;
  });
  if (list.length === kept.list.length && list.every((item, i) => item === kept.list[i]))
    return kept.list;
  setKept({ list, items: next });
  return list;
}

/**
 * Groups items by exact source, keeping each group's array while its items are identical, so a
 * row receives a new array only when its own items change.
 */
export function useSourceGroups<T extends { source: ChatTranscriptSource }>(items: readonly T[]) {
  const [kept, setKept] = useState(() => new Map<string, readonly T[]>());
  const groups = useMemo(() => {
    const grouped = new Map<string, T[]>();
    for (const item of items) {
      const key = JSON.stringify(item.source);
      const group = grouped.get(key);
      if (group) group.push(item);
      else grouped.set(key, [item]);
    }
    let changed = grouped.size !== kept.size;
    const stable = new Map<string, readonly T[]>();
    for (const [key, group] of grouped) {
      const old = kept.get(key);
      const same = old?.length === group.length && old.every((item, i) => item === group[i]);
      if (!same) changed = true;
      stable.set(key, same ? old : group);
    }
    return changed ? stable : kept;
  }, [items, kept]);
  if (groups !== kept) setKept(groups);
  return (source: ChatTranscriptSource | undefined): readonly T[] =>
    (source && groups.get(JSON.stringify(source))) || empty;
}
