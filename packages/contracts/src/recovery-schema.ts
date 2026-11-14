import * as Schema from 'effect/Schema';
import { array, optional, struct, voidResult } from './schema.ts';
import { areJsonValuesEqual } from './common.ts';
import { NonemptyStringSchema as nonempty } from './target-schema.ts';
import {
  CheckoutPathSchema,
  CheckoutTreeSchema,
  FileDocumentSchema,
  FilePositionsSchema,
  FileTextSchema,
  FileViewSchema,
  RecoveryCheckoutSchema,
  RecoveryTargetSchema,
  WorkspaceIdentifierSchema,
  isUnique,
  maximumRecoveryBytes,
} from './workspace-schema.ts';

// The client recovery store's own format (epic #273 D3): an open file is a buffer with a stable
// ID, and everything about it (its tab, draft, view and positions) names the buffer, so an edit
// that lands after a move or Trash applies to the buffer where it now is. A buffer's target is
// the one place its path lives. The files tree, recent files and what a view remembers of closed
// files are paths, not buffers.

/** A buffer's ID, chosen by the client that opens it and kept across moves. */
export const BufferIdSchema = WorkspaceIdentifierSchema;
/** Unsaved text over the file text (`disk`) it was edited from. */
export const BufferDraftSchema = struct({ text: FileTextSchema, disk: FileDocumentSchema });
/** An open file: where it is now and, while it differs from disk, its draft. */
export const RecoveryBufferSchema = struct({
  id: BufferIdSchema,
  target: RecoveryTargetSchema,
  draft: optional(BufferDraftSchema),
});
/** What a checkout's view remembers of a file that has no buffer. */
export const RememberedFileSchema = struct({
  view: optional(FileViewSchema),
  positions: optional(FilePositionsSchema),
});
export const BufferViewSchema = struct({
  tabs: array(BufferIdSchema).check(Schema.isMaxLength(1000)),
  active: Schema.NullOr(BufferIdSchema),
  preview: Schema.NullOr(BufferIdSchema),
  fileViews: Schema.Record(BufferIdSchema, Schema.mutableKey(FileViewSchema)),
  positions: Schema.Record(BufferIdSchema, Schema.mutableKey(FilePositionsSchema)),
  remembered: Schema.Record(CheckoutPathSchema, Schema.mutableKey(RememberedFileSchema)),
  tree: CheckoutTreeSchema,
}).check(
  Schema.makeFilter(
    (view) =>
      isUnique(view.tabs) &&
      (view.active === null || view.tabs.includes(view.active)) &&
      (view.preview === null || view.tabs.includes(view.preview)),
  ),
);
/** Everything but the buffers: what `updateLayout` replaces. */
export const RecoveryLayoutSchema = struct({
  checkouts: array(RecoveryCheckoutSchema).check(Schema.isMaxLength(128)),
  openCheckoutIds: array(nonempty).check(Schema.isMaxLength(128)),
  selectedCheckoutId: Schema.NullOr(nonempty),
  views: Schema.Record(Schema.String, Schema.mutableKey(BufferViewSchema)),
  recentFiles: array(RecoveryTargetSchema).check(Schema.isMaxLength(1000)),
  sidebarWidth: Schema.Finite.check(Schema.isBetween({ minimum: 100, maximum: 2000 })),
  /** Whether each checkout's files tree reveals the file made active (Follow Active File). */
  followActiveFile: optional(Schema.Boolean),
});
/** The most buffers, and the most drafts among them, one recovery holds. */
export const maximumBuffers = 4096;
export const maximumDrafts = 512;

type Target = typeof RecoveryTargetSchema.Type;
/**
 * Checkouts are listed once each and everything else names one of them as listed; every buffer
 * a view names is a buffer of that view's checkout.
 */
function isConsistent(
  state: typeof RecoveryLayoutSchema.Type & { buffers: readonly { id: string; target: Target }[] },
) {
  const checkouts = new Map(state.checkouts.map((c) => [c.checkoutId, c]));
  const listed = (target: Target) =>
    areJsonValuesEqual(checkouts.get(target.checkout.checkoutId), target.checkout);
  const buffers = new Map(state.buffers.map((b) => [b.id, b]));
  return (
    checkouts.size === state.checkouts.length &&
    isUnique(state.openCheckoutIds) &&
    state.openCheckoutIds.every((id) => checkouts.has(id)) &&
    (state.selectedCheckoutId === null ||
      state.openCheckoutIds.includes(state.selectedCheckoutId)) &&
    Object.keys(state.views).every((id) => checkouts.has(id)) &&
    buffers.size === state.buffers.length &&
    isUnique(state.buffers.map((b) => b.target)) &&
    state.buffers.every((b) => listed(b.target)) &&
    Object.entries(state.views).every(([checkoutId, view]) => {
      const owned = (id: string) => buffers.get(id)?.target.checkout.checkoutId === checkoutId;
      return (
        view.tabs.every(owned) &&
        Object.keys(view.fileViews).every(owned) &&
        Object.keys(view.positions).every(owned)
      );
    }) &&
    state.recentFiles.every(listed)
  );
}
export const RecoveryStateSchema = struct({
  version: Schema.Literal(2),
  clientId: WorkspaceIdentifierSchema,
  ...RecoveryLayoutSchema.fields,
  buffers: array(RecoveryBufferSchema).check(Schema.isMaxLength(maximumBuffers)),
}).check(
  Schema.makeFilter(
    (state) => state.buffers.filter((b) => b.draft !== undefined).length <= maximumDrafts,
  ),
  Schema.makeFilter(isConsistent),
  Schema.makeFilter(
    (state) => new TextEncoder().encode(JSON.stringify(state)).length <= maximumRecoveryBytes,
  ),
);
/**
 * A recovery as `watchRecovery` publishes it: without draft text, so a keystroke changes
 * nothing in it. A buffer's draft says only which file text (its version) it was edited from.
 */
export const RecoveryOutlineSchema = struct({
  version: Schema.Literal(2),
  clientId: WorkspaceIdentifierSchema,
  ...RecoveryLayoutSchema.fields,
  buffers: array(
    struct({
      id: BufferIdSchema,
      target: RecoveryTargetSchema,
      draft: optional(struct({ baseline: Schema.String })),
    }),
  ).check(Schema.isMaxLength(maximumBuffers)),
});

const clientId = WorkspaceIdentifierSchema;
/**
 * The recovery store's edits. Each applies to one client's recovery in order with that client's
 * other edits, returns once committed, and counts as that client's publication.
 */
export const recoveryEditInputSchemas = {
  /** Opens a buffer as a tab of its checkout; a buffer already open stays where it is now. */
  openTab: struct({ clientId, bufferId: BufferIdSchema, target: RecoveryTargetSchema }),
  /** Closes a buffer and its tab; one with a draft only with `discard`. */
  closeTab: struct({ clientId, bufferId: BufferIdSchema, discard: optional(Schema.Boolean) }),
  /** A buffer's text over the file text it was edited from; text equal to `disk` is no draft. */
  updateDraft: struct({
    clientId,
    bufferId: BufferIdSchema,
    text: FileTextSchema,
    disk: FileDocumentSchema,
  }),
  /** Replaces everything but the buffers. */
  updateLayout: struct({ clientId, layout: RecoveryLayoutSchema }),
};
export const recoveryEditOutputSchemas = {
  openTab: voidResult,
  closeTab: voidResult,
  updateDraft: voidResult,
  updateLayout: voidResult,
} satisfies Record<keyof typeof recoveryEditInputSchemas, Schema.Constraint>;
export const WatchRecoveryInputSchema = struct({ clientId });
