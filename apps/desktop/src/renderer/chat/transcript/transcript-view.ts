import { Option } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import {
  getTranscriptSourceKey,
  makeTranscriptAtoms,
  type ChatAtoms,
  type ChatSelectionShape,
  type TranscriptRow,
  type TranscriptState,
} from '@moonbase/application/chat';
import {
  findGroupStarts,
  groupTranscriptRows,
  kindOfRow,
  type TranscriptItem,
} from './list/list-items.ts';
import { makeOpenCalls } from './activity/open-calls.ts';

/** The transcript a view presents, and the running response it was presented with. */
type Presented = { transcript: TranscriptState; live: string | null; held: boolean };

/** Which run the live row shows (its source, or its key while it has none); null without one. */
const getLiveIdentity = ({ rows }: TranscriptState) => {
  const last = rows.at(-1);
  return last?.kind === 'live'
    ? getTranscriptSourceKey(last.entry.transcript?.source) || last.key
    : null;
};

/**
 * Presents the latest transcript, except that a reader's selection in the live response holds the
 * transcript it was made in while the run that produced it is replaced.
 */
const present = (
  previous: Presented | undefined,
  transcript: TranscriptState,
  readingLive: boolean,
): Presented => {
  const live = getLiveIdentity(transcript);
  if (!readingLive || !previous || previous.live === live) return { transcript, live, held: false };
  return previous.held ? previous : { ...previous, held: true };
};

type Items = TranscriptItem<TranscriptRow>[];
const isSameItems = (a: Items, b: Items) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * One mounted transcript view's state: what it presents, the list items it groups the rows into,
 * and the atoms its rows read. Made per view, and released with it. Each atom reads one parent, or
 * parents that change independently: an observed atom rebuilds as each parent changes, so one
 * reading two atoms of one source could see one change before the other.
 */
export function makeTranscriptView(
  chat: Pick<ChatAtoms, 'transcript'>,
  selection: ChatSelectionShape,
) {
  /** The reader's focus or selection is in the live response (written by the view). */
  const readingLive = Atom.make(false);
  /** The list follows the live edge (written by the view as the list reports it). */
  const followingEdge = Atom.make(true);
  const presented = Atom.readable((get) =>
    present(Option.getOrUndefined(get.self<Presented>()), get(chat.transcript), get(readingLive)),
  );
  const transcript = Atom.readable((get) => get(presented).transcript);
  /** The list's items; each grouping keeps the previous items' keys (see `groupTranscriptRows`). */
  const items = Atom.readable((get) =>
    groupTranscriptRows(
      get(transcript).rows,
      kindOfRow,
      Option.getOrElse(get.self<Items>(), (): Items => []),
      get(followingEdge),
    ),
  ).pipe(Atom.withEquality(isSameItems));
  const starts = Atom.readable((get) => findGroupStarts(get(items)));
  return {
    readingLive,
    followingEdge,
    transcript,
    /** Whether the view holds an earlier transcript for the reader's selection. */
    held: Atom.readable((get) => get(presented).held),
    items,
    /** The list item holding each row: a row in an activity run is drawn by the run's item. */
    itemKeys: Atom.readable(
      (get) =>
        new Map(get(items).flatMap((item) => item.rows.map((row) => [row.key, item.key] as const))),
    ),
    /** An item's start: the latest time recorded before it, where the work it shows began. */
    startedAt: Atom.family((itemKey: string) => Atom.readable((get) => get(starts).get(itemKey))),
    /** Jumps to the latest history; waiting while the jump reads. */
    jumpToLatest: Atom.fn(() => selection.jumpToLatest),
    rows: makeTranscriptAtoms(transcript),
    openCalls: makeOpenCalls(),
  };
}
export type TranscriptView = ReturnType<typeof makeTranscriptView>;

/** The key a row's source state is read under. */
export const getRowSourceKey = (row: TranscriptRow) =>
  getTranscriptSourceKey(row.entry.transcript?.source);
