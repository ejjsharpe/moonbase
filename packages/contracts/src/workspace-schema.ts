import * as Schema from 'effect/Schema';
import { ApplicationError, maximumFileBytes } from './workspace.ts';
import type { CommandInput, CommandOutput, WorkspaceCommand } from './workspace.ts';
import { array, optional, struct, voidResult } from './schema.ts';

export const WorkspaceIdentifierSchema = Schema.String.check(Schema.isPattern(/^[\w.-]{1,160}$/));
const string = Schema.String.check(Schema.isMaxLength(4096));
const path = string.check(Schema.makeFilter((value) => !value.includes('\0')));
const nonempty = string.check(Schema.isMinLength(1));
const natural = Schema.Int.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);
const coordinate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const text = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      !value.includes('\0') &&
      !/[\ud800-\udfff]/u.test(value) &&
      new TextEncoder().encode(value).length <= maximumFileBytes,
  ),
);
export const CheckoutTargetSchema = struct({
  hostId: nonempty,
  checkoutId: nonempty,
  projectId: nonempty,
  root: path.check(Schema.isMinLength(1)),
  branch: nonempty,
});
export const FileTargetSchema = struct({
  checkout: CheckoutTargetSchema,
  path: path.check(Schema.isMinLength(1)),
});
export const FileDocumentSchema = struct({ text, version: Schema.String });
export const FileViewSchema = Schema.Literals([
  'file',
  'staged',
  'unstaged',
  'untracked',
  'conflict',
]);
export const EditorPositionSchema = struct({
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  column: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  top: coordinate,
  left: coordinate,
});
const positions = struct({
  file: optional(EditorPositionSchema),
  staged: optional(EditorPositionSchema),
  unstaged: optional(EditorPositionSchema),
  untracked: optional(EditorPositionSchema),
  conflict: optional(EditorPositionSchema),
  'file:original': optional(EditorPositionSchema),
  'staged:original': optional(EditorPositionSchema),
  'unstaged:original': optional(EditorPositionSchema),
  'untracked:original': optional(EditorPositionSchema),
  'conflict:original': optional(EditorPositionSchema),
});
export const CheckoutViewSchema = struct({
  openFiles: array(path).check(Schema.isMaxLength(1000)),
  active: path,
  preview: Schema.NullOr(path),
  fileViews: Schema.Record(Schema.String, Schema.mutableKey(FileViewSchema)),
  positions: Schema.Record(Schema.String, Schema.mutableKey(positions)),
  tree: struct({
    expanded: array(path),
    selected: array(path),
    focus: path,
    scroll: coordinate,
    hideIgnored: Schema.Boolean,
  }),
});
export const RecoveryDraftSchema = struct({
  target: FileTargetSchema,
  text,
  disk: FileDocumentSchema,
});
export const EditorRecoverySchema = struct({
  version: Schema.Literal(1),
  clientId: WorkspaceIdentifierSchema,
  checkouts: array(CheckoutTargetSchema).check(Schema.isMaxLength(128)),
  openCheckoutIds: array(nonempty).check(Schema.isMaxLength(128)),
  selectedCheckoutId: Schema.NullOr(nonempty),
  views: Schema.Record(Schema.String, Schema.mutableKey(CheckoutViewSchema)),
  drafts: array(RecoveryDraftSchema).check(Schema.isMaxLength(512)),
  recentFiles: array(FileTargetSchema).check(Schema.isMaxLength(1000)),
  sidebarWidth: Schema.Finite.check(Schema.isBetween({ minimum: 100, maximum: 2000 })),
});
export const RecoveryChangeSchema = struct({
  clientId: WorkspaceIdentifierSchema,
  previousRevision: natural,
  revision: natural,
});
export const RecoveryPublicationSchema = struct({
  ...RecoveryChangeSchema.fields,
  requestId: WorkspaceIdentifierSchema,
});
export const EntryReferenceSchema = struct({
  target: FileTargetSchema,
  identity: Schema.String,
  directory: Schema.Boolean,
});
const kind = Schema.Literals([
  'create-file',
  'create-directory',
  'move',
  'copy',
  'trash',
  'import',
]);
const outcome = Schema.Literals(['completed', 'failed', 'uncertain']);
export const WorkspaceOperationSchema = struct({
  id: WorkspaceIdentifierSchema,
  clientId: WorkspaceIdentifierSchema,
  checkout: CheckoutTargetSchema,
  kind,
  sources: array(EntryReferenceSchema).check(Schema.isMaxLength(128)),
  destination: optional(path),
  text: optional(text),
  replacements: optional(array(EntryReferenceSchema)),
  nativeReferences: optional(array(Schema.String).check(Schema.isMaxLength(128))),
});
export const OperationResultSchema = struct({
  id: WorkspaceIdentifierSchema,
  clientId: WorkspaceIdentifierSchema,
  checkout: CheckoutTargetSchema,
  kind,
  recoveryChanges: array(RecoveryChangeSchema),
  outcome,
  items: array(
    struct({
      source: Schema.String,
      destination: optional(Schema.String),
      outcome,
      message: optional(Schema.String),
    }),
  ),
  message: optional(Schema.String),
});
export const RecoveryLoadSchema = struct({
  revision: natural,
  state: EditorRecoverySchema,
  errors: array(Schema.String),
  operations: array(OperationResultSchema),
});
export const SaveResultSchema = Schema.Union([
  struct({
    kind: Schema.Literal('saved'),
    disk: FileDocumentSchema,
    recoveryChanges: array(RecoveryChangeSchema),
    persistencePending: optional(Schema.Boolean),
    message: optional(Schema.String),
  }),
  struct({ kind: Schema.Literal('conflict'), disk: FileDocumentSchema }),
]);
export const DirectoryEntrySchema = struct({
  path,
  directory: Schema.Boolean,
  ignored: optional(Schema.Boolean),
});
export const DirectoryListingSchema = struct({
  entries: array(DirectoryEntrySchema),
  partial: Schema.Boolean,
  error: optional(Schema.String),
});
export const GitChangeSchema = struct({
  path,
  area: Schema.Literals(['staged', 'unstaged', 'untracked']),
});
export const GitStatusSchema = struct({
  branch: Schema.String,
  changes: array(GitChangeSchema),
  error: optional(Schema.String),
});
export const ComparisonSchema = struct({
  original: text,
  title: Schema.String,
  working: Schema.NullOr(FileDocumentSchema),
  error: optional(Schema.String),
});
export const LookupMatchSchema = struct({ path, score: Schema.Finite, positions: array(natural) });
export const WorkspaceEventSchema = struct({
  checkout: CheckoutTargetSchema,
  paths: array(path),
  ready: optional(Schema.Boolean),
  error: optional(Schema.String),
});
export const WorkspaceWatchInputSchema = struct({
  checkout: CheckoutTargetSchema,
  paths: array(path).check(Schema.isMaxLength(8192)),
});
export const workspaceInputSchemas = {
  openCheckout: struct({ root: path }),
  readFile: FileTargetSchema,
  saveFile: struct({
    target: FileTargetSchema,
    clientId: WorkspaceIdentifierSchema,
    requestId: WorkspaceIdentifierSchema,
    text,
    expectedVersion: Schema.String,
  }),
  listDirectory: struct({
    checkout: CheckoutTargetSchema,
    path,
    hideIgnored: optional(Schema.Boolean),
  }),
  gitStatus: struct({ checkout: CheckoutTargetSchema }),
  readComparison: struct({
    target: FileTargetSchema,
    area: Schema.Literals(['staged', 'unstaged', 'untracked']),
  }),
  lookupFiles: struct({
    checkout: CheckoutTargetSchema,
    query: Schema.String.check(
      Schema.isMaxLength(256),
      Schema.makeFilter((value) => !value.includes('\0')),
    ),
    limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    history: optional(
      array(path).check(
        Schema.isMaxLength(1000),
        Schema.makeFilter((value) => value.reduce((n, p) => n + p.length, 0) <= 256 * 1024),
      ),
    ),
  }),
  inspectEntries: struct({
    checkout: CheckoutTargetSchema,
    paths: array(path).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
  mutate: WorkspaceOperationSchema,
  operationStatus: struct({ clientId: WorkspaceIdentifierSchema, id: WorkspaceIdentifierSchema }),
  acknowledgeOperation: struct({
    clientId: WorkspaceIdentifierSchema,
    operationClientId: WorkspaceIdentifierSchema,
    id: WorkspaceIdentifierSchema,
  }),
  loadRecovery: struct({ clientId: WorkspaceIdentifierSchema }),
  persistRecovery: struct({
    clientId: WorkspaceIdentifierSchema,
    requestId: WorkspaceIdentifierSchema,
    expectedRevision: natural,
    state: EditorRecoverySchema,
  }),
  getRecoveryPublication: struct({
    clientId: WorkspaceIdentifierSchema,
    requestId: WorkspaceIdentifierSchema,
  }),
};
export const workspaceOutputSchemas = {
  openCheckout: CheckoutTargetSchema,
  readFile: FileDocumentSchema,
  saveFile: SaveResultSchema,
  listDirectory: DirectoryListingSchema,
  gitStatus: GitStatusSchema,
  readComparison: ComparisonSchema,
  lookupFiles: struct({
    matches: array(LookupMatchSchema).check(Schema.isMaxLength(100)),
    history: array(LookupMatchSchema).check(Schema.isMaxLength(100)),
    partial: Schema.Boolean,
    error: optional(Schema.String),
  }),
  inspectEntries: array(EntryReferenceSchema),
  mutate: OperationResultSchema,
  operationStatus: Schema.NullOr(OperationResultSchema),
  acknowledgeOperation: voidResult,
  loadRecovery: RecoveryLoadSchema,
  persistRecovery: RecoveryPublicationSchema,
  getRecoveryPublication: Schema.NullOr(RecoveryPublicationSchema),
} satisfies Record<keyof typeof workspaceInputSchemas, Schema.Constraint>;
const inputs = Object.fromEntries(
  Object.entries(workspaceInputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema, { onExcessProperty: 'error', reportInput: false }),
  ]),
);
const outputs = Object.fromEntries(
  Object.entries(workspaceOutputSchemas).map(([name, schema]) => [
    name,
    Schema.decodeUnknownSync(schema, { reportInput: false }),
  ]),
);
export const isWorkspaceCommand = (value: unknown): value is WorkspaceCommand =>
  typeof value === 'string' && Object.hasOwn(workspaceInputSchemas, value);
