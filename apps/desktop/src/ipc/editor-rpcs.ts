import * as Schema from 'effect/Schema';
import { Rpc, RpcGroup } from 'effect/rpc';
import { array, toWireReply } from '@moonbase/contracts/schema';
import {
  CheckoutTargetSchema,
  WorkspaceEventSchema,
  WorkspaceWatchInputSchema,
  workspaceInputSchemas,
  workspaceOutputSchemas,
} from '@moonbase/contracts/workspace-schema';
import {
  RecoveryOutlineSchema,
  WatchRecoveryInputSchema,
  recoveryInputSchemas,
  recoveryOutputSchemas,
} from '@moonbase/contracts/recovery-schema';
import { Mutation, StatusCall } from '@moonbase/contracts/rpc-annotations';
import { isHostMutation, isHostStatusCall } from '@moonbase/contracts/workspace-rpc';
import { IpcAdmission } from './ipc-admission.ts';
import {
  IpcAuthorityError,
  IpcInputError,
  NativeActionError,
} from '@moonbase/contracts/ipc-errors';
import { workspaceServiceErrors } from './ipc-errors.ts';
import { exact, RelativeCheckoutPathSchema } from './ipc-limits.ts';

/** The editor's client ID, the only one its document may act as. */
export const editorClientId = 'desktop-primary';
// Each procedure's errors: what its handler refuses, and what the workspace fails with.
const union = <const E extends readonly Schema.Top[]>(errors: E) =>
  Schema.Union([...new Set(errors)] as unknown as E);
/** A workspace command or watch for something main never approved for this document. */
const error = union([IpcAuthorityError, ...workspaceServiceErrors]);
/** An operation's status or acknowledgement: also a malformed request identity. */
const statusError = union([IpcAuthorityError, IpcInputError, ...workspaceServiceErrors]);
/** A native import: also the native action's own refusals. */
const importError = union([IpcAuthorityError, NativeActionError, ...workspaceServiceErrors]);
/** A workspace command, a mutation where the file host's operation it runs is one. */
const command = <const K extends keyof typeof workspaceInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: exact(workspaceInputSchemas[operation]),
    success: toWireReply(workspaceOutputSchemas[operation]),
    error,
  }).annotate(Mutation, isHostMutation(operation));
const statusCommand = <const K extends 'operationStatus' | 'acknowledgeOperation'>(operation: K) =>
  Rpc.make(operation, {
    payload: exact(workspaceInputSchemas[operation]),
    success: toWireReply(workspaceOutputSchemas[operation]),
    error: statusError,
  })
    .annotate(Mutation, isHostMutation(operation))
    .annotate(StatusCall, isHostStatusCall(operation));
const recovery = <const K extends keyof typeof recoveryInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: exact(recoveryInputSchemas[operation]),
    success: toWireReply(recoveryOutputSchemas[operation]),
    error,
  });
const checkout = exact(Schema.Struct({ checkout: CheckoutTargetSchema }));
const checkoutField = { checkout: CheckoutTargetSchema };
/** Captured import references; none when there was nothing to import, null for a declined prompt. */
const imports = Schema.NullOr(array(Schema.String));

/**
 * The workspace commands and watch, the recovery store's load, edits and watch, and the native
 * actions on an approved checkout. Recovery edits are not mutations: each sets a state, so
 * sending one again is safe.
 */
export class EditorRpcs extends RpcGroup.make(
  command('openCheckout'),
  command('readFile'),
  command('saveFile'),
  command('listDirectory'),
  command('getIgnoredPaths'),
  command('gitStatus'),
  command('listWorktrees'),
  command('createWorktree'),
  command('initializeRepository'),
  command('readComparison'),
  command('lookupFiles'),
  command('searchText'),
  command('inspectEntries'),
  command('mutate'),
  statusCommand('operationStatus'),
  statusCommand('acknowledgeOperation'),
  recovery('loadRecovery'),
  recovery('openTab'),
  recovery('closeTab'),
  recovery('updateDraft'),
  recovery('updateLayout'),
  /** The editor's recovery without draft text, then again each time that changes. */
  Rpc.make('watchRecovery', {
    payload: exact(WatchRecoveryInputSchema),
    success: RecoveryOutlineSchema,
    error,
    stream: true,
  }),
  Rpc.make('watchWorkspace', {
    payload: exact(WorkspaceWatchInputSchema),
    success: WorkspaceEventSchema,
    error,
    stream: true,
  }),
  /** The native folder picker; the chosen root may then be opened once. */
  Rpc.make('chooseCheckout', { success: Schema.NullOr(Schema.String) }),
  Rpc.make('chooseImports', { payload: checkout, success: imports, error: importError }),
  /** Finder files on the clipboard, after the user consents. */
  Rpc.make('pasteImports', { payload: checkout, success: imports, error: importError }),
  Rpc.make('dropImports', {
    payload: exact(
      Schema.Struct({
        ...checkoutField,
        paths: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(256),
        ),
      }),
    ),
    success: imports,
    error: importError,
  }),
  /** Main writes the clipboard, so the renderer can put only checkout paths on it. */
  Rpc.make('copyPaths', {
    payload: exact(
      Schema.Struct({
        ...checkoutField,
        paths: Schema.Array(RelativeCheckoutPathSchema).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(20000),
        ),
        relative: Schema.Boolean,
      }),
    ),
    error: union([IpcAuthorityError, IpcInputError]),
  }),
  Rpc.make('revealPath', {
    payload: exact(Schema.Struct({ ...checkoutField, path: RelativeCheckoutPathSchema })),
    error: union([IpcAuthorityError, IpcInputError, NativeActionError]),
  }),
).middleware(IpcAdmission) {}
