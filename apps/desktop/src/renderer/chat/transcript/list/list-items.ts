import type { TranscriptRow, TranscriptState } from '@moonbase/application/chat';
import { classifyEntry } from '../activity/activity.ts';

/**
 * The list's items: each row on its own, except that empty turn markers are left out and a run of
 * consecutive activity rows is one item, so the list's gap never splits a turn's card. Items whose
 * rows are unchanged keep their identity.
 *
 * The list keys an item's content and measured size by the item's key, so a new key remounts it.
 * Rows join a run at its start (history loading above) and its end (the live response, a later
 * page), so a run holding a row of a `previous` item keeps that item's key. The live row (any row
 * not `entry`) leaves a run as the answer starts, and the key stays with the part the reader is
 * in: the live row when they follow the live edge (`following`), so a selection, focus or Find
 * fold in the running response survives, else the card's stored rows, which the list holds in
 * place. Otherwise, when an item splits the first run keeps it, and a new item is keyed by its
 * last row. Keys are list keys only: `findReadingAnchor` names a row.
 */
export type TranscriptItem<Row> = { key: string; rows: readonly Row[] };
export function groupTranscriptRows<Row extends { key: string; kind: string }>(
  rows: readonly Row[],
  kindOf: (row: Row) => 'empty' | 'activity' | 'message',
  previous: readonly TranscriptItem<Row>[],
  following = false,
) {
  const runs: Row[][] = [];
  let open = false;
  for (const row of rows) {
    const kind = kindOf(row);
    if (kind === 'empty') continue;
    if (kind === 'activity' && open) runs.at(-1)!.push(row);
    else runs.push([row]);
    open = kind === 'activity';
  }
  const itemOf = new Map(previous.flatMap((item) => item.rows.map((row) => [row.key, item])));
  const runOf = new Map(runs.flatMap((run) => run.map((row) => [row.key, run])));
  const claimed = new Set<string>();
  const carried = new Map<Row[], TranscriptItem<Row>>();
  const carry = (run: Row[], old: TranscriptItem<Row>) => {
    claimed.add(old.key);
    carried.set(run, old);
  };
  // Following, a live row that left its item's other rows keeps the item.
  if (following)
    for (const run of runs)
      for (const row of run) {
        const old = row.kind !== 'entry' ? itemOf.get(row.key) : undefined;
        if (old && !claimed.has(old.key) && old.rows.some((value) => runOf.get(value.key) !== run))
          carry(run, old);
      }
  for (const run of runs) {
    if (carried.has(run)) continue;
    const old = run
      .map((row) => itemOf.get(row.key))
      .find((item) => item && !claimed.has(item.key));
    if (old) carry(run, old);
  }
  return runs.map((run): TranscriptItem<Row> => {
    const old = carried.get(run);
    if (old?.rows.length === run.length && old.rows.every((row, i) => row === run[i])) return old;
    let key = old?.key ?? run.at(-1)!.key;
    // A row's key can name another run's carried key, so a new key must be unclaimed.
    for (let suffix = 1; !old && claimed.has(key); suffix++) key = `${run.at(-1)!.key}#${suffix}`;
    claimed.add(key);
    return { key, rows: run };
  });
}

/**
 * The reading anchor for the list's first visible item: a stored row and how far the viewport top
 * is below that row's own top, so it holds however much of a card a restore reads above the row.
 * `visible` is the item and its offset from the item's top; `rowTop` is a row's top within its
 * item, in the same terms (undefined while unmeasured or not shown). The anchor is the stored row the
 * viewport top is in or below, or a live row's nearest stored row above it, at its offset from
 * that row's item (`measure`), so a reader in the live response isn't taken to follow the live
 * edge. With no stored row above, it names the item's first row.
 */
export function findReadingAnchor<Row extends { key: string; kind: string }>(
  items: readonly TranscriptItem<Row>[],
  visible: { key: string; offset: number },
  {
    measure,
    rowTop,
  }: {
    measure(itemKey: string): number | undefined;
    rowTop(rowKey: string): number | undefined;
  },
) {
  const index = items.findIndex((item) => item.key === visible.key);
  if (index < 0) return undefined;
  for (let i = index; i >= 0; i--) {
    const item = items[i]!;
    const offset = i === index ? visible.offset : measure(item.key);
    if (offset === undefined) return undefined;
    let anchor: { key: string; offset: number } | undefined;
    for (const [position, row] of item.rows.entries()) {
      // The first row is at the item's top, unless something sits above it (a folded run's
      // line); a row the item doesn't show (a folded run's) has no top and ends the search.
      const top = rowTop(row.key) ?? (position ? undefined : 0);
      // A row landed a fraction of a device pixel below the viewport top still holds it.
      if (top === undefined || (top > offset + 1 && anchor)) break;
      if (row.kind === 'entry') anchor = { key: row.key, offset: offset - top };
    }
    if (anchor) return anchor;
  }
  return { key: items[index]!.rows[0]!.key, offset: visible.offset };
}

/** The live response is never empty: until it has something to show, it is working. */
export const kindOfRow = (row: TranscriptRow) => {
  const kind = classifyEntry(row.entry);
  return kind === 'empty' && row.kind === 'live' ? 'activity' : kind;
};

export const getItemKey = (item: TranscriptItem<TranscriptRow>) => item.key;

/**
 * The list sizes an unmeasured item by its type's average, so messages are typed by role and length
 * (as T3 Code does): messages of one role differ in height by orders of magnitude, and a long one
 * is its own type rather than an average of unlike ones. An item whose type changes is sized afresh,
 * so the running response keeps one type as it grows.
 */
export const getItemType = (item: TranscriptItem<TranscriptRow>) => {
  const row = item.rows[0]!;
  if (item.rows.length > 1 || kindOfRow(row) === 'activity') return 'activity';
  if (row.kind !== 'entry') return row.kind;
  const parts = row.entry.transcript.parts.filter((part) => part.kind === 'text');
  const size = parts.length
    ? parts.reduce((sum, part) => sum + part.bytes, 0)
    : row.entry.text.length;
  const bucket = Math.max(0, Math.floor(Math.log2(size / 1000)));
  return bucket < 2 ? `${row.entry.role}:${bucket}` : `${row.entry.role}:${row.key}`;
};

/** Where the saved anchor's item is in the dataset; without an anchor it opens at the end. */
export function findPlacement(
  { dataset, view }: Pick<TranscriptState, 'dataset' | 'view'>,
  items: readonly TranscriptItem<TranscriptRow>[],
) {
  const anchor = view.anchor;
  const index = anchor
    ? items.findIndex((item) => item.rows.some((row) => row.key === anchor.key))
    : -1;
  return index >= 0 ? { dataset, anchor, index } : { dataset, anchor: null, index: -1 };
}

/** The later of two recorded times. */
export const getLaterTime = (a: string | undefined, b: string | undefined) =>
  !a || (b && Date.parse(b) > Date.parse(a)) ? b : a;

/** Each item's start: the latest time recorded before it, where the work it shows began. */
export function findGroupStarts(items: readonly TranscriptItem<TranscriptRow>[]) {
  const starts = new Map<string, string>();
  let last: string | undefined;
  for (const item of items) {
    if (last) starts.set(item.key, last);
    for (const row of item.rows) last = getLaterTime(last, row.entry.createdAt);
  }
  return starts;
}
