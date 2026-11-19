import { Deferred, Effect } from 'effect';
import { getParentPath } from '@moonbase/contracts/paths';
import type { CheckoutTarget, DirectoryEntry } from '@moonbase/contracts/workspace';
import type { EditorActions } from '../editor-actions.ts';

type Read = readonly DirectoryEntry[] | 'gone' | 'unlisted';

/**
 * Lists the folders an undo or paste reads: each folder's entries, or none when it is gone. A
 * folder whose listing fails is gone only when its parent lists without it; otherwise, since it
 * may still be there, the result names it as `unlisted`.
 */
export const listFolders = (
  actions: EditorActions,
  checkout: CheckoutTarget,
  folders: readonly string[],
) =>
  Effect.gen(function* () {
    // Each folder is read once, however many folders ask about it as their parent.
    const reads = new Map<string, Deferred.Deferred<Read>>();
    const read = (folder: string): Effect.Effect<Read> =>
      Effect.suspend(() => {
        const known = reads.get(folder);
        if (known) return Deferred.await(known);
        const reading = Deferred.makeUnsafe<Read>();
        reads.set(folder, reading);
        const work = Effect.gen(function* () {
          // The editor reports a failure; whether the folder is gone is decided below.
          const listing = yield* Effect.option(actions.list(checkout, folder));
          if (listing._tag === 'Some' && !listing.value.error) return listing.value.entries;
          if (!folder) return 'unlisted' as const;
          const parent = yield* read(getParentPath(folder));
          if (parent === 'unlisted') return parent;
          if (
            parent === 'gone' ||
            !parent.some((entry) => entry.path === folder && entry.directory)
          )
            return 'gone' as const;
          return 'unlisted' as const;
        });
        return Effect.andThen(Deferred.into(work, reading), Deferred.await(reading));
      });
    const listings = new Map<string, readonly DirectoryEntry[]>();
    let unlisted: string | undefined;
    const listed = yield* Effect.all(folders.map(read), { concurrency: 'unbounded' });
    for (const [index, entries] of listed.entries()) {
      if (entries === 'unlisted') unlisted ??= folders[index];
      else if (entries !== 'gone') listings.set(folders[index], entries);
    }
    return { listings, unlisted };
  });
