import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Cause, Effect, Exit, Scope, Stream } from 'effect';
import type {
  CheckoutTarget,
  CommandInput,
  CommandOutput,
  WorkspaceCommand,
} from '@moonbase/contracts/workspace';
import type { WorkspaceServiceShape } from '@moonbase/contracts/services';
import { toWireError } from '@moonbase/contracts/workspace-errors';
import { EditorRpcs, editorClientId } from '../../ipc/editor-rpcs.ts';
import { IpcAuthorityError, IpcInputError, NativeActionError } from '../../ipc/ipc-errors.ts';
import { IpcRequestIdSchema } from '../../ipc/ipc-limits.ts';
import type { NativeActions } from '../native-actions.ts';
import type { DocumentGrants, EditorApprovals } from './editor-approvals.ts';
import * as Schema from 'effect/Schema';

export type EditorIpcOptions = {
  /** The root's workspace; its errors cross as the legacy `ApplicationError` codes and text. */
  workspace: WorkspaceServiceShape;
  native: NativeActions;
  approvals: EditorApprovals;
  /**
   * The host of this Mac's own files, the only one Reveal in Finder can show; a checkout of any
   * other host is refused.
   */
  readonly localHostId: Effect.Effect<string | undefined>;
  /** Reports a cleanup failure no request is left to answer with. */
  reportCleanup(cause: Cause.Cause<unknown>): Effect.Effect<void>;
};

/** Whether `path` is `root` or lies within it. */
const isInside = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};
const isRequestId = Schema.is(IpcRequestIdSchema);

/**
 * The editor procedures for one document. Authority belongs to the document main served, never to
 * a renderer root or caller ID: a command reaches the workspace only for a checkout main approved.
 */
