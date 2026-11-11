import type { CommandOptions } from './common.ts';
import type { ApplicationErrorCode } from './errors.ts';
import type * as Contracts from './daemon-schema.ts';

/** A daemon's folder and control operations. */
export type LocalHostCommand = keyof typeof Contracts.localHostInputSchemas;
export type LocalHostInput<K extends LocalHostCommand> =
  (typeof Contracts.localHostInputSchemas)[K]['Type'];
export type LocalHostOutput<K extends LocalHostCommand> =
  (typeof Contracts.localHostOutputSchemas)[K]['Type'];
/** Provider setup as a host serves it: each operation names its host and owner. */
export type HostProviderCommand = keyof typeof Contracts.hostProviderInputSchemas;
/** Every operation a local-mode daemon serves beyond `ChatCommand`. */
export type DaemonCommand = LocalHostCommand | HostProviderCommand;
export type DaemonInput<K extends DaemonCommand> = (typeof Contracts.daemonInputSchemas)[K]['Type'];
export type DaemonOutput<K extends DaemonCommand> =
  (typeof Contracts.daemonOutputSchemas)[K]['Type'];
/** Privileged: a host's daemon operations, bound to its process root. */
export interface DaemonClient {
  command<K extends DaemonCommand>(
    operation: K,
    input: DaemonInput<K>,
    options?: CommandOptions,
  ): Promise<DaemonOutput<K>>;
}

/** Which working folders a daemon's chats may use, and how a client chooses one. */
export type FolderApprovals = {
  /** Whether `path` is exactly a folder chats may use, still the directory it was. */
  has(path: string): Promise<boolean>;
  /** Approves a folder a client chose, returning its real path; refuses one chats may not use. */
  approve(path: string, options?: { recent?: boolean }): Promise<string>;
  /** Marks an approved folder as just used. */
  touch(path: string): Promise<void>;
  /** Recently used approved folders, newest first. */
  listRecent(): Promise<string[]>;
  /** The folders a client with no native picker chooses from; absent where it has one. */
  listFolders?(): Promise<string[]>;
  /** Why a folder chats may not use is refused. */
  refusal: DaemonErrorReason;
};

/**
 * Why a daemon operation was refused, when the user needs to know: each reason has one fixed
 * code and public message. A host names a reason in its signed error; a client shows the message
 * it holds for that reason, never text the host supplied.
 */
export const daemonErrorReasons = {
  'claude-code-sign-in': {
    code: 'InvalidInput',
    message:
      'Claude Code manages this sign-in. Run `claude auth login` or `claude auth logout` in a terminal, then refresh providers.',
  },
  'unknown-provider': { code: 'InvalidInput', message: 'Choose an installed provider.' },
  'sign-in-superseded': { code: 'InvalidInput', message: 'This sign-in request was superseded.' },
  'sign-in-inactive': { code: 'InvalidInput', message: 'This sign-in flow is no longer active.' },
  'owner-released': { code: 'InvalidInput', message: 'The owning document was released.' },
  'no-sign-in-url': { code: 'InvalidInput', message: 'There is no active sign-in URL.' },
  'unsupported-sign-in-url': {
    code: 'InvalidInput',
    message: 'The provider supplied an unsupported sign-in URL.',
  },
  'prompt-obsolete': { code: 'InvalidInput', message: 'This setup prompt is obsolete.' },
  'invalid-answer': {
    code: 'InvalidInput',
    message: 'Enter a valid answer for the active prompt.',
  },
  'provider-setup-unavailable': {
    code: 'Unavailable',
    message:
      'Provider setup or encrypted credential storage is unavailable. Existing credentials were retained; retry setup or sign in again.',
  },
  'folder-missing': { code: 'InvalidInput', message: 'Choose an existing folder.' },
  'not-chat-folder': {
    code: 'Unauthorized',
    message: 'This chat’s folder is not one Moonbase made for it.',
  },
  'folder-not-approved': {
    code: 'Unauthorized',
    message: 'Choose this working folder with the native picker first.',
  },
  'folder-outside-roots': {
    code: 'Unauthorized',
    message: 'Choose a folder in one of the host’s approved roots.',
  },
  'folders-unavailable': {
    code: 'Unavailable',
    message: 'Local folder approvals are unavailable.',
  },
} as const satisfies Record<string, { code: ApplicationErrorCode; message: string }>;
export type DaemonErrorReason = keyof typeof daemonErrorReasons;
/** The reason whose code and message an error carries exactly, if any. */
export function findDaemonErrorReason(error: {
  code: string;
  message: string;
}): DaemonErrorReason | undefined {
  return (Object.keys(daemonErrorReasons) as DaemonErrorReason[]).find(
    (reason) =>
      daemonErrorReasons[reason].code === error.code &&
      daemonErrorReasons[reason].message === error.message,
  );
}
/** A reason a signed error names for its code; undefined for any other value. */
export function readDaemonErrorReason(value: unknown, code: string): DaemonErrorReason | undefined {
  return typeof value === 'string' &&
    Object.hasOwn(daemonErrorReasons, value) &&
    daemonErrorReasons[value as DaemonErrorReason].code === code
    ? (value as DaemonErrorReason)
    : undefined;
}
