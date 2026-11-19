import * as Schema from 'effect/Schema';
import { InvalidRequestError } from './workspace-host-errors.ts';
import { ChatTargetSchema } from './chat-schema.ts';
import { AbsolutePathSchema } from './daemon-schema.ts';
import type { HostCommand, HostInput } from './workspace-host.ts';
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
/** The longest branch name a chat worktree may have. */
export const maximumBranchName = 100;
/** Names the installation whose clients' requests the host journals; one per client store. */
const installationId = WorkspaceIdentifierSchema;

/**
 * A save outcome as the file host reports it: the host publishes no recovery. A `saved` outcome
 * names only the version, as the text is the request's own.
 */
export const HostSaveResultSchema = Schema.Union([
  struct({
    kind: Schema.Literal('saved'),
    version: Schema.String,
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
 * What the journal knows of a save: `saved` names the version of the request's text,
 * `not-started` means the host never admitted the request and `uncertain` means it did but disk
 * evidence cannot say what happened.
 */
export const SaveStatusSchema = Schema.Union([
  struct({ kind: Schema.Literal('saved'), version: Schema.String }),
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
  /**
   * Makes a worktree for a chat beside the repository of the checkout at `root`, at
   * `<main worktree>-worktrees/<branch>`; the host derives the location.
   */
  createChatWorktree: struct({
    installationId,
    requestId: WorkspaceIdentifierSchema,
    root: AbsolutePathSchema,
    branch: Schema.String.check(Schema.isMaxLength(maximumBranchName)),
  }),
  /** Opens the folder the daemon made for a chat as a checkout, then marks the chat as in a project. */
  turnChatIntoProject: struct({
    installationId,
    requestId: WorkspaceIdentifierSchema,
    target: ChatTargetSchema,
  }),
  /** Local mode only: holds approved native files as single-use references for an import. */
  captureImports: struct({
    checkout: CheckoutTargetSchema,
    clientId: WorkspaceIdentifierSchema,
    paths: array(AbsolutePathSchema).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
  releaseImports: struct({
    checkout: CheckoutTargetSchema,
    clientId: WorkspaceIdentifierSchema,
    references: array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160))).check(
      Schema.isMaxLength(128),
      Schema.makeFilter((references) => new Set(references).size === references.length),
    ),
  }),
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
  createChatWorktree: CheckoutTargetSchema,
  turnChatIntoProject: CheckoutTargetSchema,
  captureImports: struct({ references: array(Schema.String) }),
  releaseImports: voidResult,
} satisfies Record<keyof typeof hostInputSchemas, Schema.Constraint>;

const inputs = Object.fromEntries(
  Object.entries(hostInputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema, { onExcessProperty: 'error', reportInput: false }),
  ]),
);
/** Decodes an operation's input, as a client does before sending it; refuses an invalid one. */
export function decodeHostInput<K extends HostCommand>(operation: K, value: unknown): HostInput<K> {
  try {
    return inputs[operation]!(value) as HostInput<K>;
  } catch {
    throw new InvalidRequestError({ problem: 'invalid-input' });
  }
}

/**
 * The checkout (or, for a chat, host) an operation's input names, if any: the daemon and its
 * clients check it is the host's own.
 */
export function hostInputCheckout(input: unknown): { hostId: string } | undefined {
  const shape = input as {
    checkout?: { hostId: string };
    target?: { checkout?: { hostId: string }; host?: { hostId: string } };
  };
  return shape.checkout ?? shape.target?.checkout ?? shape.target?.host;
}

/** A workspace watch follows one checkout. */
export const WorkspaceWatchTargetSchema = struct({ checkout: CheckoutTargetSchema });
/**
 * The watch of a checkout: `ready` once files are watched, `revision` rising with every change
 * seen and `failed` once the host's watch failed, which the client answers by watching again. A
 * client rereads after any update.
 */
export const WorkspaceWatchValueSchema = struct({
  ready: Schema.Boolean,
  revision: natural,
  failed: optional(Schema.Literal(true)),
});