export function makeEditorIpcHandlers(options: EditorIpcOptions, document: Scope.Scope) {
  const { workspace, native, approvals } = options;
  const grants: DocumentGrants = approvals.makeDocumentGrants();
  const checkApproved = (checkout: CheckoutTarget) =>
    approvals.isApproved(checkout)
      ? Effect.void
      : Effect.fail(new IpcAuthorityError({ refusal: 'checkout' }));
  const command =
    <K extends WorkspaceCommand>(operation: K) =>
    (input: CommandInput<K>) =>
      Effect.gen(function* () {
        const v = input as Record<string, unknown>;
        if (
          (operation === 'operationStatus' || operation === 'acknowledgeOperation') &&
          ![v.clientId, v.operationClientId, v.id].every(
            (id) => id === undefined || isRequestId(id),
          )
        )
          return yield* new IpcInputError({ problem: 'request-id' });
        const refusal = yield* Effect.sync(() => approvals.findRefusal(operation, input, grants));
        if (refusal) return yield* new IpcAuthorityError({ refusal });
        const run = workspace[operation] as (
          input: CommandInput<K>,
        ) => Effect.Effect<CommandOutput<K>, Parameters<typeof toWireError>[0]>;
        const output = yield* run(input).pipe(Effect.mapError(toWireError));
        yield* Effect.sync(() => approvals.record(operation, output, grants));
        return output;
      });
  /** The absolute path of `path` (relative; empty for the root) inside an approved checkout. */
  const resolvePath = (checkout: CheckoutTarget, path: string) => {
    const absolute = join(checkout.root, path);
    return isInside(checkout.root, absolute)
      ? Effect.succeed(absolute)
      : Effect.fail(new IpcInputError({ problem: 'checkout-path' }));
  };
  const release = (checkout: CheckoutTarget, references: string[]) =>
    native.release({ checkout, clientId: editorClientId, references });
  /**
   * Captured references belong to the document from the moment they exist, so it releases them
   * however the request ends. A request cancelled while the user chooses captures nothing; one
   * cancelled while the capture is under way waits for it and releases what it took at once,
   * since nothing published it.
   */
  const captureImports = (checkout: CheckoutTarget, kind: 'picker' | 'clipboard', paths?: string[]) =>
    Effect.gen(function* () {
      yield* checkApproved(checkout);
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const chosen = paths ?? (yield* restore(native.choosePaths(checkout, kind)));
          if (!chosen?.length) return chosen === null ? null : [];
          const references = yield* restore(Effect.void).pipe(
            Effect.andThen(native.capture({ checkout, clientId: editorClientId, paths: chosen })),
          );
          const owned = yield* Scope.fork(document, 'sequential');
          yield* Scope.addFinalizer(owned, release(checkout, references).pipe(Effect.orDie));
          return yield* restore(Effect.succeed(references)).pipe(
            Effect.onInterrupt(() =>
              Effect.flatMap(Effect.exit(Scope.close(owned, Exit.void)), (exit) =>
                Exit.isFailure(exit) ? options.reportCleanup(exit.cause) : Effect.void,
              ),
            ),
          );
        }),
      );
    });
  return EditorRpcs.of({
    openCheckout: command('openCheckout'),
    readFile: command('readFile'),
    saveFile: command('saveFile'),
    listDirectory: command('listDirectory'),
    getIgnoredPaths: command('getIgnoredPaths'),
    gitStatus: command('gitStatus'),
    listWorktrees: command('listWorktrees'),
    createWorktree: command('createWorktree'),
    initializeRepository: command('initializeRepository'),
    readComparison: command('readComparison'),
    lookupFiles: command('lookupFiles'),
    searchText: command('searchText'),
    inspectEntries: command('inspectEntries'),
    mutate: command('mutate'),
    operationStatus: command('operationStatus'),
    acknowledgeOperation: command('acknowledgeOperation'),
    loadRecovery: command('loadRecovery'),
    openTab: command('openTab'),
    closeTab: command('closeTab'),
    updateDraft: command('updateDraft'),
    updateLayout: command('updateLayout'),
    watchRecovery: (input) =>
      Stream.unwrap(
        Effect.as(
          input.clientId === editorClientId
            ? Effect.void
            : Effect.fail(new IpcAuthorityError({ refusal: 'foreign-client' })),
          workspace.watchRecovery(input).pipe(Stream.mapError(toWireError)),
        ),
      ),
    watchWorkspace: (input) =>
      Stream.unwrap(
        Effect.as(
          checkApproved(input.checkout),
          workspace.watch(input).pipe(Stream.mapError(toWireError)),
        ),
      ),
    chooseCheckout: () =>
      native.chooseCheckout.pipe(
        Effect.tap((root) =>
          Effect.sync(() => {
            if (typeof root === 'string') grants.roots.add(root);
          }),
        ),
      ),
    chooseImports: ({ checkout }) => captureImports(checkout, 'picker'),
    pasteImports: ({ checkout }) => captureImports(checkout, 'clipboard'),
    dropImports: ({ checkout, paths }) => captureImports(checkout, 'picker', [...paths]),
    copyPaths: ({ checkout, paths, relative }) =>
      Effect.gen(function* () {
        yield* checkApproved(checkout);
        const absolute = yield* Effect.forEach(paths, (path) => resolvePath(checkout, path));
        yield* native.copyText((relative ? paths : absolute).join('\n'));
      }),
    revealPath: ({ checkout, path }) =>
      Effect.gen(function* () {
        yield* checkApproved(checkout);
        const target = yield* resolvePath(checkout, path);
        // Another host's files are not on this Mac, and a path that is only spelled like one of
        // its own would show the wrong file.
        if (checkout.hostId !== (yield* options.localHostId))
          return yield* new NativeActionError({ failure: 'reveal-other-host' });
        // Follow links before checking again, so a link inside the checkout can't point out of it.
        const [root, real] = yield* Effect.tryPromise({
          try: () => Promise.all([realpath(checkout.root), realpath(target)]),
          catch: () => new NativeActionError({ failure: 'reveal-missing' }),
        });
        if (!isInside(root, real)) return yield* new IpcInputError({ problem: 'checkout-path' });
        yield* native.reveal(real);
      }),
  });
}
