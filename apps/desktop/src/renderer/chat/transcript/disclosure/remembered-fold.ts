import { createContext, useContext, useState } from 'react';
import { useTranscript } from '../transcript-context.ts';
import { isRemembered, rememberExpansion, useExpansionId } from './expansion.ts';

/**
 * A fold remembered in view memory under a row and an ID, so it stays as the reader left it while
 * its rows are scrolled away and unmounted.
 */
export function useRememberedFold(entryId: string, id: string, expanded: readonly string[]) {
  const transcript = useTranscript();
  const { expansion, failed } = useExpansionId(entryId, id);
  return {
    open: isRemembered(expansion, failed, expanded),
    setOpen: (open: boolean) => {
      if (expansion) rememberExpansion(transcript, expansion, open);
    },
  };
}

/** The part whose rendered content a disclosure is in, such as a long code block. */
export const RowExpansionContext = createContext<{
  entryId: string;
  partId: string;
  expanded: readonly string[];
} | null>(null);

/**
 * A disclosure inside a part's rendered content, remembered with the part's own, so it stays as the
 * reader left it while its row is scrolled away. Outside a transcript row it is local state.
 */
export function useRememberedExpansion(id: string | null) {
  const row = useContext(RowExpansionContext);
  const fold = useRememberedFold(
    row?.entryId ?? '',
    `${row?.partId ?? ''}:${id ?? ''}`,
    row?.expanded ?? [],
  );
  const [local, setLocal] = useState(false);
  return !row || id === null ? { open: local, setOpen: setLocal } : fold;
}
