import { randomBytes, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { ChatSession } from '@moonbase/contracts/chat';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import { decodeDaemonSettings, type DaemonSettings } from './daemon-settings.ts';
import { DaemonFailure } from './failure.ts';
import { isPrivateTo } from '@moonbase/contracts/files';

export const unsafe = () =>
  new DaemonFailure(
    'Persistence',
    'The daemon data directory or one of its files is not private to this user. Check its owner and permissions.',
  );
const malformed = () =>
  new DaemonFailure(
    'Persistence',
    'A daemon data file is malformed. Preserve the directory and check its files.',
  );

const isPrivate = (info: Stats) => isPrivateTo(info, process.getuid?.());

/** The data directory from the daemon's arguments, which must be exactly that one path. */
export function readDirectoryArgument(args: readonly string[]) {
  if (args.length > 1)
    throw new DaemonFailure(
      'InvalidInput',
      'The daemon takes one argument: the absolute path of its data directory.',
    );
  return args[0] ?? '';
}

/** Creates or validates one private directory: 0700, owned by this user, not a symlink. */
export async function openPrivateDirectory(path: string) {
  if (!isAbsolute(path))
    throw new DaemonFailure(
      'InvalidInput',
      'Supply the absolute path of the daemon data directory.',
    );
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw new DaemonFailure('Unavailable', 'The daemon data directory could not be created.');
  }
  const info = await lstat(path).catch(() => {
    throw unsafe();
  });
  if (!info.isDirectory() || info.isSymbolicLink() || !isPrivate(info)) throw unsafe();
  return path;
}

/**
 * Creates `path` as an empty 0600 file unless it exists, and checks it is a private regular file,
 * for files another library opens later and would otherwise create with the default mode.
 */
export async function preparePrivateFile(path: string) {
  let file;
  try {
    file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw unsafe();
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || !isPrivate(info)) throw unsafe();
  } finally {
    await file.close();
  }
}

/** Opens an existing private file without following a link, then checks what was opened. */
async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    // A symlink opened with O_NOFOLLOW fails with ELOOP (or EMLINK on some systems).
    throw unsafe();
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || !isPrivate(info)) throw unsafe();
    if (info.size > maxBytes) throw malformed();
    return await file.readFile();
  } finally {
    await file.close();
  }
}

/**
 * Writes a new 0600 file beside `path` and links it into place, so a crash never leaves a partial
 * file and an existing one is never replaced. Returns false when `path` already exists.
 */
async function createPrivateFile(path: string, contents: string) {
  const temporary = `${path}.${process.pid}.new`;
  await unlink(temporary).catch(() => {});
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
    await syncDirectory(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Replaces `path` atomically with a new 0600 file. */
export async function replacePrivateFile(path: string, contents: string) {
  const temporary = `${path}.${process.pid}.new`;
  await unlink(temporary).catch(() => {});
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await syncDirectory(path);
}

/** Makes the link or rename that put `path` in place durable, by syncing its folder. */
async function syncDirectory(path: string) {
  const folder = await open(dirname(path), constants.O_RDONLY);
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

/** Reads a private file, creating it once with `create()` when it does not exist. */
async function readOrCreate(path: string, maxBytes: number, create: () => string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await readPrivateFile(path, maxBytes);
    if (existing) return existing;
    try {
      await createPrivateFile(path, create());
    } catch {
      throw new DaemonFailure('Persistence', 'A daemon data file could not be created.');
    }
  }
  throw malformed();
}

function parse<A>(bytes: Buffer, decode: (value: unknown) => A): A {
  try {
    return decode(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)));
  } catch {
    throw malformed();
  }
}

/** `identity.json`: random host, store and actor IDs, created once. */
export async function readIdentity(directory: string): Promise<ChatSession> {
  const bytes = await readOrCreate(join(directory, 'identity.json'), 4096, () =>
    JSON.stringify({
      host: { hostId: randomUUID(), storeId: randomUUID() },
      actorId: randomUUID(),
    }),
  );
  return parse(bytes, (value) => decodeChatInput('listChats', { session: value }).session);
}

/** `token`: 32 random bytes, base64url; the whole authority of a client. */
export async function readToken(directory: string): Promise<string> {
  const bytes = await readOrCreate(join(directory, 'token'), 4096, () =>
    randomBytes(32).toString('base64url'),
  );
  const token = bytes.toString('utf8').trim();
  // At least 32 bytes of entropy as base64url, and within the host protocol's token bound.
  if (!/^[A-Za-z0-9_-]{43,4096}$/.test(token)) throw malformed();
  return token;
}

/** `daemon.json`: optional settings; a local-mode daemon when absent. */
export async function readSettings(directory: string): Promise<DaemonSettings> {
  const bytes = await readPrivateFile(join(directory, 'daemon.json'), 64 * 1024);
  if (!bytes) return { mode: 'local' };
  return parse(bytes, decodeDaemonSettings);
}

/** `build` identifies the daemon's code: its bundle's digest, or `development` from source. */
export type Endpoint = {
  port: number;
  pid: number;
  version: string;
  protocol: number;
  build: string;
};

/** `endpoint.json`, written atomically once the daemon listens. */
export const writeEndpoint = (directory: string, endpoint: Endpoint) =>
  replacePrivateFile(join(directory, 'endpoint.json'), JSON.stringify(endpoint));

export const removeEndpoint = (directory: string) =>
  unlink(join(directory, 'endpoint.json')).catch(() => {});
