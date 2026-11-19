import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Cache, Duration, Effect, Exit, Schema } from 'effect';
import { CredentialKeyError, type CredentialStoreError } from '@moonbase/contracts/provider-errors';
import type { CredentialKeySource } from './credential-key-source.ts';

const unreadable = {
  'no-key': 'there is no key to open it',
  'not-sealed': 'it is not a sealed credential',
  'not-authentic': 'it does not open under this key and provider',
  'not-credential': 'it does not hold a credential',
} as const;
/**
 * A stored credential that will never open under this encryption, such as one sealed under another
 * key or with no key at all, so signing in again may replace it.
 */
export class UnreadableCredentialError extends Schema.TaggedError<UnreadableCredentialError>()(
  'UnreadableCredentialError',
  {
    providerId: Schema.String,
    reason: Schema.Literals(Object.keys(unreadable) as (keyof typeof unreadable)[]),
  },
) {
  override get message() {
    return `The ${this.providerId} credential is unreadable: ${unreadable[this.reason]}`;
  }
}
/** Why encrypting or decrypting failed; the store hides anything but a key problem. */
export type CredentialEncryptionError =
  | CredentialKeyError
  | CredentialStoreError
  | UnreadableCredentialError;
/** Encrypts one provider's credential file; `providerId` names the file it belongs to. */
export type CredentialEncryption = {
  readonly available: Effect.Effect<boolean, CredentialEncryptionError>;
  encrypt(value: string, providerId: string): Effect.Effect<Uint8Array, CredentialEncryptionError>;
  decrypt(value: Uint8Array, providerId: string): Effect.Effect<string, CredentialEncryptionError>;
};

const sealVersion = 1,
  nonceBytes = 12,
  tagBytes = 16;
const getAssociatedData = (providerId: string) =>
  Buffer.from(`moonbase-credential-v${sealVersion}\0${providerId}`);
/** Kept for good once it succeeded with a key; a failure or absence is asked again next time. */
const keepKey = (exit: Exit.Exit<Uint8Array | undefined, unknown>) =>
  Exit.isSuccess(exit) && exit.value ? Duration.infinity : Duration.zero;

/**
 * AES-256-GCM under a key from `source`: `version | 96-bit random nonce | ciphertext | tag`, with
 * the version and provider id authenticated, so a file can't be moved to another provider. The
 * first write creates the key; a read never does.
 */
export const makeKeyEncryption = (
  source: CredentialKeySource,
): Effect.Effect<CredentialEncryption> =>
  Effect.gen(function* () {
    // Concurrent callers share one in-flight load or create, so a first `list()` spawns one
    // `security` and shows at most one unlock prompt. A failure is forgotten so a later call can
    // retry once the keychain is unlocked, and absence is not kept because a write creates the key.
    const loaded = yield* Cache.makeWith(() => source.load, { capacity: 1, timeToLive: keepKey });
    const created = yield* Cache.makeWith(() => source.create, {
      capacity: 1,
      timeToLive: keepKey,
    });
    const getKey = (create: boolean) =>
      Effect.gen(function* () {
        const key = yield* Cache.get(loaded, 'key');
        if (key || !create) return key;
        const made = yield* Cache.get(created, 'key');
        yield* Cache.set(loaded, 'key', made);
        return made;
      });
    return {
      available: Effect.flatMap(source.available, (available) =>
        available
          ? Effect.succeed(true)
          : Effect.fail(new CredentialKeyError({ problem: 'no-key-store' })),
      ),
      encrypt: (value, providerId) =>
        Effect.map(getKey(true), (key) => {
          const nonce = randomBytes(nonceBytes),
            cipher = createCipheriv('aes-256-gcm', key!, nonce);
          cipher.setAAD(getAssociatedData(providerId));
          return Buffer.concat([
            Buffer.of(sealVersion),
            nonce,
            cipher.update(value, 'utf8'),
            cipher.final(),
            cipher.getAuthTag(),
          ]);
        }),
      // The key loads first, so a locked keychain is always `Unavailable`, never unreadable.
      decrypt: (value, providerId) =>
        Effect.flatMap(getKey(false), (secret) => {
          const data = Buffer.from(value);
          if (!secret)
            return Effect.fail(new UnreadableCredentialError({ providerId, reason: 'no-key' }));
          if (data.byteLength < 1 + nonceBytes + tagBytes || data[0] !== sealVersion)
            return Effect.fail(new UnreadableCredentialError({ providerId, reason: 'not-sealed' }));
          return Effect.try({
            try: () => {
              const decipher = createDecipheriv(
                'aes-256-gcm',
                secret,
                data.subarray(1, 1 + nonceBytes),
              );
              decipher.setAAD(getAssociatedData(providerId));
              decipher.setAuthTag(data.subarray(-tagBytes));
              return Buffer.concat([
                decipher.update(data.subarray(1 + nonceBytes, -tagBytes)),
                decipher.final(),
              ]).toString('utf8');
            },
            catch: () => new UnreadableCredentialError({ providerId, reason: 'not-authentic' }),
          });
        }),
    };
  });
