import type { CommandOptions } from '../shared/common.ts';
import { type ApplicationErrorCode, ApplicationError } from '../errors/schema.ts';
import * as Schema from 'effect/Schema';
import { array, optional, struct, voidResult } from '../shared/schema.ts';
import {
  ChatHostTargetSchema,
  ChatIdentifierSchema,
  chatHostCapabilities,
  type ChatHostCapability,
} from '../host/schema.ts';
import { ChatTargetSchema } from '../chat/schema.ts';
import {
  ProviderSignInUrlSchema,
  ProviderStateSchema,
  providerInputSchemas,
} from '../providers/schema.ts';

/** A daemon's folder and control operations. */
export type LocalHostCommand = keyof typeof localHostInputSchemas;
export type LocalHostInput<K extends LocalHostCommand> = (typeof localHostInputSchemas)[K]['Type'];
export type LocalHostOutput<K extends LocalHostCommand> =
  (typeof localHostOutputSchemas)[K]['Type'];
/** Provider setup as a host serves it: each operation names its host and owner. */
export type HostProviderCommand = keyof typeof hostProviderInputSchemas;
/** Every operation a local-mode daemon serves beyond `ChatCommand`. */
export type DaemonCommand = LocalHostCommand | HostProviderCommand;
export type DaemonInput<K extends DaemonCommand> = (typeof daemonInputSchemas)[K]['Type'];
export type DaemonOutput<K extends DaemonCommand> = (typeof daemonOutputSchemas)[K]['Type'];
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

/** An absolute path: at most 4 KiB of well-formed text without NULs. */
export const AbsolutePathSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.startsWith('/') &&
      !/[\ud800-\udfff]/u.test(value) &&
      !value.includes('\0') &&
      new TextEncoder().encode(value).length <= 4096,
  ),
);
/** How many recent folders a host lists. */
export const maximumRecentFolders = 8;
/** How many folders a host-mode daemon lists from its approved roots. */
export const maximumHostFolders = 256;

/** A local-mode daemon's folder approvals and control. */
export const localHostInputSchemas = {
  /** Approves a folder the client's native picker or editor chose; `recent: false` keeps it unlisted. */
  approveFolder: struct({
    host: ChatHostTargetSchema,
    requestId: ChatIdentifierSchema,
    path: AbsolutePathSchema,
    recent: optional(Schema.Boolean),
  }),
  listRecentFolders: struct({ host: ChatHostTargetSchema }),
  /** Refuses any folder but one the daemon made for a chat without a project. */
  checkChatFolder: struct({ host: ChatHostTargetSchema, path: AbsolutePathSchema }),
  /** Refuses a folder that is not approved, or no longer the directory approved. */
  checkApprovedFolder: struct({ host: ChatHostTargetSchema, path: AbsolutePathSchema }),
  getActiveWork: struct({ host: ChatHostTargetSchema }),
  markFolderAsProject: struct({ requestId: ChatIdentifierSchema, target: ChatTargetSchema }),
  /** A host-mode daemon's approved roots, then their subfolders, for a client with no picker. */
  listHostFolders: struct({ host: ChatHostTargetSchema }),
};
export const localHostOutputSchemas = {
  approveFolder: struct({ requestId: ChatIdentifierSchema, path: AbsolutePathSchema }),
  listRecentFolders: struct({
    folders: array(AbsolutePathSchema).check(Schema.isMaxLength(maximumRecentFolders)),
  }),
  checkChatFolder: voidResult,
  checkApprovedFolder: voidResult,
  getActiveWork: struct({ active: Schema.Boolean }),
  markFolderAsProject: struct({ requestId: ChatIdentifierSchema }),
  listHostFolders: struct({
    folders: array(AbsolutePathSchema).check(Schema.isMaxLength(maximumHostFolders)),
  }),
} satisfies Record<keyof typeof localHostInputSchemas, Schema.Constraint>;

