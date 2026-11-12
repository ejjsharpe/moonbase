import { Schema, Struct } from 'effect';
import { isAbsolute } from 'node:path';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { hash } from './validation.ts';
import {
  CheckoutTargetSchema,
  FileDocumentSchema,
  WorkspaceIdentifierSchema,
} from '@moonbase/contracts/workspace-schema';
import {
  HostOperationResultSchema,
  HostSaveResultSchema,
  OperationFeedEntrySchema,
  hostInputSchemas,
} from '@moonbase/contracts/workspace-host-schema';

export const struct = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));
export const array = <S extends Schema.Constraint>(schema: S) =>
  Schema.mutable(Schema.Array(schema));
export const optional = Schema.optional;
export const natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const absolute = Schema.String.check(
  Schema.makeFilter((s) => isAbsolute(s) && !s.includes('\0')),
);
export const storedDocument = FileDocumentSchema.check(
  Schema.makeFilter((document) => hash(document.text) === document.version),
);
export const strictDecoders = (schemas: Record<string, Schema.Decoder<unknown>>) =>
  Object.fromEntries(
    Object.entries(schemas).map(([bucket, schema]) => [
      bucket,
      Schema.decodeUnknownSync(schema, { onExcessProperty: 'error', reportInput: false }),
    ]),
  );

export const WorkspaceConfigurationSchema = struct({
  dataDirectory: absolute,
  hostId: WorkspaceIdentifierSchema,
  filesystemHelper: optional(absolute),
  gitExecutable: optional(absolute),
  ripgrepExecutable: optional(absolute),
  /**
   * Paths no checkout root, worktree location or import source may hold or sit inside, such as a
   * daemon's token and credentials. Each is compared by real path, whether or not it exists yet.
   */
  reserved: optional(array(absolute)),
  /** How long an acknowledged journal entry stays before it is discarded. */
  journalRetentionMs: optional(natural),
  /**
   * Whether the host accepts approved native files as imports (default true). A host-mode daemon
   * turns them off: a native source is not held to the root policy, so only a local one may.
   */
  nativeImports: optional(Schema.Boolean),
});
export type WorkspaceConfiguration = typeof WorkspaceConfigurationSchema.Type;
/**
 * Whether the host may open `real` as a checkout root. `requested` is the path as the client named
 * it, so a predicate can refuse one reached through a link. Called on open, before a worktree is
 * made (with its parent folder, as the location doesn't exist yet) and on every later use of the
 * checkout; a refusal or a throw denies.
 */
export type RootPredicate = (real: string, requested: string) => boolean | Promise<boolean>;
/**
 * A chat's own folder, as the daemon's chats know it, for `turnChatIntoProject`. The host cannot
 * import the chat engine, so the daemon supplies this; without it the operation is `Incompatible`.
 */
export type ChatFolders = {
  /** The chat's working folder; refuses any folder but one the daemon made for a chat. */
  findOwnFolder(target: ChatTarget): Promise<string>;
  /** Marks the chat's folder as a project. Repeating it changes nothing. */
  markAsProject(requestId: string, target: ChatTarget): Promise<void>;
};
export type WorkspaceHostConfiguration = WorkspaceConfiguration & {
  allowRoot?: RootPredicate;
  chats?: ChatFolders;
};
const configuration = Schema.decodeUnknownSync(WorkspaceConfigurationSchema, {
  reportInput: false,
});
export function decodeConfiguration(value: unknown) {
  try {
    return configuration(value);
  } catch {
    throw new ApplicationError({
      code: 'InvalidInput',
      message: 'Invalid workspace configuration.',
    });
  }
}
/** A plain-folder checkout's approval has no repository: `common` and `gitEntry` are null. */
export const ApprovalSchema = struct({
  target: CheckoutTargetSchema,
  identity: Schema.String,
  common: Schema.NullOr(struct({ path: absolute, identity: Schema.String })),
  gitEntry: Schema.NullOr(
    struct({ identity: Schema.String, pointer: Schema.NullOr(Schema.String) }),
  ),
});
/** A save the host admitted, until its client acknowledges it and the retention window passes. */
export const HostSaveRecordSchema = struct({
  input: hostInputSchemas.saveFile,
  started: Schema.Boolean,
  temporary: optional(Schema.String),
  baseline: optional(storedDocument),
  result: optional(
    HostSaveResultSchema.check(
      Schema.makeFilter((result) => hash(result.disk.text) === result.disk.version),
    ),
  ),
  message: optional(Schema.String),
  acknowledgedAt: optional(natural),
});
export const HostOperationRecordSchema = struct({
  input: hostInputSchemas.mutate,
  result: HostOperationResultSchema,
  /** Canonical forms of the completed items already added to the operation feed. */
  fed: optional(array(Schema.String)),
  acknowledgedAt: optional(natural),
});
/** The first outcome of a request that has no client acknowledgement, replayed for its ID. */
export const HostRequestRecordSchema = struct({
  input: Schema.Union([
    hostInputSchemas.createWorktree,
    hostInputSchemas.initializeRepository,
    hostInputSchemas.createChatWorktree,
    hostInputSchemas.turnChatIntoProject,
  ]),
  result: optional(CheckoutTargetSchema),
  error: optional(struct({ code: Schema.String, message: Schema.String })),
  settledAt: optional(natural),
});
export const FeedRecordSchema = struct({
  ...OperationFeedEntrySchema.fields,
  /** The journal key of the operation these items belong to. */
  operation: Schema.String,
});
export type Approval = typeof ApprovalSchema.Type;
export type HostSaveRecord = typeof HostSaveRecordSchema.Type;
export type HostOperationRecord = typeof HostOperationRecordSchema.Type;
export type HostRequestRecord = typeof HostRequestRecordSchema.Type;
export type FeedRecord = typeof FeedRecordSchema.Type;
export const hostDecoders = strictDecoders({
  approvals: ApprovalSchema,
  saves: HostSaveRecordSchema,
  operations: HostOperationRecordSchema,
  requests: HostRequestRecordSchema,
  feed: FeedRecordSchema,
  counters: natural,
  cancelled: natural,
  meta: WorkspaceIdentifierSchema,
});
