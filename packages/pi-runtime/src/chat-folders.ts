import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as V from './validation.ts';

const slugLength = 40;

/** `2026-11-08-tidy-the-composer-a1b2c3d4`: the local date, the title's first words and a short id. */
export function nameChatFolder(
  title: string,
  date = new Date(),
  id = randomBytes(4).toString('hex'),
) {
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
async function isInsideGitCheckout(folder: string) {
  for (let current = folder; ; current = dirname(current)) {
    if (
      await lstat(join(current, '.git')).then(
        () => true,
        () => false,
      )
    )
      return true;
    if (dirname(current) === current) return false;
  }
}

/**
 * A new, empty, private folder under `parent` for a chat without a project, named for `title`.
 * Refused inside a Git checkout, where the agent's Git commands would act on that repository.
 */
export async function makeChatFolder(parent: string, title: string) {
  if (await isInsideGitCheckout(parent))
    V.fail(
      'Unavailable',
      'Chats without a project are unavailable while Moonbase’s data folder is inside a Git checkout. Choose a working folder.',
    );
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    for (let attempt = 1; ; attempt++) {
      const folder = join(parent, nameChatFolder(title));
      try {
        await mkdir(folder, { mode: 0o700 });
        return await realpath(folder);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 5) throw error;
      }
    }
  } catch {
    return V.fail('Unavailable', 'A folder for the new chat could not be made.');
  }
}
