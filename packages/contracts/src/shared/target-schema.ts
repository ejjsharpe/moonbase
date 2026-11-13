import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { struct } from './schema.ts';

// Checkout and file targets, apart from the workspace schemas so `ApplicationError` can carry a
// target without a runtime import cycle.
const string = Schema.String.check(Schema.isMaxLength(4096));
export const PathSchema = string.check(Schema.makeFilter((value) => !value.includes('\0')));
export const NonemptyStringSchema = string.check(Schema.isMinLength(1));

const checkoutFields = {
  hostId: NonemptyStringSchema,
  checkoutId: NonemptyStringSchema,
  projectId: NonemptyStringSchema,
  root: PathSchema.check(Schema.isMinLength(1)),
};
/** A checkout at the top of a Git working tree. Saved targets without `vcs` decode as Git. */
export const GitCheckoutTargetSchema = struct({
  vcs: Schema.Literal('git').pipe(Schema.withDecodingDefaultKey(Effect.succeed('git' as const))),
  ...checkoutFields,
  branch: NonemptyStringSchema,
  /** Whether `root` is the repository's main working tree or a linked `git worktree`. */
  worktree: Schema.Literals(['main', 'linked']),
});
/** A plain folder in no Git repository: it has no branch, worktrees or Git status. */
export const FolderCheckoutTargetSchema = struct({
  vcs: Schema.Literal('none'),
  ...checkoutFields,
});
export const CheckoutTargetSchema = Schema.Union([
  GitCheckoutTargetSchema,
  FolderCheckoutTargetSchema,
]);
export const FileTargetSchema = struct({
  checkout: CheckoutTargetSchema,
  path: PathSchema.check(Schema.isMinLength(1)),
});
