import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ApplicationError } from '@moonbase/contracts/errors';

/** Holds the 256-bit key that encrypts provider credentials. */
export type CredentialKeySource = {
  /** Whether this source can work on this system at all. */
  available(): Promise<boolean>;
  /** The stored key, or `undefined` when none has been created. */
  load(): Promise<Uint8Array | undefined>;
  /** Stores a new random key unless one exists, and returns the stored key. Never overwrites. */
  create(): Promise<Uint8Array>;
};

const keyBytes = 32;
const encodedKey = /^[A-Za-z0-9+/]{43}=$/;
const unavailable = (message: string) => new ApplicationError({ code: 'Unavailable', message });
const keyFileGuidance = 'Configure a private credential key file for this host instead.';

function decodeKey(text: string): Uint8Array | undefined {
  return encodedKey.test(text) ? new Uint8Array(Buffer.from(text, 'base64')) : undefined;
}
function encodeKey(key: Uint8Array) {
  return Buffer.from(key).toString('base64');
}

/** A key held only in this process, for tests. */
export function createMemoryKeySource(initial?: Uint8Array): CredentialKeySource {
  if (initial && initial.byteLength !== keyBytes)
    throw unavailable('A credential key is 32 bytes.');
  let key = initial && new Uint8Array(initial);
  return {
    available: async () => true,
    load: async () => key && new Uint8Array(key),
    create: async () => new Uint8Array((key ??= new Uint8Array(randomBytes(keyBytes)))),
  };
}

/**
 * A key in an explicit file: base64 of 32 bytes and an optional newline, so
 * `openssl rand -base64 32 > key && chmod 600 key` makes one. The file must be a regular file owned
 * by the user with mode 0600 or stricter, not a symlink, in a directory nobody else can write to.
 */
export function createKeyFileSource(path: string): CredentialKeySource {
  const notPrivate = () =>
    unavailable(
      'The credential key file must be a regular file owned by you with mode 0600, not a symlink, in a folder only you can change.',
    );
  const notKey = () =>
    unavailable(
      'The credential key file is not a Moonbase key. Restore the original key file, or remove it and sign in to your providers again.',
    );
  // The uid checks need another owner, which only root can arrange, so tests cover modes and
  // symlinks; a root-owned folder such as a system directory is accepted.
  const checkFolder = async () => {
    const info = await stat(dirname(path)).catch(() => undefined);
    if (
      !info?.isDirectory() ||
      (info.uid !== process.getuid?.() && info.uid !== 0) ||
      info.mode & 0o022
    )
      throw notPrivate();
  };
  const load = async () => {
    if (!isAbsolute(path)) throw notPrivate();
    await checkFolder();
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw notPrivate();
      throw unavailable('The credential key file could not be read.');
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077)
        throw notPrivate();
      if (info.size > 128) throw notKey();
      const key = decodeKey((await file.readFile('utf8')).replace(/\n$/, ''));
      if (!key) throw notKey();
      return key;
    } finally {
      await file.close();
    }
  };
  return {
    available: async () => true,
    load,
    create: async () => {
      const existing = await load();
      if (existing) return existing;
      const temporary = join(dirname(path), '.' + randomUUID());
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(encodeKey(randomBytes(keyBytes)) + '\n');
          await file.sync();
        } finally {
          await file.close();
        }
        // link never replaces an existing file, so a key made concurrently wins and is read back.
        await link(temporary, path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
      } catch (error) {
        if (ApplicationError.is(error)) throw error;
        throw unavailable('The credential key file could not be created.');
      } finally {
        await unlink(temporary).catch(() => {});
      }
      const stored = await load();
      if (!stored) throw unavailable('The credential key file could not be created.');
      return stored;
    },
  };
}

