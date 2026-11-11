import * as Schema from 'effect/Schema';
import { ApplicationError } from './errors.ts';
import { array, optional, struct, voidResult } from './schema.ts';
import { ChatHostTargetSchema, ChatIdentifierSchema } from './host-schema.ts';
import { ChatTargetSchema } from './chat-schema.ts';
import {
  ProviderSignInUrlSchema,
  ProviderStateSchema,
  providerInputSchemas,
} from './providers-schema.ts';
import { chatHostCapabilities, type ChatHostCapability } from './host.ts';
import type {
  DaemonCommand,
  DaemonInput,
  DaemonOutput,
  LocalHostCommand,
  LocalHostInput,
  LocalHostOutput,
} from './daemon.ts';

/** An absolute folder path: at most 4 KiB of well-formed text without NULs. */
export const FolderPathSchema = Schema.String.check(
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

/** A local-mode daemon's folder approvals and control. */
export const localHostInputSchemas = {
  /** Approves a folder the client's native picker or editor chose; `recent: false` keeps it unlisted. */
  approveFolder: struct({
    host: ChatHostTargetSchema,
    requestId: ChatIdentifierSchema,
    path: FolderPathSchema,
    recent: optional(Schema.Boolean),
  }),
  listRecentFolders: struct({ host: ChatHostTargetSchema }),
  /** Refuses any folder but one the daemon made for a chat without a project. */
  checkChatFolder: struct({ host: ChatHostTargetSchema, path: FolderPathSchema }),
  /** Refuses a folder that is not approved, or no longer the directory approved. */
  checkApprovedFolder: struct({ host: ChatHostTargetSchema, path: FolderPathSchema }),
  getActiveWork: struct({ host: ChatHostTargetSchema }),
  markFolderAsProject: struct({ requestId: ChatIdentifierSchema, target: ChatTargetSchema }),
};
export const localHostOutputSchemas = {
  approveFolder: struct({ requestId: ChatIdentifierSchema, path: FolderPathSchema }),
  listRecentFolders: struct({
    folders: array(FolderPathSchema).check(Schema.isMaxLength(maximumRecentFolders)),
  }),
  checkChatFolder: voidResult,
  checkApprovedFolder: voidResult,
  getActiveWork: struct({ active: Schema.Boolean }),
  markFolderAsProject: struct({ requestId: ChatIdentifierSchema }),
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
