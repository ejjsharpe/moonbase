import { useEffect, useState } from 'react';
import type { EditorLookup, EditorTextSearch } from '@moonbase/application/editor';

/** One lookup or text-search model for the picker's lifetime, disposed when it closes. */
export function useQueryModel<T extends EditorLookup | EditorTextSearch>(
  create: () => T,
  report: (error: unknown) => void,
) {
  const [model, setModel] = useState<T | null>(null);
  useEffect(() => {
    const acquired = create();
    setModel(acquired);
    return () => {
      void acquired.dispose().catch(report);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- one query model per popup.
  }, []);
  return model;
}
