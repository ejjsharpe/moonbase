import * as Schema from 'effect/Schema';
import { ApplicationError } from './errors.ts';
import { chatReplyErrorCodes } from './chat-schema.ts';
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
/** The most JSON bytes one page carries beyond its first entry, so a page fits a reply. */
export const maximumOperationFeedBytes = 4 * 1024 * 1024;
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
 * `more` says the page ended early. Entries of this checkout up to `floor` may have been
 * discarded. `epoch` names the host store: a different one means the sequences start over.
 */
export const OperationFeedSchema = struct({
  operations: array(OperationFeedEntrySchema).check(Schema.isMaxLength(maximumOperationFeedPage)),
  through: natural,
  floor: natural,
  epoch: WorkspaceIdentifierSchema,
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

/** Operations that change the host: a lost reply is `Uncertain` and is never sent again. */
const hostMutations: ReadonlySet<string> = new Set<HostCommand>([
  'saveFile',
  'mutate',
  'createWorktree',
  'initializeRepository',
  'acknowledgeOperation',
  'acknowledgeSave',
]);
export const isHostMutation = (operation: string) => hostMutations.has(operation);
/**
 * How long a client waits for a reply before it is lost: reads, lookup and search, mutations
 * (the helper's 30 s limit and a margin), and the Git steps of a worktree or `git init`. Past
 * it a mutation is `Uncertain`; `saveStatus` and `operationStatus` resolve it.
 */
export const hostDeadlinesMs = {
  read: 20_000,
  search: 30_000,
  mutation: 60_000,
  git: 120_000,
} as const;
export function hostDeadlineMs(operation: HostCommand): number {
  if (operation === 'lookupFiles' || operation === 'searchText') return hostDeadlinesMs.search;
  if (operation === 'createWorktree' || operation === 'initializeRepository')
    return hostDeadlinesMs.git;
  return isHostMutation(operation) ? hostDeadlinesMs.mutation : hostDeadlinesMs.read;
}
/** The checkout an operation's input names, if any; the server checks it is its own host's. */
export function hostInputCheckout(input: unknown): { hostId: string } | undefined {
  const shape = input as {
    checkout?: { hostId: string };
    target?: { checkout: { hostId: string } };
  };
  return shape.checkout ?? shape.target?.checkout;
}

/** A `workspace` subscription follows one checkout. */
export const WorkspaceWatchTargetSchema = struct({ checkout: CheckoutTargetSchema });
/**
 * The watch of a checkout: `ready` once files are watched, `revision` rising with every change
 * seen, `operations` the host's operation feed sequence and `error` a watch failure the client
 * should answer by watching again. A client rereads after any update.
 */
export const WorkspaceWatchValueSchema = struct({
  ready: Schema.Boolean,
  revision: natural,
  operations: natural,
  error: optional(Schema.Literals(chatReplyErrorCodes)),
});
