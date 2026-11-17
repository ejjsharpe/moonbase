import { getParentPath } from '@moonbase/contracts/paths';
import type { CheckoutTarget, DirectoryEntry } from '@moonbase/contracts/workspace';
import type { EditorActions } from '../editor-actions.ts';

/**
 * Lists the folders an undo or paste reads: each folder's entries, or none when it is gone. A
 * folder whose listing fails is gone only when its parent lists without it; otherwise, since it
 * may still be there, the result names it as `unlisted`.
 */
export async function listFolders(
  actions: EditorActions,
  checkout: CheckoutTarget,
  folders: readonly string[],
) {
  type Read = readonly DirectoryEntry[] | 'gone' | 'unlisted';
  const reads = new Map<string, Promise<Read>>();
  const read = (folder: string): Promise<Read> => {
    const known = reads.get(folder);
    if (known) return known;
    const reading = (async (): Promise<Read> => {
      try {
        const listing = await actions.list(checkout, folder);
        if (!listing.error) return listing.entries;
      } catch {
        // The editor reports the failure; whether the folder is gone is decided below.
      }
      if (!folder) return 'unlisted';
      const parent = await read(getParentPath(folder));
      if (parent === 'unlisted') return parent;
      if (parent === 'gone' || !parent.some((entry) => entry.path === folder && entry.directory))
        return 'gone';
      return 'unlisted';
    })();
    reads.set(folder, reading);
    return reading;
  };
  const listings = new Map<string, readonly DirectoryEntry[]>();
  let unlisted: string | undefined;
  for (const [index, entries] of (await Promise.all(folders.map(read))).entries()) {
    if (entries === 'unlisted') unlisted ??= folders[index];
    else if (entries !== 'gone') listings.set(folders[index], entries);
  }
  return { listings, unlisted };
}
