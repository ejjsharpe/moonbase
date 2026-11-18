import type { ResultsByCall, TranscriptRow } from '@moonbase/application/chat';
import { getLaterTime } from '../list/list-items.ts';
import {
  describeActivityHeadline,
  getActivityStepState,
  getAnsweredCall,
  groupActivitySteps,
  type ActivityHeadline,
} from './activity.ts';

/** Every step a run of rows shows, in order; a call's output row adds none of its own. */
export function collectRunSteps(
  rows: readonly TranscriptRow[],
  results: ResultsByCall,
  /** Whether a call's row is retained; its output then belongs to the call's step. */
  isRetained: (entryId: string) => boolean,
) {
  const headlines: ActivityHeadline[] = [];
  let failed = 0,
    active = false,
    endedAt: string | undefined,
    // The last row's steps: the model message the work is on now.
    latestRow: ActivityHeadline[] = [];
  for (const row of rows) {
    endedAt = getLaterTime(endedAt, row.entry.createdAt);
    if (!row.entry.transcript) continue;
    if (row.kind === 'live' && row.state === 'running') active = true;
    const transcript = row.entry.transcript;
    const entryId = transcript.source.kind === 'entry' ? transcript.source.entryId : undefined;
    const rowHeadlines: ActivityHeadline[] = [];
    for (const step of groupActivitySteps(transcript.parts, entryId)) {
      const call = getAnsweredCall(step);
      if (call && isRetained(call.entryId)) continue;
      const state = getActivityStepState(step, transcript, results);
      if (['failed', 'interrupted', 'missing-result'].includes(state ?? '')) failed++;
      // A running step keeps the clock going only in the live response (stopping or deferred
      // included); a saved step can't still be running.
      if (state === 'running' && row.kind === 'live') active = true;
      const headline = describeActivityHeadline(step, transcript, results);
      headlines.push(headline);
      rowHeadlines.push(headline);
    }
    if (rowHeadlines.length) latestRow = rowHeadlines;
  }
  // Now: the thought the latest message opened with, which says why; else the step itself. A
  // thought from an earlier message may be about other work, so it is never paired with this one.
  const current =
    latestRow.at(-1)?.category === 'thinking'
      ? latestRow.at(-1)
      : (latestRow.findLast((headline) => headline.category === 'thinking') ?? latestRow.at(-1));
  return {
    headlines,
    failed,
    active,
    ...(current ? { current } : {}),
    ...(endedAt ? { endedAt } : {}),
  };
}
