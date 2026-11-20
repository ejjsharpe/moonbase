import * as Schema from 'effect/Schema';
import type { ErrorGroup } from './error-groups.ts';

// What provider setup and the encrypted credentials under it fail with (epic #273 D14).

const refusals = {
  'claude-code-sign-in':
    'Claude Code manages this sign-in. Run `claude auth login` or `claude auth logout` in a terminal, then refresh providers.',
  'unknown-provider': 'Choose an installed provider.',
  'sign-in-superseded': 'This sign-in request was superseded.',
  'sign-in-inactive': 'This sign-in flow is no longer active.',
  'owner-released': 'The owning document was released.',
  'no-sign-in-url': 'There is no active sign-in URL.',
  'unsupported-sign-in-url': 'The provider supplied an unsupported sign-in URL.',
  'prompt-obsolete': 'This setup prompt is obsolete.',
  'invalid-answer': 'Enter a valid answer for the active prompt.',
} as const;
/** Provider setup refused the request before changing anything. */
export class ProviderSetupRefusedError extends Schema.TaggedError<ProviderSetupRefusedError>()(
  'ProviderSetupRefusedError',
  { reason: Schema.Literals(Object.keys(refusals) as (keyof typeof refusals)[]) },
) {
  get group(): ErrorGroup {
    return 'refusal';
  }
  override get message() {
    return refusals[this.reason];
  }
}

const unavailable = {
  setup:
    'Provider setup or encrypted credential storage is unavailable. Existing credentials were retained; retry setup or sign in again.',
  'client-opens-links': 'Open provider sign-in links from a Moonbase client.',
  browser: 'The provider sign-in page could not be opened.',
  'invalid-link': 'The provider sign-in link is invalid.',
} as const;
/** Provider setup could not do the work: it failed, or the sign-in page can't be opened here. */
export class ProviderSetupUnavailableError extends Schema.TaggedError<ProviderSetupUnavailableError>()(
  'ProviderSetupUnavailableError',
  { reason: Schema.Literals(Object.keys(unavailable) as (keyof typeof unavailable)[]) },
) {
  get group(): ErrorGroup {
    return 'unavailable';
  }
  override get message() {
    return unavailable[this.reason];
  }
}

const keyFileGuidance = 'Configure a private credential key file for this host instead.';
const keyProblems = {
  'key-size': 'A credential key is 32 bytes.',
  'no-key-store': `The credential key store is unavailable on this system. ${keyFileGuidance}`,
  'file-not-private':
    'The credential key file must be a regular file owned by you with mode 0600, not a symlink, in a folder only you can change.',
  'file-not-key':
    'The credential key file is not a Moonbase key. Restore the original key file, or remove it and sign in to your providers again.',
  'file-folder-missing':
    "The credential key file's folder doesn't exist. Create it, private to you, or choose another path.",
  'file-unreadable': 'The credential key file could not be read.',
  'file-not-created': 'The credential key file could not be created.',
  'store-id': 'The credential store id is invalid.',
  'keychain-path':
    'The keychain path must be absolute and contain no quotes or control characters.',
  'keychain-path-length': 'The keychain path is too long.',
  'keychain-missing': `The macOS keychain isn't available on this system. ${keyFileGuidance}`,
  'keychain-locked':
    "The macOS keychain is locked and can't be unlocked without a desktop session, so provider credentials can't be read or saved. Unlock it, or configure a private credential key file for this host instead.",
  'keychain-failed': '',
  'keychain-not-key':
    'The keychain item for the credential key is not a Moonbase key. Restore the original item, or delete it in Keychain Access and sign in to your providers again.',
} as const;
/**
 * The key that encrypts provider credentials can't be loaded or created, for `problem`. A failed
 * `security` command names its exit `status` (none when it stopped).
 */
export class CredentialKeyError extends Schema.TaggedError<CredentialKeyError>()(
  'CredentialKeyError',
  {
    problem: Schema.Literals(Object.keys(keyProblems) as (keyof typeof keyProblems)[]),
    status: Schema.optional(Schema.Int),
  },
) {
  get group(): ErrorGroup {
    return 'unavailable';
  }
  override get message() {
    if (this.problem !== 'keychain-failed') return keyProblems[this.problem];
    const security = this.status === undefined ? 'stopped' : `exited with status ${this.status}`;
    return `The macOS keychain couldn't read or save the credential key (security ${security}). ${keyFileGuidance}`;
  }
}

const storeProblems = {
  failed:
    'Encrypted provider credentials could not be read or saved. Existing files were kept. Check that the credentials folder and its files are private to you, then retry.',
  unreadable:
    "A saved provider credential can't be read with the current credential key. Sign in to that provider again to replace it, or sign out to remove it.",
} as const;
/** An encrypted credential file could not be read or saved; existing files were kept. */
export class CredentialStoreError extends Schema.TaggedError<CredentialStoreError>()(
  'CredentialStoreError',
  { problem: Schema.Literals(Object.keys(storeProblems) as (keyof typeof storeProblems)[]) },
) {
  get group(): ErrorGroup {
    return 'storage';
  }
  override get message() {
    return storeProblems[this.problem];
  }
}

/** The error classes provider setup fails with. */
export const providerSetupErrors = [
  ProviderSetupRefusedError,
  ProviderSetupUnavailableError,
  CredentialKeyError,
  CredentialStoreError,
] as const;
/** Every way provider setup fails on its host. */
export type ProviderSetupError = InstanceType<(typeof providerSetupErrors)[number]>;
/** Whether `value` is one of provider setup's errors. */
export const isProviderSetupError: (value: unknown) => value is ProviderSetupError = Schema.is(
  Schema.Union(providerSetupErrors),
);
