import { Context, Effect, Exit, Layer, SubscriptionRef } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import { isPathAtOrInside } from '@moonbase/contracts/paths';
import type {
  CheckoutTarget,
  EntryReference,
  OperationResult,
  WorkspaceOperation,
} from '@moonbase/contracts/workspace';
import { EditorError, isRefusal, type EditorFailure } from '../editor-errors.ts';
import { describeEditorFailure } from '../alerts/alerts.ts';
import { makeEditorPrompt, type ShownPrompt } from '../editor-prompt.ts';
import { isRelativePath } from '../relative-path.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorAlerts } from '../alerts/alerts-service.ts';
import { EditorViews } from '../views/views-service.ts';
import { EditorBuffers } from '../buffers/buffers-service.ts';
import { isSaving, type EditorBuffer } from '../buffers/buffers.ts';
import { EditorDiscovery } from '../discovery/discovery-service.ts';
import { EditorOperations } from '../operations/operations-service.ts';
import { matchesOperation } from '../operations/operations.ts';
import { RecoverySync } from '../recovery/recovery-sync-service.ts';
import { sameCheckout } from '../recovery/recovery-references.ts';
import { EditorTree } from '../tree/tree-service.ts';
import {
  admitsMutation,
  findCollisions,
  getMutationDestinations,
  listOperationDestinations,
  mutationUnavailable,
  type MutationAction,
  type MutationOptions,
  type MutationRunResult,
  type MutationState,
  type ReplacePrompt,
} from './mutation.ts';

/** An operation as the editor's caller gives it: the editor adds its client and, if absent, ID. */
export type OperationInput = Omit<WorkspaceOperation, 'clientId' | 'id'> & { id?: string };

export type EditorMutationsShape = {
  readonly state: SubscriptionRef.SubscriptionRef<MutationState>;
  /** The replace prompt shown; closing the editor answers it Cancel (don't replace). */
  readonly replacePrompt: ShownPrompt<ReplacePrompt>;
  /** The mutation gate: whether `mutate` would admit `action` now. */
  readonly admits: (action: MutationAction) => Effect.Effect<boolean>;
  /**
   * Applies a file operation, one at a time: finds what it would replace, asks through
   * `replacePrompt` before replacing anything, then dispatches it. It never fails: a refusal or
   * failure is the result's `error`, and closing the editor ends it as declined.
   */
  readonly mutate: (
    action: MutationAction,
    options: MutationOptions,
  ) => Effect.Effect<MutationRunResult>;
  /** Answers the replace prompt. */
  readonly answer: (promptId: string, replace: boolean) => Effect.Effect<void>;
  /**
   * Dispatches an operation as given. `saving` is a Save of a buffer whose file isn't on disk,
   * which creates it with the buffer's text; it may run inside a Close's preservation, and so
   * while admissions are closed.
   */
  readonly dispatch: (
    input: OperationInput,
    saving?: EditorBuffer,
  ) => Effect.Effect<OperationResult, EditorFailure>;
  /** Asks the host how an operation whose outcome is uncertain ended, and takes it in. */
  readonly resolve: (
    id: string,
    operationClientId?: string,
  ) => Effect.Effect<OperationResult | null, EditorFailure>;
  readonly inspect: (
    checkout: CheckoutTarget,
    paths: string[],
  ) => Effect.Effect<EntryReference[], EditorFailure>;
  /** Reads and follows the store's recovery, taking in the operations it records. */
  readonly reconcile: Effect.Effect<void, EditorFailure>;
};

