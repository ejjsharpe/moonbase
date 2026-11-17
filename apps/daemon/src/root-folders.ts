import { basename, dirname, join } from 'node:path';
import { Effect, FileSystem, Option } from 'effect';
import type { FolderApprovals } from '@moonbase/contracts/daemon';
import {
  FolderMissingError,
  FolderRefusedError,
  InvalidRootsError,
} from '@moonbase/contracts/folder-errors';
import { maximumHostFolders } from '@moonbase/contracts/daemon-schema';

/** Exact, for real paths in their on-disk spelling; fold first to compare as macOS volumes do. */
const isInside = (root: string, path: string) =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
const folded = (path: string) => path.normalize('NFC').toLowerCase();

/** A directory's identity, to tell it from another put in its place. */
type Identity = { dev: bigint; ino: Option.Option<bigint> };
const isSame = (info: Identity, identity: Identity) =>
  info.dev === identity.dev &&
  Option.getOrUndefined(info.ino) === Option.getOrUndefined(identity.ino);

/**
 * A host-mode daemon's folders: its approved roots and any folder under one, named by its real
 * path. Each root is checked at startup and must stay the same directory, so a root replaced by
 * another folder or a link approves nothing, and a path through a link never resolves to itself.
 * Nothing is stored: a remote client has no picker for the host's disk, so it chooses from the
 * roots and their subfolders. A root that holds or sits in a `reserved` path is refused.
 */
export const makeRootFolders = (
  roots: readonly string[],
  { reserved = [] }: { reserved?: readonly string[] } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lstat = (path: string) => Effect.option(fs.lstat(path));
    const realPath = (path: string) => Effect.orElseSucceed(fs.realPath(path), () => '');
    const identities = yield* Effect.forEach(roots, (root) =>
      Effect.gen(function* () {
        const info = yield* lstat(root);
        if (
          Option.isNone(info) ||
          info.value.type !== 'Directory' ||
          (yield* realPath(root)) !== root
        )
          return yield* new InvalidRootsError({ problem: 'not-real-folder' });
        return { root, dev: info.value.dev, ino: info.value.ino };
      }),
    );
    /** A path's real path, through its folder when the path itself doesn't exist yet. */
    const findRealPath = (path: string) =>
      fs.realPath(path).pipe(
        Effect.catch(() =>
          Effect.map(
            Effect.orElseSucceed(fs.realPath(dirname(path)), () => dirname(path)),
            (folder) => join(folder, basename(path)),
          ),
        ),
      );
    // A root holding the daemon's data or credential key would let chats and `@` search read them.
    // Folded, as a path not made yet keeps the case it was named in.
    const held = (yield* Effect.forEach(reserved, findRealPath)).map(folded);
    if (
      identities.some(({ root }) =>
        held.some((path) => isInside(folded(root), path) || isInside(path, folded(root))),
      )
    )
      return yield* new InvalidRootsError({ problem: 'holds-reserved' });
    /** Whether a root is still the directory it was at startup. */
    const unchanged = (identity: (typeof identities)[number]) =>
      Effect.map(
        lstat(identity.root),
        (info) =>
          Option.isSome(info) && info.value.type === 'Directory' && isSame(info.value, identity),
      );
    const has = (path: string) =>
      Effect.gen(function* () {
        const real = yield* realPath(path);
        if (!real || real !== path) return false;
        const info = yield* Effect.option(fs.stat(real));
        if (Option.isNone(info) || info.value.type !== 'Directory') return false;
        const root = identities.find((identity) => isInside(identity.root, real));
        return !!root && (yield* unchanged(root));
      });
    return {
      has,
      refusal: 'outside-roots',
      approve: (path) =>
        Effect.gen(function* () {
          const real = yield* Effect.mapError(fs.realPath(path), () => new FolderMissingError());
          if (!(yield* has(real)))
            return yield* new FolderRefusedError({ refusal: 'outside-roots' });
          return real;
        }),
      touch: () => Effect.void,
      listRecent: () => Effect.succeed([]),
      /** The roots, then the folders directly inside each, sorted; hidden folders and links are left out. */
      listFolders: () =>
        Effect.gen(function* () {
          const listed: string[] = [],
            children: string[] = [];
          for (const identity of identities) {
            if (!(yield* unchanged(identity))) continue;
            listed.push(identity.root);
            // A root that can't be read lists only itself.
            const entries = yield* Effect.orElseSucceed(
              fs.readDirectoryEntries(identity.root),
              () => [],
            );
            children.push(
              ...entries
                .filter((entry) => entry.type === 'Directory' && !entry.name.startsWith('.'))
                .map((entry) => entry.name)
                .sort((a, b) => a.localeCompare(b))
                .map((name) => join(identity.root, name)),
            );
          }
          return [...listed, ...children].slice(0, maximumHostFolders);
        }),
    } satisfies FolderApprovals;
  });
