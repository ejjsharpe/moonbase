import * as Schema from 'effect/Schema';
import { Rpc, RpcGroup } from 'effect/rpc';
import { CancelledError } from '@moonbase/contracts/errors';
import { array, voidResult } from '@moonbase/contracts/schema';
import {
  CheckoutTargetSchema,
  WorkspaceEventSchema,
  WorkspaceWatchInputSchema,
  workspaceInputSchemas,
  workspaceOutputSchemas,
} from '@moonbase/contracts/workspace-schema';
import { IpcAdmission } from './ipc-admission.ts';
import {
  IpcApplicationErrorSchema,
  IpcAuthorityError,
  IpcInputError,
  NativeActionError,
} from './ipc-errors.ts';
import { exact, RelativeCheckoutPathSchema } from './ipc-limits.ts';

/** The editor's client ID, the only one its document may act as. */
export const editorClientId = 'desktop-primary';
const errors = [
  IpcApplicationErrorSchema,
  IpcInputError,
  IpcAuthorityError,
  CancelledError,
] as const;
const error = Schema.Union(errors);
/** A reply's schema on the wire: no reply is `Schema.Void`, which encodes as JSON. */
const wire = <S extends Schema.Top>(schema: S) =>
  (schema === (voidResult as unknown) ? Schema.Void : schema) as S;
const command = <const K extends keyof typeof workspaceInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: exact(workspaceInputSchemas[operation]),
    success: wire(workspaceOutputSchemas[operation]),
    error,
  });
const checkout = exact(Schema.Struct({ checkout: CheckoutTargetSchema }));
const checkoutField = { checkout: CheckoutTargetSchema };
/** Captured import references; none when there was nothing to import, null for a declined prompt. */
const imports = Schema.NullOr(array(Schema.String));

/** The workspace commands and watch, and the native actions on an approved checkout. */
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
  command('operationStatus'),
  command('acknowledgeOperation'),
  command('loadRecovery'),
  command('persistRecovery'),
  command('getRecoveryPublication'),
  Rpc.make('watchWorkspace', {
    payload: exact(WorkspaceWatchInputSchema),
    success: WorkspaceEventSchema,
    error,
    stream: true,
  }),
  /** The native folder picker; the chosen root may then be opened once. */
  Rpc.make('chooseCheckout', { success: Schema.NullOr(Schema.String), error }),
  Rpc.make('chooseImports', { payload: checkout, success: imports, error }),
  /** Finder files on the clipboard, after the user consents. */
  Rpc.make('pasteImports', { payload: checkout, success: imports, error }),
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
    error,
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
    error,
  }),
  Rpc.make('revealPath', {
    payload: exact(Schema.Struct({ ...checkoutField, path: RelativeCheckoutPathSchema })),
    error: Schema.Union([...errors, NativeActionError]),
  }),
).middleware(IpcAdmission) {}
