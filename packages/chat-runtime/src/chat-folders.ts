import { randomBytes } from 'node:crypto';
import { rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Effect, FileSystem, Option } from 'effect';
import { ChatUnavailableError } from '@moonbase/contracts/chat-errors';
import { FolderRefusedError } from '@moonbase/contracts/folder-errors';
import { checkCanonicalFolder } from './canonical-folder.ts';

const slugLength = 40;

/** `2026-11-08-tidy-the-composer-a1b2c3d4`: the local date, the title's first words and a short id. */
function nameChatFolder(title: string, date: Date) {
  const id = randomBytes(4).toString('hex');
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
  const words = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 6);
  let slug = '';
  for (const word of words) {
    if (!slug) slug = word.slice(0, slugLength);
    else if (slug.length + 1 + word.length <= slugLength) slug += `-${word}`;
    else break;
  }
  return [day, slug, id].filter(Boolean).join('-');
}

/** Whether Git would count `folder` as part of a checkout: it or a folder above it has `.git`. */
const isInsideGitCheckout = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (let current = folder; ; current = dirname(current)) {
      if (Option.isSome(yield* Effect.option(fs.lstat(join(current, '.git'))))) return true;
      if (dirname(current) === current) return false;
    }
  });

/**
 * A new, empty, private folder under `parent` for a chat without a project, named for `title` and
 * the local day of `now`.
 * Refused inside a Git checkout, where the agent's Git commands would act on that repository.
 */
export const makeChatFolder = (parent: string, title: string, now: Date) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (yield* isInsideGitCheckout(parent))
      return yield* new ChatUnavailableError({ reason: 'own-folder-in-checkout' });
    return yield* Effect.gen(function* () {
      yield* fs.makeDirectory(parent, { recursive: true, mode: 0o700 });
      // The random suffix makes a taken name a failure to report, not one to retry.
      const folder = join(parent, nameChatFolder(title, now));
      yield* fs.makeDirectory(folder, { mode: 0o700 });
      return yield* fs.realPath(folder);
    }).pipe(Effect.mapError(() => new ChatUnavailableError({ reason: 'own-folder-failed' })));
  });

/**
 * Removes a folder made by `makeChatFolder` for a request that made no chat. It is still empty, so
 * a folder that is not is left alone.
 */
export const removeEmptyChatFolder = (folder: string) =>
  Effect.ignore(Effect.tryPromise(() => rmdir(folder)));

/**
 * Refuses any folder but one the runtime made directly under `chatFolders` for a chat without a
 * project, named by its real path.
 */
export const checkChatFolder = (chatFolders: string, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* Effect.option(fs.realPath(chatFolders));
    if (
      Option.isNone(parent) ||
      dirname(path) !== parent.value ||
      (yield* checkCanonicalFolder(path)) !== 'canonical'
    )
      return yield* new FolderRefusedError({ refusal: 'not-chat-folder' });
  });
