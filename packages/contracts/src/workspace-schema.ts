import * as Schema from 'effect/Schema';
import { ApplicationError, maximumFileBytes } from './workspace.ts';
import type { CommandInput, CommandOutput } from './workspace.ts';
import { array, optional, struct, voidResult } from './schema.ts';
import { getJsonKey } from './common.ts';
import {
  CheckoutTargetSchema,
  FileTargetSchema,
  GitCheckoutTargetSchema,
  NonemptyStringSchema as nonempty,
  PathSchema as path,
} from './target-schema.ts';

export {
  CheckoutTargetSchema,
  FileTargetSchema,
  FolderCheckoutTargetSchema,
  GitCheckoutTargetSchema,
} from './target-schema.ts';

export const WorkspaceIdentifierSchema = Schema.String.check(Schema.isPattern(/^[\w.-]{1,160}$/));
const natural = Schema.Int.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);
const coordinate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
/** Whether a string has no lone surrogates (`String.prototype.isWellFormed`, ES2024). */
export const isWellFormed = (value: string) =>
  (value as string & { isWellFormed(): boolean }).isWellFormed();
/** A file's text as recovery and saves carry it: well-formed, no NUL, within the file bound. */
export const FileTextSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      !value.includes('\0') &&
      isWellFormed(value) &&
      new TextEncoder().encode(value).length <= maximumFileBytes,
  ),
);
const text = FileTextSchema;
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
/** An editor's remembered positions in one file, per view (and its original side). */
export const FilePositionsSchema = struct({
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
/**
 * Whether `value` is an exact checkout-relative path: no leading `/`, backslash or NUL, and no
 * empty, `.`, `..` or `.git` segment. `''` (the checkout itself) is one only when `folder` is set.
 */
export const isCheckoutPath = (value: string, folder = false) =>
  value.length <= 4096 &&
  (folder || value !== '') &&
  !value.startsWith('/') &&
  !/[\\\0]/.test(value) &&
  (value === '' ||
    !value.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git'));
export const CheckoutPathSchema = Schema.String.check(
  Schema.makeFilter((value) => isCheckoutPath(value)),
);
const checkoutPath = CheckoutPathSchema;
export const CheckoutFolderSchema = Schema.String.check(
  Schema.makeFilter((value) => isCheckoutPath(value, true)),
);
const checkoutFolder = CheckoutFolderSchema;
export const isUnique = (values: readonly unknown[]) =>
  new Set(values.map(getJsonKey)).size === values.length;
/** A checkout in recovery: its root is an absolute path. */
export const RecoveryCheckoutSchema = CheckoutTargetSchema.check(
  Schema.makeFilter((target) => target.root.startsWith('/')),
);
/** A file in recovery: an exact checkout-relative path. */
export const RecoveryTargetSchema = struct({
  checkout: RecoveryCheckoutSchema,
  path: checkoutPath,
});
/** A checkout's files tree: folder paths, not buffers. */
export const CheckoutTreeSchema = struct({
  expanded: array(checkoutFolder),
  selected: array(checkoutFolder),
  focus: checkoutFolder,
  scroll: coordinate,
  /** Whether the tree leaves out entries Git has classified as ignored (Hide Ignored Files). */
  hideIgnoredFiles: optional(Schema.Boolean),
  /**
   * Written by a since-removed Hide button whose choice was never applied; still accepted so
   * views saved by it load, but never honoured, so an old `true` hides nothing.
   */
  hideIgnored: optional(Schema.Boolean),
});
/** The most JSON bytes a recovery state may take. */
export const maximumRecoveryBytes = 32 * 1024 * 1024;
export const RecoveryChangeSchema = struct({
  clientId: WorkspaceIdentifierSchema,
  previousRevision: natural,
  revision: natural,
});
export const EntryReferenceSchema = struct({
  target: FileTargetSchema,
  identity: Schema.String,
  directory: Schema.Boolean,
});
export const OperationKindSchema = Schema.Literals([
  'create-file',
  'create-directory',
  'move',
  'copy',
  'trash',
  'import',
]);
export const OperationOutcomeSchema = Schema.Literals(['completed', 'failed', 'uncertain']);
const kind = OperationKindSchema;
const outcome = OperationOutcomeSchema;
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
export const OperationItemSchema = struct({
  source: Schema.String,
  destination: optional(Schema.String),
  outcome,
  message: optional(Schema.String),
});
export const OperationResultSchema = struct({
  id: WorkspaceIdentifierSchema,
  clientId: WorkspaceIdentifierSchema,
  checkout: CheckoutTargetSchema,
  kind,
  recoveryChanges: array(RecoveryChangeSchema),
  outcome,
  items: array(OperationItemSchema),
  message: optional(Schema.String),
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
export const GitChangeKindSchema = Schema.Literals([
  'modified',
  'added',
  'deleted',
  'untracked',
  'conflicted',
  'typechange',
]);
/** One path's change in one area; an unmerged path has a single `conflicted` entry. */
export const GitChangeSchema = struct({
  path,
  area: Schema.Literals(['conflicted', 'staged', 'unstaged', 'untracked']),
  kind: GitChangeKindSchema,
  /** A conflict with no working file to resolve in, because both sides deleted it. */
  missing: optional(Schema.Boolean),
});
export const GitStatusSchema = struct({
  branch: Schema.String,
  changes: array(GitChangeSchema),
  error: optional(Schema.String),
});
export const WorktreeSchema = struct({
  root: path.check(Schema.isMinLength(1)),
  branch: Schema.String,
  main: Schema.Boolean,
  locked: Schema.Boolean,
  prunable: Schema.Boolean,
});
const refName = nonempty.check(
  Schema.isMaxLength(255),
  Schema.makeFilter((value) => !value.startsWith('-') && !/[\0-\x20\x7f]/.test(value)),
);
export const ComparisonSchema = struct({
  original: text,
  title: Schema.String,
  working: Schema.NullOr(FileDocumentSchema),
  error: optional(Schema.String),
});
export const LookupMatchSchema = struct({ path, score: Schema.Finite, positions: array(natural) });
const searchLine = Schema.String.check(Schema.isMaxLength(512));
/** A text match: `ranges` are UTF-16 offsets into `text`; `before`/`after` are nearby lines. */
export const TextMatchSchema = struct({
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  text: searchLine,
  ranges: array(struct({ start: natural, end: natural })).check(Schema.isMaxLength(64)),
  before: array(searchLine).check(Schema.isMaxLength(8)),
  after: array(searchLine).check(Schema.isMaxLength(8)),
});
export const TextSearchFileSchema = struct({
  path,
  matches: array(TextMatchSchema).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});
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
    includeIgnoredStatus: optional(Schema.Boolean),
  }),
  getIgnoredPaths: struct({
    checkout: CheckoutTargetSchema,
    path,
    paths: array(path).check(Schema.isMaxLength(20000)),
  }),
  gitStatus: struct({ checkout: CheckoutTargetSchema }),
  listWorktrees: struct({ checkout: CheckoutTargetSchema }),
  createWorktree: struct({
    checkout: CheckoutTargetSchema,
    base: refName,
    branch: refName,
    location: path.check(Schema.isMinLength(2)),
  }),
  initializeRepository: struct({ checkout: CheckoutTargetSchema }),
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
  searchText: struct({
    checkout: CheckoutTargetSchema,
    query: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(256),
      Schema.makeFilter((value) => !/[\0\n\r]/.test(value)),
    ),
    matchCase: Schema.Boolean,
    wholeWord: Schema.Boolean,
    regex: Schema.Boolean,
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
};
export const workspaceOutputSchemas = {
  openCheckout: CheckoutTargetSchema,
  readFile: FileDocumentSchema,
  saveFile: SaveResultSchema,
  listDirectory: DirectoryListingSchema,
  getIgnoredPaths: struct({ paths: array(path), error: optional(Schema.String) }),
  gitStatus: GitStatusSchema,
  listWorktrees: struct({ worktrees: array(WorktreeSchema).check(Schema.isMaxLength(1000)) }),
  createWorktree: CheckoutTargetSchema,
  initializeRepository: GitCheckoutTargetSchema,
  readComparison: ComparisonSchema,
  lookupFiles: struct({
    matches: array(LookupMatchSchema).check(Schema.isMaxLength(100)),
    history: array(LookupMatchSchema).check(Schema.isMaxLength(100)),
    partial: Schema.Boolean,
    error: optional(Schema.String),
  }),
  searchText: struct({
    files: array(TextSearchFileSchema).check(Schema.isMaxLength(200)),
    partial: Schema.Boolean,
    error: optional(Schema.String),
  }),
  inspectEntries: array(EntryReferenceSchema),
  mutate: OperationResultSchema,
  operationStatus: Schema.NullOr(OperationResultSchema),
  acknowledgeOperation: voidResult,
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
/** A workspace file command (the recovery store's are in `recovery-schema`). */
type WorkspaceCommand = keyof typeof workspaceInputSchemas;
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
