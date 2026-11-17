import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, type FileSystem } from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import type { FolderApprovals } from '@moonbase/contracts/daemon';
import { makeFolderApprovals } from '../src/folder-approvals.ts';
import { makeRootFolders } from '../src/root-folders.ts';

/** Runs `effect` on Bun's file system; a failure rejects with the error itself. */
export const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

/** A temporary folder, by its real path. */
export const temporaryFolder = async (prefix: string) =>
  realpath(await mkdtemp(join(tmpdir(), prefix)));

/** Folder approvals with each operation as a Promise. */
export const promised = (folders: FolderApprovals) => ({
  folders,
  refusal: folders.refusal,
  has: (path: string) => run(folders.has(path)),
  approve: (path: string, options?: { recent?: boolean }) => run(folders.approve(path, options)),
  touch: (path: string) => run(folders.touch(path)),
  listRecent: () => run(folders.listRecent()),
  listFolders: () => run(folders.listFolders!()),
});

export const createFolderApprovals = async (file: string) =>
  promised(await run(makeFolderApprovals(file)));
export const createRootFolders = async (
  roots: readonly string[],
  options?: { reserved?: readonly string[] },
) => promised(await run(makeRootFolders(roots, options)));
