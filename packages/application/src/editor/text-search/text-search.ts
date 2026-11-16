import type { CheckoutTarget, CommandOutput, TextSearchFile } from '@moonbase/contracts/workspace';

export type TextSearchOptions = { matchCase: boolean; wholeWord: boolean; regex: boolean };
export type TextSearchSnapshot = {
  files: TextSearchFile[];
  checkout?: CheckoutTarget;
  message: string;
  busy: boolean;
};
export const emptyTextSearch: TextSearchSnapshot = {
  files: [],
  message: 'Type text to search for.',
  busy: false,
};

/** The message summing up a search's matches. */
export function describeMatches({ files, partial, error }: CommandOutput<'searchText'>) {
  const count = files.reduce((n, file) => n + file.matches.length, 0);
  let message = count
    ? `${count} ${count === 1 ? 'match' : 'matches'} in ${files.length} ${files.length === 1 ? 'file' : 'files'}`
    : 'No matches.';
  if (partial) message += '; capped. Refine the query.';
  if (error) message += '; ' + error;
  return message;
}
