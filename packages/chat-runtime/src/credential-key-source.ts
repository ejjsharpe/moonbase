import { randomBytes } from 'node:crypto';
import { Effect } from 'effect';
import { CredentialKeyError } from '@moonbase/contracts/provider-errors';

/** Holds the 256-bit key that encrypts provider credentials. */
export type CredentialKeySource = {
  /** Whether this source can work on this system at all. */
  readonly available: Effect.Effect<boolean>;
  /** The stored key, or `undefined` when none has been created. */
  readonly load: Effect.Effect<Uint8Array | undefined, CredentialKeyError>;
  /** Stores a new random key unless one exists, and returns the stored key. Never overwrites. */
  readonly create: Effect.Effect<Uint8Array, CredentialKeyError>;
};

export const keyBytes = 32;
const encodedKey = /^[A-Za-z0-9+/]{43}=$/;
export const keyError = (problem: CredentialKeyError['problem']) =>
  new CredentialKeyError({ problem });

export function decodeKey(text: string): Uint8Array | undefined {
  return encodedKey.test(text) ? new Uint8Array(Buffer.from(text, 'base64')) : undefined;
}
export function encodeKey(key: Uint8Array) {
  return Buffer.from(key).toString('base64');
}
/** A new random key, base64 as the stores keep it. */
export const makeEncodedKey = () => encodeKey(randomBytes(keyBytes));

/** A key held only in this process, for tests. */
export function createMemoryKeySource(initial?: Uint8Array): CredentialKeySource {
  if (initial && initial.byteLength !== keyBytes) throw keyError('key-size');
  let key = initial && new Uint8Array(initial);
  return {
    available: Effect.succeed(true),
    load: Effect.sync(() => key && new Uint8Array(key)),
    create: Effect.sync(() => new Uint8Array((key ??= new Uint8Array(randomBytes(keyBytes))))),
  };
}
