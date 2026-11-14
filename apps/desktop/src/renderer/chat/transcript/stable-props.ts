import type { ChatTranscriptSource } from '@moonbase/contracts/chat';
import { areJsonValuesEqual, getJsonKey } from '@moonbase/contracts/common';

/**
 * Transcript rows memoize on their props. Snapshots arrive as fresh objects on every update, so
 * row comparators compare lists element-wise and transcript parts field-wise.
 */
const empty: readonly never[] = [];

/** Groups items by source value, whatever its key order; rows receive their own group. */
export function groupBySource<T extends { source: ChatTranscriptSource }>(items: readonly T[]) {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = getJsonKey(item.source);
    const group = grouped.get(key);
    if (group) group.push(item);
    else grouped.set(key, [item]);
  }
  return (source: ChatTranscriptSource | undefined): readonly T[] =>
    (source && grouped.get(getJsonKey(source))) || empty;
}

function isSameList(a: unknown, b: unknown) {
  return (
    a === b ||
    (Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => item === b[i]))
  );
}

/** Same fields; nested values (a part's small `call`) compare as JSON values. */
function isSameRecord(a: unknown, b: unknown) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = Object.entries(a),
    right = b as Record<string, unknown>;
  return (
    left.length === Object.keys(right).length &&
    left.every(
      ([key, value]) =>
        value === right[key] ||
        (typeof value === 'object' && areJsonValuesEqual(value, right[key])),
    )
  );
}

/** A `memo` comparator: `lists` compare element-wise, `records` field-wise, the rest by identity. */
export function compareProps<P extends object>({
  lists = [],
  records = [],
}: {
  lists?: (keyof P)[];
  records?: (keyof P)[];
}) {
  return (a: P, b: P) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof P)[]);
    for (const key of keys) {
      if (lists.includes(key) ? isSameList(a[key], b[key]) : a[key] === b[key]) continue;
      if (records.includes(key) && isSameRecord(a[key], b[key])) continue;
      return false;
    }
    return true;
  };
}
