import type { CheckoutTarget, CommandOutput, LookupMatch } from '@moonbase/contracts/workspace';
import { fileKey } from '../recovery/recovery-references.ts';

export type LookupRow = LookupMatch & { checkout: CheckoutTarget; recent: boolean };
export type LookupSnapshot = { rows: LookupRow[]; message: string; busy: boolean };
export const emptyLookup: LookupSnapshot = { rows: [], message: 'Type a filename or path.', busy: false };

/** The most checkouts one lookup searches. */
export const lookupCheckouts = 8;

/**
 * The rows for a lookup's answers, one per file, recent files first, then by score, at most 100,
 * with the message that sums them up.
 */
export function rankLookup(
  answers: readonly { checkout: CheckoutTarget; result: CommandOutput<'lookupFiles'> }[],
  errors: readonly string[],
  truncated: boolean,
) {
  const rows: LookupRow[] = [],
    failures = [...errors];
  let partial = truncated;
  for (const { checkout, result } of answers) {
    partial ||= result.partial;
    if (result.error) failures.push(result.error);
    for (const recent of result.history) rows.push({ ...recent, checkout, recent: true });
    for (const match of result.matches) rows.push({ ...match, checkout, recent: false });
  }
  const unique = [
    ...new Map(rows.map((row) => [fileKey({ checkout: row.checkout, path: row.path }), row])).values(),
  ];
  unique.sort((a, b) => Number(b.recent) - Number(a.recent) || (a.recent ? 0 : b.score - a.score));
  const shown = Math.min(unique.length, 100);
  return {
    rows: unique.slice(0, 100),
    message: `${shown} results${partial || unique.length > 100 ? '; partial coverage. Refine the query or Refresh.' : ''}${failures.length ? '; ' + failures.join('; ') : ''}`,
  };
}