/** File operations: moves, copies, Trash, imports and new files and folders. */
export class EditorMutations extends Context.Service<EditorMutations, EditorMutationsShape>()(
  'moonbase/editor/EditorMutations',
) {
  static readonly layer = Layer.effect(
    EditorMutations,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      const session = yield* EditorSession;
      const alerts = yield* EditorAlerts;
      const views = yield* EditorViews;
      const buffers = yield* EditorBuffers;
      const discovery = yield* EditorDiscovery;
      const operations = yield* EditorOperations;
      const recovery = yield* RecoverySync;
      const tree = yield* EditorTree;
      const { clientId } = session;
      const state = yield* SubscriptionRef.make<MutationState>({ mutating: false });
      const replacePrompt = yield* makeEditorPrompt<ReplacePrompt, boolean>(false);
      const fail = (reason: EditorError['reason']) => Effect.fail(new EditorError({ reason }));
      const refreshIfOpen = (checkout: CheckoutTarget) =>
        Effect.flatMap(views.get, ({ recovery }) =>
          recovery.openCheckoutIds.includes(checkout.checkoutId)
            ? tree.refreshCheckout(checkout)
            : Effect.void,
        );

      const inspect = (checkout: CheckoutTarget, paths: string[]) =>
        Effect.gen(function* () {
          yield* views.view(checkout);
          if (!paths.every((path) => isRelativePath(path))) return yield* fail('invalid-path');
          return yield* workspace
            .inspectEntries({ checkout, paths })
            .pipe(Effect.tapError(alerts.report));
        });

      const dispatch: EditorMutationsShape['dispatch'] = (input, saving) =>
        Effect.gen(function* () {
          yield* views.view(input.checkout);
          const modes = yield* session.get;
          if (modes.initializing === input.checkout.checkoutId) return yield* fail('initializing');
          if (modes.preserving && !saving) return yield* fail('preserving');
          const operation: WorkspaceOperation = {
            ...structuredClone(input),
            clientId,
            id: input.id ?? crypto.randomUUID(),
          };
          if (yield* operations.find(clientId, operation.id))
            return yield* fail('operation-submitted');
          // A batch's destination is a folder, which may be the root.
          const batch = operation.sources.length > 1;
          if (
            operation.destination !== undefined &&
            !isRelativePath(operation.destination, operation.kind === 'import' || batch)
          )
            return yield* fail('invalid-path');
          const destinations = listOperationDestinations(operation);
          for (const target of [
            ...operation.sources.map((source) => source.target),
            ...destinations.map((path) => ({ checkout: operation.checkout, path })),
          ])
            if (yield* operations.isUncertainFor(target)) return yield* fail('operation-pending');
          for (const source of [...operation.sources, ...(operation.replacements ?? [])]) {
            if (!isRelativePath(source.target.path)) return yield* fail('invalid-path');
            if (!sameCheckout(source.target.checkout, operation.checkout))
              return yield* fail('operation-checkout');
          }
          const replacementPaths = [
            ...(operation.replacements ?? []).map((item) => item.target.path),
            ...destinations,
          ];
          const folded = (path: string) => path.normalize('NFC').toLowerCase();
          const open = [...(yield* buffers.get).buffers.values()].filter((buffer) =>
            sameCheckout(buffer.target.checkout, operation.checkout),
          );
          const inSources = (buffer: EditorBuffer) =>
            operation.sources.some((source) =>
              isPathAtOrInside(buffer.target.path, source.target.path),
            );
          if (
            open.some(
              (buffer) =>
                buffer.id !== saving?.id &&
                !inSources(buffer) &&
                replacementPaths.some((path) =>
                  isPathAtOrInside(folded(buffer.target.path), folded(path)),
                ),
            )
          )
            return yield* fail('replacement-open');
          if (open.some((buffer) => inSources(buffer) && isSaving(buffer)))
            return yield* fail('source-saving');
          // Send the source drafts before any external mutation, including Trash.
          yield* saving ? recovery.send : recovery.flush;
          yield* operations.register(operation);
          return yield* Effect.gen(function* () {
            const result = yield* workspace.mutate(operation).pipe(
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  yield* alerts.report(error);
                  if (isRefusal(error)) yield* operations.forget(clientId, operation.id);
                }),
              ),
            );
            if (!matchesOperation(result, operation)) return yield* fail('operation-identity');
            yield* recovery.reconcile(result);
            yield* refreshIfOpen(operation.checkout);
            return result;
          }).pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                if (yield* operations.find(clientId, operation.id))
                  yield* alerts.report(new EditorError({ reason: 'operation-unconfirmed' }));
              }),
            ),
          );
        });

      const resolve: EditorMutationsShape['resolve'] = (id, operationClientId = clientId) =>
        Effect.gen(function* () {
          if (!(yield* operations.find(operationClientId, id)))
            return yield* fail('operation-unknown');
          const result = yield* workspace
            .operationStatus({ clientId: operationClientId, id })
            .pipe(Effect.tapError(alerts.report));
          if (!result) {
            yield* alerts.report(new EditorError({ reason: 'operation-status-unavailable' }));
            return null;
          }
          if (result.clientId !== operationClientId || result.id !== id)
            return yield* fail('operation-status-identity');
          yield* recovery.reconcile(result);
          yield* refreshIfOpen(result.checkout);
          return result;
        });

      const admits = (action: MutationAction) =>
        Effect.map(
          Effect.all([session.get, views.get, SubscriptionRef.get(state)]),
          ([modes, { recovery }, { mutating }]) =>
            admitsMutation({ ...modes, prompting: false, mutating, recovery }, action),
        );

      /** Shows the replace prompt and waits for `answer`. */
      const ask = (replacements: readonly EntryReference[]) =>
        replacePrompt.ask({
          id: crypto.randomUUID(),
          paths: replacements.map((item) => item.target.path),
        });

      const apply = (action: MutationAction, options: MutationOptions) =>
        Effect.gen(function* () {
          let items: OperationResult['items'] = [];
          const done = (completed: boolean, error = '') => ({ completed, error, items });
          const id = options.id ?? crypto.randomUUID();
          const batchImport =
            action.kind === 'import' && (action.nativeReferences?.length ?? 0) > 1;
          const body = Effect.gen(function* () {
            if (yield* operations.find(clientId, id)) {
              const result = yield* resolve(id);
              if (result) items = structuredClone(result.items);
              if (result?.outcome === 'completed') return done(true);
              return done(
                false,
                'Operation remains unresolved. Its original identity is retained; no effects were repeated.',
              );
            }
            const sources = action.paths.length
              ? yield* inspect(action.checkout, action.paths)
              : [];
            let replace: EntryReference[] = [];
            if (action.kind !== 'trash') {
              const names = batchImport ? action.nativeNames : undefined;
              if (
                names &&
                (names.length !== action.nativeReferences!.length ||
                  names.some((name) => !name || name.includes('/')))
              )
                return done(false, 'Imported names don’t match the selection.');
              if (batchImport && !names) {
                const paths = (options.replacementPaths ?? '').split('\n').filter(Boolean);
                replace = paths.length ? yield* inspect(action.checkout, paths) : [];
              } else {
                const { parent, destinations } = names
                  ? {
                      parent: options.destination,
                      destinations: names.map((name) =>
                        options.destination ? `${options.destination}/${name}` : name,
                      ),
                    }
                  : getMutationDestinations(sources, options.destination);
                const listing = yield* discovery.list(action.checkout, parent);
                const { collisions, own } = findCollisions(
                  listing.entries,
                  destinations,
                  sources,
                  action.kind,
                );
                if (own) return done(false, 'Choose a different name from the original.');
                replace = collisions.length
                  ? yield* inspect(
                      action.checkout,
                      collisions.map((entry) => entry.path),
                    )
                  : [];
              }
            }
            if (replace.length && !(yield* ask(replace))) return done(false);
            const result = yield* dispatch({
              id,
              checkout: action.checkout,
              kind: action.kind,
              sources,
              ...(action.kind === 'trash' ? {} : { destination: options.destination }),
              ...(action.nativeReferences ? { nativeReferences: action.nativeReferences } : {}),
              replacements: replace,
            });
            items = structuredClone(result.items);
            // The host's own note on it is not shown: no host text reaches the UI.
            if (result.outcome !== 'completed')
              return done(
                false,
                'Operation incomplete. Review the recorded outcome before continuing.',
              );
            return done(true);
          });
          const exit = yield* Effect.exit(body);
          if (Exit.isSuccess(exit)) return exit.value;
          const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
          // Closing the editor ends a mutation as declined.
          return done(false, failure ? describeEditorFailure(failure.error) : '');
        });

      return {
        state,
        replacePrompt: replacePrompt.shown,
        admits,
        // A caller interrupted meanwhile waits for the mutation it started, so the gate stays
        // taken until the mutation ends; closing the editor still interrupts the mutation.
        mutate: (action, options) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const [modes, { recovery }] = yield* Effect.all([session.get, views.get]);
              // Checking the gate and taking it are one step, so two mutations can't both start.
              const reserved = yield* SubscriptionRef.modify(state, (s) =>
                admitsMutation(
                  { ...modes, prompting: false, mutating: s.mutating, recovery },
                  action,
                )
                  ? [true, { ...s, mutating: true }]
                  : [false, s],
              );
              if (!reserved)
                return {
                  completed: false,
                  error: mutationUnavailable,
                  items: [],
                } as MutationRunResult;
              return yield* session.run(restore(apply(action, options))).pipe(
                Effect.catchCause(() =>
                  Effect.succeed<MutationRunResult>({ completed: false, error: '', items: [] }),
                ),
                Effect.ensuring(SubscriptionRef.update(state, (s) => ({ ...s, mutating: false }))),
              );
            }),
          ),
        answer: (promptId, replace) => replacePrompt.answer(promptId, replace === true),
        dispatch: (input, saving) =>
          saving ? session.run(dispatch(input, saving)) : session.admitted(dispatch(input)),
        resolve: (id, operationClientId) => session.admitted(resolve(id, operationClientId)),
        inspect: (checkout, paths) => session.admitted(inspect(checkout, paths)),
        reconcile: session.admitted(Effect.andThen(session.assertReady, recovery.reconcile())),
      } satisfies EditorMutationsShape;
    }),
  );
}
