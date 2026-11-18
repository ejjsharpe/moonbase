import { memo, useId, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from '@effect/atom-react';
import { getTranscriptSourceKey, type TranscriptRow } from '@moonbase/application/chat';
import { activityStyles } from '../activity/activity-card.tsx';
import { RunLine } from '../activity/activity-run-line.tsx';
import { collectRunSteps } from '../activity/activity-run.ts';
import { useFoldedFindMatch } from '../disclosure/disclosure.ts';
import { useRememberedFold } from '../disclosure/remembered-fold.ts';
import { kindOfRow, type TranscriptItem } from '../list/list-items.ts';
import { ReadingColumn } from '../transcript-column.tsx';
import { useTranscript } from '../transcript-context.ts';
import { getRowSourceKey } from '../transcript-view.ts';
import { TranscriptRowView } from './transcript-row.tsx';

/**
 * A list item: one row, or a run of consecutive activity rows. A run with more than one step folds
 * behind one line; its rows stay mounted underneath so Find can reach them.
 */
export const TranscriptItemView = memo(function TranscriptItemView({
  item,
}: {
  item: TranscriptItem<TranscriptRow>;
}) {
  const { view, act, selection, target } = useTranscript();
  const { rows } = view;
  const startedAt = useAtomValue(view.startedAt(item.key));
  const expanded = useAtomValue(rows.expanded);
  const anchorKey = useAtomValue(rows.anchorKey);
  const activeFind = useAtomValue(rows.activeFind);
  const retained = useAtomValue(rows.retained);
  const results = useAtomValue(rows.resultsByCall);
  const firstEntry = item.rows[0];
  // Remembered under both the item's key, which holds as earlier rows join the run's start, and
  // its first row's, which holds as the live response leaves the run or starts a new attempt.
  const byItem = useRememberedFold(item.key, 'activity-run', expanded);
  const byFirstRow = useRememberedFold(firstEntry?.entry.id ?? item.key, 'activity-run', expanded);
  const fold = {
    open: byItem.open || byFirstRow.open,
    setOpen: (open: boolean) => {
      byItem.setOpen(open);
      byFirstRow.setOpen(open);
    },
  };
  // The reader's place moving into a folded run (a jump, a restored position) opens it, so the
  // place is on a shown row. A folded run's own place is its first stored row, at the run's line;
  // a live row is never a place the reader scrolls to, so a place there is a jump.
  const ownPlace = firstEntry?.kind === 'entry' ? firstEntry.key : undefined;
  const placeInside =
    anchorKey !== null && anchorKey !== ownPlace && item.rows.some((row) => row.key === anchorKey)
      ? anchorKey
      : null;
  const [landed, setLanded] = useState<{ place: string | null; open: boolean }>({
    place: null,
    open: false,
  });
  if (landed.place !== placeInside)
    setLanded({ place: placeInside, open: placeInside !== null || landed.open });
  // The active Find match in the run opens it, unless the reader folded it for that match.
  const matchKey = getTranscriptSourceKey(activeFind.match?.source);
  const matched = !!matchKey && item.rows.some((row) => getRowSourceKey(row) === matchKey);
  const found = useFoldedFindMatch(
    matched ? activeFind.match : null,
    matched && activeFind.revealing,
  );
  // A response that is only working so far is a run of one, and gets the working line too.
  const first = item.rows[0]!;
  const working =
    item.rows.length === 1 && first.kind === 'live' && kindOfRow(first) === 'activity';
  const run = useMemo(
    () =>
      item.rows.length > 1 || working
        ? collectRunSteps(item.rows, results, (entryId) => retained.has(entryId))
        : null,
    [item.rows, working, results, retained],
  );
  const stepsId = useId();
  // A working run shows its line even before it has a step to name.
  const folds = !!run && (run.active || run.headlines.length >= 2);
  const open = !folds || fold.open || landed.open || found.holdsOpen;
  const toggle = () => {
    if (open) {
      if (found.holdsOpen) found.fold();
      // A place left inside the run would name a row it no longer shows; the run's line holds it.
      if (firstEntry && placeInside)
        void act(
          selection.updateTranscriptView(target, (view) =>
            view.anchor?.key === placeInside
              ? { ...view, anchor: { key: firstEntry.key, offset: 0 } }
              : view,
          ),
        );
    }
    setLanded({ place: placeInside, open: false });
    fold.setOpen(!open);
  };
  // One shape whether or not the run folds, so its rows stay mounted as it starts or stops
  // folding (the live response leaving a run as its answer starts, say).
  return (
    <>
      {folds && (
        // Marks the run's line as part of its first row: the list holds the reader's place as it
        // opens, and keeps it mounted while it has focus.
        <ReadingColumn run={firstEntry?.key ?? item.key}>
          <section {...stylex.props(activityStyles.card, open ? styles.runOpen : styles.runFolded)}>
            <RunLine
              {...run}
              {...(startedAt ? { startedAt } : {})}
              open={open}
              stepsId={stepsId}
              onToggle={toggle}
            />
          </section>
        </ReadingColumn>
      )}
      <div id={stepsId} hidden={!open} {...stylex.props(folds && styles.steps)}>
        {item.rows.map((row, index) => (
          <TranscriptRowView
            key={row.key}
            row={row}
            joinPrevious={folds || index > 0}
            joinNext={index < item.rows.length - 1}
          />
        ))}
      </div>
    </>
  );
});

const styles = stylex.create({
  /**
   * A folded run reads as the heading of the answer under it: the answer starts 12px below the
   * rule, not a full gap between list items.
   */
  runFolded: { marginTop: 0, marginBottom: -7 },
  /** Open, the first step's letters start 16px below the rule… */
  runOpen: { marginTop: 0, marginBottom: 5 },
  /** …and the answer starts 12px below the last step, as it does below the folded rule. */
  steps: { marginBottom: -14 },
});
