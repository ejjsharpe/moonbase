import { createContext, useContext } from 'react';
import type { ChatRun } from '@moonbase/contracts/chat';
import type { TranscriptRow } from '@moonbase/application/chat';
import { ReadingColumn } from '../transcript-column.tsx';
import { Entry } from './entry.tsx';

/**
 * The live row's status when the transcript names it: the conversation's state once it isn't
 * running, or that the reader's selection holds an earlier response.
 */
export const LiveLabelContext = createContext<string | undefined>(undefined);

/** A run that is simply running needs no label; its activity already shows it. */
const getRunLabel = (state: ChatRun['state']) => (state === 'running' ? undefined : state);

/** One row in the reading column; an activity row joins the rows of its run. */
export function TranscriptRowView({
  row,
  joinPrevious,
  joinNext,
}: {
  row: TranscriptRow;
  joinPrevious: boolean;
  joinNext: boolean;
}) {
  const liveLabel = useContext(LiveLabelContext);
  return (
    <ReadingColumn row={row.key}>
      <Entry
        entry={row.entry}
        live={row.kind === 'live'}
        liveLabel={row.kind === 'live' ? (liveLabel ?? getRunLabel(row.state)) : undefined}
        joinPrevious={joinPrevious}
        joinNext={joinNext}
      />
    </ReadingColumn>
  );
}
