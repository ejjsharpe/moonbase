import { useContext, useEffect, useState } from 'react';
import { RegistryContext } from '@effect/atom-react';
import type { ChatTranscriptMatch } from '@moonbase/contracts/chat';
import { useTranscript } from '../transcript-context.ts';
import { isRemembered, rememberExpansion, useExpansionId } from './expansion.ts';

/**
 * The active Find match a reader folded a disclosure on. The fold lasts while that match is
 * active, and ends once no match is here or Find reveals the match again.
 */
export function useFoldedFindMatch(match: ChatTranscriptMatch | null, revealing: boolean) {
  const { view, act, selection } = useTranscript();
  const registry = useContext(RegistryContext);
  const key = match ? JSON.stringify(match) : null;
  const [folded, setFolded] = useState<string | null>(null);
  if (folded !== null && (key === null || revealing)) setFolded(null);
  // A reveal into a folded run can start and end before it renders again, so the fold listens.
  useEffect(() => {
    if (folded === null) return;
    // A subscription follows an atom once it has been read.
    registry.get(view.rows.activeFind);
    return registry.subscribe(view.rows.activeFind, (find) => {
      if (find.revealing || !find.match || JSON.stringify(find.match) !== folded) setFolded(null);
    });
  }, [registry, view, folded]);
  return {
    /** The match holds the disclosure open. */
    holdsOpen: key !== null && folded !== key,
    /** Folds on the match: reader input, so it ends the reveal, which would open it again. */
    fold() {
      if (key === null) return;
      void act(selection.cancelFindReveal);
      setFolded(key);
    },
  };
}

/**
 * A remembered disclosure: open when its view memory says so, and while the active Find match is
 * inside it unless the reader folded it for that match.
 */
export function useDisclosure({
  entryId,
  id,
  expanded,
  match,
  revealing,
}: {
  entryId: string;
  id: string;
  /** View memory of expanded disclosure IDs. */
  expanded: readonly string[];
  /** The active Find match, when it is inside this disclosure. */
  match: ChatTranscriptMatch | null;
  /** Find is revealing the active match: it was just moved to, and no reader input ended that. */
  revealing: boolean;
}) {
  const transcript = useTranscript();
  const { expansion, failed: disclosureError } = useExpansionId(entryId, id);
  const found = useFoldedFindMatch(match, revealing);
  const open = isRemembered(expansion, disclosureError, expanded) || found.holdsOpen;
  const toggle = () => {
    if (!expansion) return;
    if (open) found.fold();
    rememberExpansion(transcript, expansion, !open);
  };
  return {
    open,
    disclosureError,
    disabled: !expansion,
    onOpenChange: toggle,
  };
}
