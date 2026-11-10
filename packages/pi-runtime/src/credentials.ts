import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import * as Schema from 'effect/Schema';
import type { CreateModelsOptions } from '@earendil-works/pi-ai/models';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { CredentialKeySource } from './credential-keys.ts';

export {
  createKeyFileSource,
  createKeychainKeySource,
  createMemoryKeySource,
  type CredentialKeySource,
  type KeychainKeySourceOptions,
} from './credential-keys.ts';

type CredentialStore = NonNullable<CreateModelsOptions['credentials']>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore['read']>>>;
/** Encrypts one provider's credential file; `providerId` names the file it belongs to. */
export type CredentialEncryption = {
  available(): Promise<boolean>;
  encrypt(value: string, providerId: string): Promise<Uint8Array>;
  decrypt(value: Uint8Array, providerId: string): Promise<string>;
};
const failure = () =>
  new ApplicationError({
    code: 'Persistence',
    message:
      'Encrypted provider credentials could not be read or saved. Existing files were retained. Unlock your keychain and retry.',
  });
const credentialSchema = Schema.NullOr(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal('api_key'),
      key: Schema.String.check(Schema.makeFilter((value) => !!value.trim())),
    }),
    // OAuth providers own extension metadata such as clientId and scopes.
    Schema.StructWithRest(
      Schema.Struct({
        type: Schema.Literal('oauth'),
        access: Schema.NonEmptyString,
        refresh: Schema.NonEmptyString,
        expires: Schema.Finite,
      }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ),
  ]),
);
function decodeCredential(value: unknown): Credential | undefined {
  try {
    return (
      Schema.decodeUnknownSync(credentialSchema, {
        onExcessProperty: 'error',
        reportInput: false,
      })(value) ?? undefined
    );
  } catch {
    throw failure();
  }
}
async function protectStorage<A>(operation: () => Promise<A>): Promise<A> {
  try {
    return await operation();
  } catch (error) {
    // A key source that can't work says why, such as a locked keychain; nothing else is disclosed.
    if (ApplicationError.is(error) && error.code === 'Unavailable') throw error;
    throw failure();
  }
}
const sealVersion = 1,
  nonceBytes = 12,
  tagBytes = 16;
const getAssociatedData = (providerId: string) =>
  Buffer.from(`moonbase-credential-v${sealVersion}\0${providerId}`);
/**
 * AES-256-GCM under a key from `source`: `version | 96-bit random nonce | ciphertext | tag`, with
 * the version and provider id authenticated, so a file can't be moved to another provider. The
 * first write creates the key; a read never does.
 */
export function createKeyEncryption(source: CredentialKeySource): CredentialEncryption {
  // Sources never overwrite a stored key, so concurrent first writes all read back the same one.
  let cached: Uint8Array | undefined;
  const getKey = async (create: boolean) =>
    (cached ??= (await source.load()) ?? (create ? await source.create() : undefined));
  return {
    available: async () => {
      if (await source.available()) return true;
      throw new ApplicationError({
        code: 'Unavailable',
        message:
          'The credential key store is unavailable on this system. Configure a private credential key file for this host instead.',
      });
    },
    encrypt: async (value, providerId) => {
      const nonce = randomBytes(nonceBytes),
        cipher = createCipheriv('aes-256-gcm', (await getKey(true))!, nonce);
      cipher.setAAD(getAssociatedData(providerId));
      return Buffer.concat([
        Buffer.of(sealVersion),
        nonce,
        cipher.update(value, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
    decrypt: async (value, providerId) => {
      const data = Buffer.from(value);
      if (data.byteLength < 1 + nonceBytes + tagBytes || data[0] !== sealVersion) throw failure();
      const secret = await getKey(false);
      if (!secret) throw failure();
      const decipher = createDecipheriv('aes-256-gcm', secret, data.subarray(1, 1 + nonceBytes));
      decipher.setAAD(getAssociatedData(providerId));
      decipher.setAuthTag(data.subarray(-tagBytes));
      return Buffer.concat([
        decipher.update(data.subarray(1 + nonceBytes, -tagBytes)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
/** One private Moonbase namespace; the process root must hold its single-instance lock. */
export function createCredentialStore(
  directory: string,
  encryption: CredentialEncryption,
): CredentialStore {
  if (!isAbsolute(directory)) throw failure();
  const locks = new Map<string, Promise<unknown>>();
  const getCredentialPath = (providerId: string) => {
    if (!/^[a-z0-9-]{1,64}$/.test(providerId)) throw failure();
    return join(directory, providerId + '.encrypted');
  };
  const prepare = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw failure();
  };
  const read = (providerId: string): Promise<Credential | undefined> =>
    protectStorage(async () => {
      await prepare();
      let file;
      try {
        file = await open(getCredentialPath(providerId), constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          stat.mode & 0o077 ||
          stat.size > 128 * 1024
        )
          throw failure();
        if (!(await encryption.available())) throw failure();
        return decodeCredential(
          JSON.parse(await encryption.decrypt(await file.readFile(), providerId)),
        );
      } finally {
        await file.close();
      }
    });
  const write = (providerId: string, value: Credential | undefined) =>
    protectStorage(async () => {
      const plain = JSON.stringify(decodeCredential(value ?? null) ?? null);
      if (Buffer.byteLength(plain) > 64 * 1024) throw failure();
      if (!(await encryption.available())) throw failure();
      const encrypted = await encryption.encrypt(plain, providerId);
      if (encrypted.byteLength > 128 * 1024) throw failure();
      const temporary = join(directory, '.' + randomUUID());
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await file.writeFile(encrypted);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, getCredentialPath(providerId));
      } finally {
        await unlink(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
    });
  const runLocked = <A>(id: string, fn: () => Promise<A>, signal?: AbortSignal): Promise<A> => {
    getCredentialPath(id);
    const previous = locks.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        signal?.throwIfAborted();
        return fn();
      });
    locks.set(id, next);
    void next
      .finally(() => {
        if (locks.get(id) === next) locks.delete(id);
      })
      .catch(() => {});
    return next;
  };
  return {
    read: (id, options) => runLocked(id, () => read(id), options?.signal),
    list: async (options) => {
      const ids = ['openai', 'openai-api-key', 'anthropic', 'google', 'openrouter'];
      const values = await Promise.all(
        ids.map(async (providerId) => {
          const value = await runLocked(providerId, () => read(providerId), options?.signal);
          return value ? { providerId, type: value.type } : null;
        }),
      );
      return values.filter((value) => value !== null);
    },
    modify: (id, fn, options) =>
      runLocked(
        id,
        async () => {
          const current = await read(id);
          const next = await fn(current);
          if (next !== undefined) {
            options?.signal?.throwIfAborted();
            await write(id, next);
          }
          return next ?? current;
        },
        options?.signal,
      ),
    delete: (id, options) =>
      runLocked(
        id,
        async () => {
          await read(id);
          options?.signal?.throwIfAborted();
          await write(id, undefined);
        },
        options?.signal,
      ),
  };
}
