import { Context, Effect, Exit, Layer } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import type { CheckoutTarget, CommandInput, CommandOutput } from '@moonbase/contracts/workspace';
import { EditorError, type EditorFailure } from '../editor-errors.ts';
import { describeEditorFailure } from '../alerts/alerts.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorAlerts } from '../alerts/alerts-service.ts';
import { EditorViews } from '../views/views-service.ts';
import { isCheckoutListed, rebindClosed } from '../views/views.ts';
import { EditorBuffers } from '../buffers/buffers-service.ts';
import { isSaving } from '../buffers/buffers.ts';
import { EditorDiscovery } from '../discovery/discovery-service.ts';
import { forgetCheckout } from '../discovery/discovery.ts';
import { EditorOperations } from '../operations/operations-service.ts';
import { RecoveryOutbox } from '../recovery/recovery-outbox-service.ts';
import { RecoverySync } from '../recovery/recovery-sync-service.ts';
import { emptyCheckoutView } from '../recovery/recovery-layout.ts';
import { fileKey, sameCheckout } from '../recovery/recovery-references.ts';
import { EditorTabs } from '../tabs/tabs-service.ts';
import { EditorTree } from '../tree/tree-service.ts';
import { isInitialized } from './checkouts.ts';

export type EditorCheckoutsShape = {
  /** Opens the checkout at `root` (after the user chose it) and selects it. */
  readonly openCheckout: (root: string) => Effect.Effect<CheckoutTarget, EditorFailure>;
  readonly selectCheckout: (target: CheckoutTarget) => Effect.Effect<boolean, EditorFailure>;
  readonly listWorktrees: (
    checkout: CheckoutTarget,
  ) => Effect.Effect<CommandOutput<'listWorktrees'>, EditorFailure>;
  /** Creates a branch from `base` in a new linked worktree, then opens and selects it. */
  readonly createWorktree: (
    input: CommandInput<'createWorktree'>,
  ) => Effect.Effect<CheckoutTarget, EditorFailure>;
  /**
   * Runs `git init` in an open plain-folder checkout, then rebinds it, with its tabs and drafts,
   * to the Git checkout that results and selects it. Until then the checkout refuses saves and
   * file operations, and recovery edits wait; edits continue and move with the rebind.
   */
  readonly initializeRepository: (
    checkout: CheckoutTarget,
  ) => Effect.Effect<CheckoutTarget, EditorFailure>;
};

