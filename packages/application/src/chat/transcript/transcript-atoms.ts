import * as Atom from 'effect/reactivity/Atom';
import type { ChatTranscriptMatch } from '@moonbase/contracts/chat';
import type { TranscriptState } from './transcript-state.ts';
import {
  indexTranscriptSources,
  isSameItems,
  isSameTranscriptRowState,
  selectTranscriptRowState,
} from './transcript-row-state.ts';
import {
  collectResultsByCall,
  isSameResultsByCall,
  listShownTranscripts,
} from './results-by-call.ts';

type ActiveFind = { match: ChatTranscriptMatch | null; revealing: boolean };

/**
 * Atoms over a transcript for its rows: each notifies only when what it selects changes, so a row
 * re-renders only for its own state. `transcript` is the transcript a view shows.
 */
export function makeTranscriptAtoms(transcript: Atom.Atom<TranscriptState>) {
  // Rows read the state and its index from one atom: an observed atom rebuilds as each parent
  // changes, so one reading both the state and an index of it could see a stale index.
  const indexed = Atom.readable((get) => {
    const state = get(transcript);
    return { state, index: indexTranscriptSources(state) };
  });
  return {
    transcript,
    /** The row whose source has this key (`getTranscriptSourceKey`). */
    row: Atom.family((sourceKey: string) =>
      Atom.readable((get) => {
        const { state, index } = get(indexed);
        return selectTranscriptRowState(state, index, sourceKey);
      }).pipe(Atom.withEquality(isSameTranscriptRowState)),
    ),
    /** Each call's matched results across the shown transcripts. */
    resultsByCall: Atom.readable((get) =>
      collectResultsByCall(listShownTranscripts(get(transcript))),
    ).pipe(Atom.withEquality(isSameResultsByCall)),
    /** The retained entries' IDs. */
    retained: Atom.readable(
      (get): ReadonlySet<string> => new Set(get(transcript).entries.map((entry) => entry.id)),
    ).pipe(
      Atom.withEquality(
        (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
          a.size === b.size && [...a].every((id) => b.has(id)),
      ),
    ),
    /** View memory's expanded disclosures. */
    expanded: Atom.readable((get): readonly string[] => get(transcript).view.expanded).pipe(
      Atom.withEquality(isSameItems),
    ),
    /** The row the saved reading position names. */
    anchorKey: Atom.readable((get) => get(transcript).view.anchor?.key ?? null),
    /** The active Find match, and whether Find is revealing it. */
    activeFind: Atom.readable((get): ActiveFind => ({
      match: get(transcript).find.active,
      revealing: get(transcript).find.revealing,
    })).pipe(
      Atom.withEquality(
        (a: ActiveFind, b: ActiveFind) => a.match === b.match && a.revealing === b.revealing,
      ),
    ),
  };
}
export type TranscriptAtoms = ReturnType<typeof makeTranscriptAtoms>;
