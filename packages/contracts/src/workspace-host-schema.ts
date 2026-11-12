import * as Schema from 'effect/Schema';
import { ApplicationError } from './errors.ts';
import type { HostCommand, HostInput, HostOutput } from './workspace-host.ts';
import { array, optional, struct, voidResult } from './schema.ts';
import {
  CheckoutTargetSchema,
  FileDocumentSchema,
  GitCheckoutTargetSchema,
  OperationItemSchema,
  OperationKindSchema,
  OperationOutcomeSchema,
  WorkspaceIdentifierSchema,
  WorkspaceOperationSchema,
  workspaceInputSchemas,
  workspaceOutputSchemas,
} from './workspace-schema.ts';

const natural = Schema.Int.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);
/** The most feed entries one `listOperations` page carries. */
export const maximumOperationFeedPage = 64;
/** Names the installation whose clients' requests the host journals; one per client store. */
const installationId = WorkspaceIdentifierSchema;

/** A save outcome as the file host reports it: the host publishes no recovery. */
export const HostSaveResultSchema = Schema.Union([
  struct({
    kind: Schema.Literal('saved'),
    disk: FileDocumentSchema,
    persistencePending: optional(Schema.Boolean),
    message: optional(Schema.String),
  }),
  struct({ kind: Schema.Literal('conflict'), disk: FileDocumentSchema }),
]);
export const HostOperationResultSchema = struct({
  id: WorkspaceIdentifierSchema,
  clientId: WorkspaceIdentifierSchema,
  checkout: CheckoutTargetSchema,
  kind: OperationKindSchema,
  outcome: OperationOutcomeSchema,
  items: array(OperationItemSchema),
  message: optional(Schema.String),
});
/**
 * What the journal knows of a save: `not-started` means the host never admitted the request;
 * `uncertain` means it did but disk evidence cannot say what happened.
 */
export const SaveStatusSchema = Schema.Union([
  struct({ kind: Schema.Literal('saved'), disk: FileDocumentSchema }),
  struct({ kind: Schema.Literal('conflict'), disk: FileDocumentSchema }),
  struct({ kind: Schema.Literal('not-started') }),
  struct({ kind: Schema.Literal('uncertain'), message: optional(Schema.String) }),
]);
/** The completed items a move, copy or Trash added to the feed at `sequence`. */
export const OperationFeedEntrySchema = struct({
  sequence: natural,
  installationId,
  clientId: WorkspaceIdentifierSchema,
  id: WorkspaceIdentifierSchema,
  checkout: CheckoutTargetSchema,
  kind: OperationKindSchema,
  items: array(OperationItemSchema),
});
/**
 * Every entry for the checkout after the requested sequence up to `through` is in `operations`;
 * `more` says the page ended early. Entries up to `floor` may have been discarded.
 */
export const OperationFeedSchema = struct({
  operations: array(OperationFeedEntrySchema).check(Schema.isMaxLength(maximumOperationFeedPage)),
  through: natural,
  floor: natural,
  more: Schema.Boolean,
});

export const hostInputSchemas = {
  openCheckout: workspaceInputSchemas.openCheckout,
  verifyCheckout: struct({ checkout: CheckoutTargetSchema }),
  readFile: workspaceInputSchemas.readFile,
  saveFile: struct({ installationId, ...workspaceInputSchemas.saveFile.fields }),
  listDirectory: workspaceInputSchemas.listDirectory,
  getIgnoredPaths: workspaceInputSchemas.getIgnoredPaths,
  gitStatus: workspaceInputSchemas.gitStatus,
  listWorktrees: workspaceInputSchemas.listWorktrees,
  createWorktree: struct({
    installationId,
    requestId: WorkspaceIdentifierSchema,
    ...workspaceInputSchemas.createWorktree.fields,
  }),
  initializeRepository: struct({
    installationId,
    requestId: WorkspaceIdentifierSchema,
    ...workspaceInputSchemas.initializeRepository.fields,
  }),
  readComparison: workspaceInputSchemas.readComparison,
  lookupFiles: workspaceInputSchemas.lookupFiles,
  searchText: workspaceInputSchemas.searchText,
  inspectEntries: workspaceInputSchemas.inspectEntries,
  mutate: struct({ installationId, ...WorkspaceOperationSchema.fields }),
  operationStatus: struct({
    installationId,
    clientId: WorkspaceIdentifierSchema,
    id: WorkspaceIdentifierSchema,
  }),
  acknowledgeOperation: struct({
    installationId,
    clientId: WorkspaceIdentifierSchema,
    id: WorkspaceIdentifierSchema,
  }),
  saveStatus: struct({
    installationId,
    clientId: WorkspaceIdentifierSchema,
    requestId: WorkspaceIdentifierSchema,
  }),
  acknowledgeSave: struct({
    installationId,
    clientId: WorkspaceIdentifierSchema,
    requestId: WorkspaceIdentifierSchema,
  }),
  listOperations: struct({ checkout: CheckoutTargetSchema, after: Schema.NullOr(natural) }),
};
export const hostOutputSchemas = {
  openCheckout: workspaceOutputSchemas.openCheckout,
  verifyCheckout: voidResult,
  readFile: workspaceOutputSchemas.readFile,
  saveFile: HostSaveResultSchema,
  listDirectory: workspaceOutputSchemas.listDirectory,
  getIgnoredPaths: workspaceOutputSchemas.getIgnoredPaths,
  gitStatus: workspaceOutputSchemas.gitStatus,
  listWorktrees: workspaceOutputSchemas.listWorktrees,
  createWorktree: CheckoutTargetSchema,
  initializeRepository: GitCheckoutTargetSchema,
  readComparison: workspaceOutputSchemas.readComparison,
  lookupFiles: workspaceOutputSchemas.lookupFiles,
  searchText: workspaceOutputSchemas.searchText,
  inspectEntries: workspaceOutputSchemas.inspectEntries,
  mutate: HostOperationResultSchema,
  operationStatus: Schema.NullOr(HostOperationResultSchema),
  acknowledgeOperation: voidResult,
  saveStatus: SaveStatusSchema,
  acknowledgeSave: voidResult,
  listOperations: OperationFeedSchema,
} satisfies Record<keyof typeof hostInputSchemas, Schema.Constraint>;

const inputs = Object.fromEntries(
  Object.entries(hostInputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema, { onExcessProperty: 'error', reportInput: false }),
  ]),
);
const outputs = Object.fromEntries(
  Object.entries(hostOutputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema, { reportInput: false }),
  ]),
);
export const isHostCommand = (value: unknown): value is HostCommand =>
  typeof value === 'string' && Object.hasOwn(hostInputSchemas, value);
export function decodeHostInput<K extends HostCommand>(operation: K, value: unknown): HostInput<K> {
  try {
    if (!isHostCommand(operation)) throw Error();
    return inputs[operation](value) as HostInput<K>;
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid workspace input.' });
  }
}
export function decodeHostOutput<K extends HostCommand>(
  operation: K,
  value: unknown,
): HostOutput<K> {
  try {
    if (!isHostCommand(operation)) throw Error();
    return outputs[operation](value) as HostOutput<K>;
  } catch {
    throw new ApplicationError({ code: 'Incompatible', message: 'Invalid workspace reply.' });
  }
}