/** Provider setup on the wire: each operation names its host and the client's owner. */
const owned = { host: ChatHostTargetSchema, ownerId: ChatIdentifierSchema };
const mutation = { ...owned, requestId: ChatIdentifierSchema };
export const hostProviderInputSchemas = {
  getProviders: struct(owned),
  startProviderLogin: struct({ ...mutation, ...providerInputSchemas.startProviderLogin.fields }),
  answerProviderPrompt: struct({
    ...mutation,
    ...providerInputSchemas.answerProviderPrompt.fields,
  }),
  cancelProviderLogin: struct({ ...mutation, ...providerInputSchemas.cancelProviderLogin.fields }),
  /** Returns the validated sign-in URL for the client to open; the host never opens a browser. */
  openProviderUrl: struct({ ...owned, ...providerInputSchemas.openProviderUrl.fields }),
  logoutProvider: struct({ ...mutation, ...providerInputSchemas.logoutProvider.fields }),
  releaseProviderOwner: struct(owned),
};
const state = { state: ProviderStateSchema };
const receipt = struct({ requestId: ChatIdentifierSchema, ...state });
export const hostProviderOutputSchemas = {
  getProviders: struct(state),
  startProviderLogin: receipt,
  answerProviderPrompt: receipt,
  cancelProviderLogin: receipt,
  openProviderUrl: struct({ ...state, url: ProviderSignInUrlSchema }),
  logoutProvider: receipt,
  releaseProviderOwner: voidResult,
} satisfies Record<keyof typeof hostProviderInputSchemas, Schema.Constraint>;

export const daemonInputSchemas = { ...localHostInputSchemas, ...hostProviderInputSchemas };
export const daemonOutputSchemas = { ...localHostOutputSchemas, ...hostProviderOutputSchemas };

/** The capability a host must advertise in its signed health to serve each operation. */
export const daemonCommandCapabilities: Record<DaemonCommand, ChatHostCapability> = {
  approveFolder: chatHostCapabilities.folders,
  listRecentFolders: chatHostCapabilities.folders,
  checkChatFolder: chatHostCapabilities.folders,
  checkApprovedFolder: chatHostCapabilities.folders,
  getActiveWork: chatHostCapabilities.local,
  markFolderAsProject: chatHostCapabilities.local,
  listHostFolders: chatHostCapabilities.roots,
  getProviders: chatHostCapabilities.providers,
  startProviderLogin: chatHostCapabilities.providers,
  answerProviderPrompt: chatHostCapabilities.providers,
  cancelProviderLogin: chatHostCapabilities.providers,
  openProviderUrl: chatHostCapabilities.providers,
  logoutProvider: chatHostCapabilities.providers,
  releaseProviderOwner: chatHostCapabilities.providers,
};
/** Operations that change state: they carry a request ID, and a lost reply is `Uncertain`. */
export const isDaemonMutation = (operation: DaemonCommand) =>
  operation === 'approveFolder' ||
  operation === 'markFolderAsProject' ||
  operation === 'startProviderLogin' ||
  operation === 'answerProviderPrompt' ||
  operation === 'cancelProviderLogin' ||
  operation === 'logoutProvider';

const inputs = Object.fromEntries(
  Object.entries(daemonInputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>, {
      onExcessProperty: 'error',
      reportInput: false,
    }),
  ]),
);
const outputs = Object.fromEntries(
  Object.entries(daemonOutputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>, {
      onExcessProperty: 'error',
      reportInput: false,
    }),
  ]),
);
export const isDaemonCommand = (value: unknown): value is DaemonCommand =>
  typeof value === 'string' && Object.hasOwn(daemonInputSchemas, value);
export const isLocalHostCommand = (value: unknown): value is LocalHostCommand =>
  typeof value === 'string' && Object.hasOwn(localHostInputSchemas, value);
export function decodeDaemonInput<K extends DaemonCommand>(
  operation: K,
  value: unknown,
): DaemonInput<K> {
  try {
    if (!isDaemonCommand(operation)) throw Error();
    return inputs[operation](value) as DaemonInput<K>;
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid daemon input.' });
  }
}
export function decodeDaemonOutput<K extends DaemonCommand>(
  operation: K,
  value: unknown,
): DaemonOutput<K> {
  try {
    if (!isDaemonCommand(operation)) throw Error();
    return outputs[operation](value) as DaemonOutput<K>;
  } catch {
    throw new ApplicationError({ code: 'Incompatible', message: 'Invalid daemon reply.' });
  }
}
export const decodeLocalHostInput: <K extends LocalHostCommand>(
  operation: K,
  value: unknown,
) => LocalHostInput<K> = decodeDaemonInput;
export const decodeLocalHostOutput: <K extends LocalHostCommand>(
  operation: K,
  value: unknown,
) => LocalHostOutput<K> = decodeDaemonOutput;
