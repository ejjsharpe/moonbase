import type { LookupSnapshot, TextSearchSnapshot } from '@moonbase/application/editor';

type PickerQuery = {
  mode: 'goto' | 'find';
  query: string;
  hasCheckout: boolean;
  files: LookupSnapshot;
  found: TextSearchSnapshot;
};

/**
 * Whether the query on screen is still running. A refresh after a change on disk reports no
 * search, so this stays false while results refresh.
 */
export function isPickerSearching({ mode, query, hasCheckout, files, found }: PickerQuery) {
  if (!hasCheckout) return false;
  return mode === 'goto'
    ? !query.startsWith('>') && !!query.trim() && files.message === 'Searching…'
    : !!query && found.message === 'Searching…';
}

/** The line shown under the results, or '' when the rows speak for themselves. */
export function describePickerStatus(picker: PickerQuery & { rowCount: number }) {
  const { mode, query, hasCheckout, files, found, rowCount } = picker;
  if (mode === 'find') {
    if (!hasCheckout) return 'Open a project to search its files.';
    return query ? found.message : '';
  }
  if (query.startsWith('>')) return rowCount ? '' : 'No commands match.';
  if (!hasCheckout) return rowCount ? '' : 'Open a project to find its files.';
  if (
    !['Searching…', 'Type a filename or path.', ''].includes(files.message) &&
    !/^\d+ results$/.test(files.message)
  )
    // A failed open, a capped listing or a discovery error.
    return files.message;
  if (query.trim() && !rowCount && files.message !== 'Searching…') return 'No results.';
  return '';
}