type SpawnSecurity = (
  command: string,
  args: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;
export type KeychainKeySourceOptions = {
  /** The store this key belongs to; the item's account. */
  storeId: string;
  /** An explicit keychain file; otherwise the user's default keychain and search list. */
  keychain?: string;
  /** Replaces `node:child_process` spawn, for tests that observe or fake `/usr/bin/security`. */
  spawn?: SpawnSecurity;
  /** How long one `security` command may run, including any unlock prompt. */
  timeoutMs?: number;
};
const keychainService = 'Moonbase daemon credentials';
// `security -i` splits lines on whitespace and quotes, so only quote-free values reach a command.
const isQuotable = (value: string) =>
  [...value].every((character) => !'"\\\x7f'.includes(character) && character >= ' ');

/**
 * A generic-password item (service `Moonbase daemon credentials`, account `storeId`) read and
 * written by `/usr/bin/security -i`, with every command on its stdin so the key never reaches argv.
 */
export function createKeychainKeySource(options: KeychainKeySourceOptions): CredentialKeySource {
  const { storeId, keychain, spawn = spawnProcess as SpawnSecurity, timeoutMs = 120_000 } = options;
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(storeId))
    throw unavailable('The credential store id is invalid.');
  if (keychain !== undefined && (!isAbsolute(keychain) || !isQuotable(keychain)))
    throw unavailable(
      'The keychain path must be absolute and contain no quotes or control characters.',
    );
  const suffix = keychain === undefined ? '' : ` "${keychain}"`;
  const item = `-s "${keychainService}" -a "${storeId}"`;
  // `security -i` reads lines of under 4096 bytes; the add command, with a key, is the longest.
  if (Buffer.byteLength(`add-generic-password ${item} -w "${'A'.repeat(44)}"${suffix}`) >= 4096)
    throw unavailable('The keychain path is too long.');
  const failed = (status: number | null) =>
    status === 36
      ? unavailable(
          "The macOS keychain is locked and can't be unlocked without a desktop session, so provider credentials can't be read or saved. Unlock it, or configure a private credential key file for this host instead.",
        )
      : unavailable(
          `The macOS keychain couldn't read or save the credential key (security ${status === null ? 'stopped' : `exited with status ${status}`}). ${keyFileGuidance}`,
        );
  const run = (line: string) =>
    new Promise<{ status: number | null; output: string }>((resolve, reject) => {
      if (Buffer.byteLength(line) >= 4096) return reject(failed(null));
      let child;
      try {
        child = spawn('/usr/bin/security', ['-i'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
            ...(process.env.USER === undefined ? {} : { USER: process.env.USER }),
          },
        });
      } catch {
        return reject(failed(null));
      }
      let output = '',
        settled = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 4096) child.kill('SIGKILL');
      });
      // Diagnostics may name the keychain; they are drained and never surfaced.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => settle(() => reject(failed(null))));
      child.on('close', (status) =>
        settle(() => (output.length > 4096 ? reject(failed(null)) : resolve({ status, output }))),
      );
      child.stdin.end(line + '\n');
    });
  const available = async () =>
    process.platform === 'darwin' &&
    (await stat('/usr/bin/security').then(
      (info) => info.isFile(),
      () => false,
    ));
  const requireAvailable = async () => {
    if (!(await available()))
      throw unavailable(`The macOS keychain isn't available on this system. ${keyFileGuidance}`);
  };
  const load = async () => {
    await requireAvailable();
    const { status, output } = await run(`find-generic-password ${item} -w${suffix}`);
    if (status === 44) return undefined;
    if (status !== 0) throw failed(status);
    const key = decodeKey(output.replace(/\n$/, ''));
    if (!key)
      throw unavailable(
        'The keychain item for the credential key is not a Moonbase key. Restore the original item, or delete it in Keychain Access and sign in to your providers again.',
      );
    return key;
  };
  return {
    available,
    load,
    create: async () => {
      const existing = await load();
      if (existing) return existing;
      const { status } = await run(
        `add-generic-password ${item} -w "${encodeKey(randomBytes(keyBytes))}"${suffix}`,
      );
      // 45 is a duplicate item: another writer created the key first, so read theirs.
      if (status !== 0 && status !== 45) throw failed(status);
      const stored = await load();
      if (!stored) throw failed(status);
      return stored;
    },
  };
}