export function decodeWorkspaceInput<K extends WorkspaceCommand>(
  operation: K,
  value: unknown,
): CommandInput<K> {
  try {
    if (!isWorkspaceCommand(operation)) throw Error();
    return inputs[operation](value) as CommandInput<K>;
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid workspace input.' });
  }
}
export function decodeWorkspaceOutput<K extends WorkspaceCommand>(
  operation: K,
  value: unknown,
): CommandOutput<K> {
  try {
    if (!isWorkspaceCommand(operation)) throw Error();
    if (operation === 'loadRecovery') {
      if (!value || typeof value !== 'object') throw Error();
      decodeEditorRecovery((value as { state?: unknown }).state);
    }
    return outputs[operation](value) as CommandOutput<K>;
  } catch {
    throw new ApplicationError({ code: 'Incompatible', message: 'Invalid workspace reply.' });
  }
}
const event = Schema.decodeUnknownSync(WorkspaceEventSchema, { reportInput: false });
const watch = Schema.decodeUnknownSync(WorkspaceWatchInputSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
const recovery = Schema.decodeUnknownSync(EditorRecoverySchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
export function decodeWorkspaceEvent(value: unknown): typeof WorkspaceEventSchema.Type {
  try {
    return event(value);
  } catch {
    throw new ApplicationError({ code: 'Incompatible', message: 'Invalid workspace event.' });
  }
}
export function decodeWorkspaceWatchInput(value: unknown): typeof WorkspaceWatchInputSchema.Type {
  try {
    return watch(value);
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid workspace watch input.' });
  }
}
export function decodeEditorRecovery(value: unknown): typeof EditorRecoverySchema.Type {
  try {
    return recovery(value);
  } catch {
    throw new ApplicationError({ code: 'Incompatible', message: 'Invalid saved editor recovery.' });
  }
}