/** The checkouts the editor has open: opening, selecting, worktrees and `git init`. */
export class EditorCheckouts extends Context.Service<EditorCheckouts, EditorCheckoutsShape>()(
  'moonbase/editor/EditorCheckouts',
) {
  static readonly layer = Layer.effect(
    EditorCheckouts,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      const session = yield* EditorSession;
      const alerts = yield* EditorAlerts;
      const views = yield* EditorViews;
      const buffers = yield* EditorBuffers;
      const discovery = yield* EditorDiscovery;
      const operations = yield* EditorOperations;
      const outbox = yield* RecoveryOutbox;
      const recovery = yield* RecoverySync;
      const tabs = yield* EditorTabs;
      const tree = yield* EditorTree;
      const admitted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        session.run(Effect.andThen(session.admit, effect));
      const closing = Effect.map(session.get, (s) => s.closing);
      const isOpen = (checkout: CheckoutTarget) =>
        Effect.map(views.get, ({ recovery }) =>
          recovery.openCheckoutIds.includes(checkout.checkoutId),
        );
      const reported = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.tapError(alerts.report));

      const selectOpenCheckout = (target: CheckoutTarget) =>
        Effect.gen(function* () {
          yield* views.view(target);
          yield* tabs.cancelActivation;
          yield* views.modify(({ recovery }) => {
            recovery.selectedCheckoutId = target.checkoutId;
          });
          yield* outbox.changed;
          return yield* tabs.activateSelected;
        });

      const assertRebindable = (checkout: CheckoutTarget) =>
        Effect.gen(function* () {
          const busy =
            (yield* session.get).preserving ||
            [...(yield* buffers.get).buffers.values()].some(
              (buffer) => sameCheckout(buffer.target.checkout, checkout) && isSaving(buffer),
            ) ||
            [...(yield* operations.get).values()].some(
              (known) => !known.acknowledged && sameCheckout(known.result.checkout, checkout),
            );
          if (busy) return yield* new EditorError({ reason: 'rebind-busy' });
        });

      /**
       * Moves a checkout's views, tabs, buffers and recents to the target it became; the next
       * layout relists it in the store, whose buffers then follow under the same checkout ID.
       */
      const moveCheckout = (previous: CheckoutTarget, next: CheckoutTarget) =>
        Effect.gen(function* () {
          const rebind = <T extends { checkout: CheckoutTarget }>(item: T): T =>
            sameCheckout(item.checkout, previous) ? { ...item, checkout: next } : item;
          yield* views.modify((draft) => {
            draft.recovery.checkouts = draft.recovery.checkouts.map((item) =>
              sameCheckout(item, previous) ? next : item,
            );
            draft.recovery.recentFiles = draft.recovery.recentFiles.map(rebind);
            draft.closed = rebindClosed(draft.closed, previous, next);
          });
          yield* buffers.modify((d) => {
            // oxlint-disable-next-line no-useless-spread -- Rebinding reinserts tabs; visit each once.
            for (const [key, tab] of [...d.tabs])
              if (sameCheckout(tab.target.checkout, previous)) {
                d.tabs.delete(key);
                tab.target = rebind(tab.target);
                d.tabs.set(fileKey(tab.target), tab);
              }
            // oxlint-disable-next-line no-useless-spread -- Rebinding reinserts buffers; visit each once.
            for (const [key, buffer] of [...d.buffers])
              if (sameCheckout(buffer.target.checkout, previous)) {
                d.buffers.delete(key);
                buffer.target = rebind(buffer.target);
                d.buffers.set(fileKey(buffer.target), buffer);
              }
          });
          // Listings, comparisons and Git status are read again for the new target.
          yield* discovery.update((s) => forgetCheckout(s, previous));
          yield* outbox.changed;
        });

      const addCheckout = (target: CheckoutTarget): Effect.Effect<CheckoutTarget, EditorFailure> =>
        Effect.gen(function* () {
          if (yield* closing) return target;
          const { recovery: known } = yield* views.get;
          const collision = known.checkouts.find(
            (item) => item.checkoutId === target.checkoutId && !sameCheckout(item, target),
          );
          // A plain folder that became a repository keeps its tabs and drafts as the Git checkout.
          if (collision && isInitialized(collision, target)) {
            yield* assertRebindable(collision);
            const open = yield* isOpen(collision);
            yield* discovery.release(collision);
            yield* moveCheckout(collision, target);
            if (open) yield* tree.observe(target);
          } else if (collision) return yield* new EditorError({ reason: 'checkout-identity' });
          const reopening = yield* views.modify(({ recovery }) => {
            if (!isCheckoutListed(recovery, target)) {
              recovery.checkouts.push(target);
              recovery.views.set(target.checkoutId, emptyCheckoutView());
            }
            const reopening = !recovery.openCheckoutIds.includes(target.checkoutId);
            if (reopening) recovery.openCheckoutIds.push(target.checkoutId);
            return reopening;
          });
          if (reopening) yield* tree.observe(target);
          else yield* tree.rewatchLost(target);
          yield* selectOpenCheckout(target);
          yield* tree.refreshCheckout(target);
          return target;
        });

      /** The repository a plain folder became, when `git init` ran but its reply was lost. */
      const findInitialized = (checkout: CheckoutTarget) =>
        reported(workspace.openCheckout({ root: checkout.root })).pipe(
          Effect.map((reopened) => (isInitialized(checkout, reopened) ? reopened : undefined)),
          Effect.orElseSucceed(() => undefined),
        );

      /**
       * After `git init`, the folder target is no longer approved: whatever stopped the rebind,
       * move the checkout's work to the repository and watch it there rather than strand it.
       */
      const settleInitialization = (previous: CheckoutTarget, next: CheckoutTarget) =>
        Effect.gen(function* () {
          if (isCheckoutListed((yield* views.get).recovery, previous))
            yield* moveCheckout(previous, next);
          if (yield* isOpen(next)) {
            yield* discovery.release(next);
            yield* tree.observe(next);
          }
        });

      const initializeRepository = (checkout: CheckoutTarget) =>
        Effect.gen(function* () {
          yield* session.assertReady;
          yield* views.view(checkout);
          if (checkout.vcs !== 'none')
            return yield* new EditorError({ reason: 'already-repository' });
          if ((yield* session.get).initializing)
            return yield* new EditorError({ reason: 'initializing-already' });
          yield* assertRebindable(checkout);
          // The folder's approval ends with `git init`: send the edits while it holds.
          yield* recovery.send;
          yield* session.beginInitialization(checkout.checkoutId);
          const outcome = yield* Effect.gen(function* () {
            // End the folder's reads.
            yield* discovery.release(checkout);
            const replied = yield* Effect.exit(
              Effect.flatMap(workspace.initializeRepository({ checkout }), (initialized) =>
                isInitialized(checkout, initialized)
                  ? Effect.succeed(initialized)
                  : Effect.fail(new EditorError({ reason: 'initializing-other' })),
              ),
            );
            let initialized: CheckoutTarget;
            if (Exit.isSuccess(replied)) initialized = replied.value;
            else {
              // A failed or lost reply may follow a `git init` that ran: the folder then opens as
              // its repository, and moves there as if the reply had arrived.
              const reopened = (yield* closing) ? undefined : yield* findInitialized(checkout);
              if (!reopened) {
                const failure = replied.cause.reasons.find((reason) => reason._tag === 'Fail');
                if (failure) yield* alerts.report(failure.error);
                if (!(yield* closing) && (yield* isOpen(checkout))) yield* tree.observe(checkout);
                return yield* Effect.failCause(replied.cause);
              }
              initialized = reopened;
            }
            const added = yield* Effect.exit(addCheckout(initialized));
            if (Exit.isSuccess(added)) return { target: added.value, failure: undefined };
            if (yield* closing) return yield* Effect.failCause(added.cause);
            yield* settleInitialization(checkout, initialized);
            const reason = added.cause.reasons.find((item) => item._tag === 'Fail');
            return {
              target: undefined,
              failure: new EditorError({
                reason: 'initializing-unfinished',
                detail: reason ? describeEditorFailure(reason.error) : undefined,
              }),
            };
          }).pipe(Effect.ensuring(session.endInitialization));
          // Edits made meanwhile are sent now, under the Git target.
          const modes = yield* session.get;
          if (!modes.closing && !modes.preserving) {
            if (outcome.failure) yield* Effect.catch(recovery.flush, alerts.report);
            else yield* recovery.flush;
          }
          if (outcome.failure) return yield* outcome.failure;
          if (!outcome.target) return yield* new EditorError({ reason: 'closed' });
          return outcome.target;
        });

      return {
        openCheckout: (root) =>
          admitted(
            Effect.gen(function* () {
              yield* session.assertReady;
              const target = yield* reported(workspace.openCheckout({ root }));
              if ((yield* session.get).initializing === target.checkoutId)
                return yield* new EditorError({ reason: 'initializing' });
              return yield* addCheckout(target);
            }),
          ),
        selectCheckout: (target) => admitted(selectOpenCheckout(target)),
        listWorktrees: (checkout) =>
          admitted(
            Effect.andThen(views.view(checkout), reported(workspace.listWorktrees({ checkout }))),
          ),
        createWorktree: (input) =>
          admitted(
            Effect.gen(function* () {
              yield* session.assertReady;
              yield* views.view(input.checkout);
              return yield* addCheckout(yield* reported(workspace.createWorktree(input)));
            }),
          ),
        initializeRepository: (checkout) => admitted(initializeRepository(checkout)),
      } satisfies EditorCheckoutsShape;
    }),
  );
}
