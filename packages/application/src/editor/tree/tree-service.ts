import {
  Context,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FiberSet,
  Layer,
  Scope,
  SubscriptionRef,
} from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import { getParentPath } from '@moonbase/contracts/paths';
import type {
  CheckoutTarget,
  CheckoutTree,
  DirectoryEntry,
  DirectoryListing,
  FileTarget,
} from '@moonbase/contracts/workspace';
import { awaitForCaller } from '../await-for-caller.ts';
import { EditorError, type EditorFailure } from '../editor-errors.ts';
import { isRelativePath } from '../relative-path.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorAlerts } from '../alerts/alerts-service.ts';
import { EditorViews } from '../views/views-service.ts';
import { isCheckoutOpen } from '../views/views.ts';
import { EditorBuffers } from '../buffers/buffers-service.ts';
import { isClean } from '../buffers/buffers.ts';
import { EditorDiscovery } from '../discovery/discovery-service.ts';
import { listingKey } from '../discovery/discovery.ts';
import { RecoveryOutbox } from '../recovery/recovery-outbox-service.ts';
import { RecoverySync } from '../recovery/recovery-sync-service.ts';
import { checkoutKey, fileKey } from '../recovery/recovery-references.ts';
import { EditorTabs } from '../tabs/tabs-service.ts';
import { clampSidebarWidth, listLevels, type RevealOptions } from './tree.ts';

export type EditorTreeShape = {
  readonly tree: (
    checkout: CheckoutTarget,
    patch: Partial<CheckoutTree>,
  ) => Effect.Effect<void, EditorFailure>;
  /** `tree` for an action already admitted. */
  readonly updateTree: (
    checkout: CheckoutTarget,
    patch: Partial<CheckoutTree>,
  ) => Effect.Effect<void, EditorFailure>;
  readonly resizeSidebar: (width: number) => Effect.Effect<void>;
  /** Sets whether the files trees reveal the file made active, saved with the recovery. */
  readonly setFollowActiveFile: (follow: boolean) => Effect.Effect<void>;
  readonly list: (
    checkout: CheckoutTarget,
    path?: string,
  ) => Effect.Effect<DirectoryListing, EditorFailure>;
  /**
   * Shows a file in its checkout's tree: expands the folders above it, then focuses and selects
   * it. Levels already listed (the watcher keeps them fresh) are not listed again. While Hide
   * Ignored Files is on, a Git-ignored file (or one in an ignored folder) turns it off, or with
   * `ignored: 'skip'` is left unrevealed; only levels Git hasn't classified yet are asked about. A
   * newer reveal in the same checkout cancels this one, and it, closing the checkout or interrupting
   * it abandons it before it changes the tree. Succeeds whether the file was revealed.
   */
  readonly reveal: (
    target: FileTarget,
    options?: RevealOptions,
  ) => Effect.Effect<boolean, EditorFailure>;
  /** Cancels a checkout's running reveal, if any. */
  readonly endReveal: (checkout: CheckoutTarget) => Effect.Effect<void>;
  /** Watches a checkout's watch again if it gave up, then reads it again. */
  readonly refresh: (checkout: CheckoutTarget) => Effect.Effect<void, EditorFailure>;
  /** Reads a checkout's listings, Git status and comparison again. */
  readonly refreshCheckout: (checkout: CheckoutTarget) => Effect.Effect<void, EditorFailure>;
  /** Watches a checkout: each change reconciles recovery and reads the checkout again. */
  readonly observe: (checkout: CheckoutTarget) => Effect.Effect<void>;
  /** Watches an open checkout again once its watch gave up, so live updates return. */
  readonly rewatchLost: (checkout: CheckoutTarget) => Effect.Effect<void>;
};

/** The files tree of each checkout: its folders, reveal, refresh and watch. */
export class EditorTree extends Context.Service<EditorTree, EditorTreeShape>()(
  'moonbase/editor/EditorTree',
) {
  static readonly layer = Layer.effect(
    EditorTree,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      const session = yield* EditorSession;
      const alerts = yield* EditorAlerts;
      const views = yield* EditorViews;
      const buffers = yield* EditorBuffers;
      const discovery = yield* EditorDiscovery;
      const outbox = yield* RecoveryOutbox;
      const recovery = yield* RecoverySync;
      const tabs = yield* EditorTabs;
      // Owned by the session: closing the editor interrupts reveals and background refreshes.
      const reveals = yield* Scope.provide(
        FiberMap.make<string, boolean, EditorFailure>(),
        session.scope,
      );
      const background = yield* Scope.provide(FiberSet.make(), session.scope);
      const isOpen = (checkout: CheckoutTarget) =>
        Effect.map(views.get, ({ recovery }) =>
          recovery.openCheckoutIds.includes(checkout.checkoutId),
        );

      const updateTree: EditorTreeShape['updateTree'] = (checkout, patch) =>
        Effect.gen(function* () {
          yield* views.view(checkout);
          yield* views.modify(({ recovery }) => {
            const view = recovery.views.get(checkout.checkoutId)!;
            view.tree = { ...view.tree, ...patch };
          });
          yield* outbox.changed;
        });

      const refreshCheckout: EditorTreeShape['refreshCheckout'] = (checkout) =>
        Effect.gen(function* () {
          yield* views.view(checkout);
          yield* discovery.refresh(checkout, {
            isCurrent: isOpen(checkout),
            refreshListings: Effect.gen(function* () {
              const view = yield* views.view(checkout);
              yield* Effect.all(
                ['', ...view.tree.expanded].map((path) =>
                  Effect.exit(discovery.list(checkout, path)),
                ),
                { concurrency: 'unbounded' },
              );
            }).pipe(Effect.ignore),
            refreshComparison: Effect.gen(function* () {
              const selected = yield* views.view(checkout),
                mode = selected.fileViews.get(selected.active);
              if (
                !selected.active ||
                !mode ||
                mode === 'file' ||
                mode === 'conflict' ||
                (yield* session.get).preserving
              )
                return;
              const target = { checkout, path: selected.active },
                key = fileKey(target);
              const stillShown = Effect.map(
                Effect.all([session.get, views.get]),
                ([{ preserving }, { recovery }]) => {
                  const view = recovery.views.get(checkout.checkoutId);
                  return (
                    !preserving &&
                    recovery.openCheckoutIds.includes(checkout.checkoutId) &&
                    view?.active === target.path &&
                    view.fileViews.get(target.path) === mode
                  );
                },
              );
              // Activating replaces the idle read in the activation handle, so it follows the read.
              let activate = false;
              yield* tabs.whileIdle(
                Effect.gen(function* () {
                  const comparison = yield* workspace.readComparison({ target, area: mode });
                  if (!(yield* stillShown)) return;
                  yield* discovery.update((s) => ({
                    ...s,
                    comparisons: { ...s.comparisons, [key]: comparison },
                    comparisonAttempts: { ...s.comparisonAttempts, [key]: { mode } },
                  }));
                  const buffer = yield* buffers.find(target);
                  const working = comparison.working;
                  if (buffer && working && isClean(buffer))
                    yield* buffers.updateBuffer(buffer.id, (b) => {
                      b.disk = working;
                      b.text = working.text;
                    });
                  else if (
                    !buffer &&
                    working &&
                    (yield* views.get).recovery.selectedCheckoutId === checkout.checkoutId
                  )
                    activate = true;
                }).pipe(
                  // A failed refresh retains the last comparison and current edits.
                  Effect.ignore,
                ),
              );
              if (activate) yield* tabs.activateSelected;
            }).pipe(Effect.ignore),
          });
        });

      const observe: EditorTreeShape['observe'] = (checkout) =>
        discovery.observe(checkout, {
          isOpen: isOpen(checkout),
          onChanged: (isCurrent) =>
            Effect.andThen(
              FiberSet.run(background)(Effect.catch(recovery.reconcile(), alerts.report)),
              FiberSet.run(background)(
                refreshCheckout(checkout).pipe(
                  Effect.catch((error) =>
                    Effect.flatMap(isCurrent, (current) =>
                      current ? alerts.report(error) : Effect.void,
                    ),
                  ),
                ),
              ),
            ).pipe(Effect.asVoid),
        });

      const rewatchLost: EditorTreeShape['rewatchLost'] = (checkout) =>
        Effect.gen(function* () {
          if (!(yield* discovery.isWatchLost(checkout)) || !(yield* isOpen(checkout))) return;
          yield* observe(checkout);
        });

      const reveal: EditorTreeShape['reveal'] = (target, options = {}) =>
        session.runWithCaller(
          Effect.gen(function* () {
            yield* session.admit;
            yield* views.view(target.checkout);
            if (!isRelativePath(target.path))
              return yield* new EditorError({ reason: 'invalid-path' });
            const checkout = target.checkout,
              report = !options.quiet;
            const isCurrent = Effect.map(views.get, ({ recovery }) =>
              isCheckoutOpen(recovery, checkout),
            );
            const findListed = (path: string) =>
              SubscriptionRef.getUnsafe(discovery.state).listings[
                listingKey(checkout, getParentPath(path))
              ]?.entries.find((entry) => entry.path === path);
            const levels = listLevels(target.path);
            const work = Effect.gen(function* () {
              const entries: DirectoryEntry[] = [];
              for (const path of levels) {
                let entry = findListed(path);
                if (!entry) {
                  const listing = yield* discovery.list(checkout, getParentPath(path), report);
                  if (!(yield* isCurrent)) return false;
                  entry = findListed(path) ?? listing.entries.find((item) => item.path === path);
                  if (!entry) return yield* new EditorError({ reason: 'reveal-unavailable' });
                }
                entries.push(entry);
              }
              let showIgnored = false;
              if ((yield* views.view(checkout)).tree.hideIgnoredFiles) {
                let ignored = entries.some((entry) => entry.ignored);
                const unclassified = ignored
                  ? []
                  : levels.filter((_, index) => entries[index].ignored === undefined);
                if (unclassified.length) {
                  const answers = yield* Effect.all(
                    unclassified.map((path) =>
                      workspace
                        .getIgnoredPaths({ checkout, path: getParentPath(path), paths: [path] })
                        .pipe(
                          Effect.tapError((error) => (report ? alerts.report(error) : Effect.void)),
                        ),
                    ),
                    { concurrency: 'unbounded' },
                  );
                  if (!(yield* isCurrent)) return false;
                  ignored = answers.some((answer) => answer.paths.length > 0);
                }
                if (ignored) {
                  if (options.ignored === 'skip') return false;
                  showIgnored = true;
                }
              }
              if (!(yield* isCurrent)) return false;
              const tree = (yield* views.view(checkout)).tree;
              yield* updateTree(checkout, {
                expanded: [...new Set([...tree.expanded, ...levels.slice(0, -1)])],
                focus: target.path,
                selected: [target.path],
                ...(showIgnored ? { hideIgnoredFiles: false } : {}),
              });
              return true;
            }).pipe(
              // A reveal closed or no longer wanted is abandoned, whatever its work met.
              Effect.catch((error) =>
                Effect.flatMap(isCurrent, (current) =>
                  current ? Effect.fail(error) : Effect.succeed(false),
                ),
              ),
            );
            const exit = yield* awaitForCaller(
              FiberMap.run(reveals, checkoutKey(checkout))(work),
              Fiber.await,
            );
            if (Exit.isSuccess(exit)) return exit.value;
            // A newer reveal in the checkout replaced this one.
            if (!Exit.hasFails(exit)) return false;
            return yield* exit;
          }),
        );

      return {
        tree: (checkout, patch) => session.admitted(updateTree(checkout, patch)),
        updateTree,
        resizeSidebar: (width) =>
          Effect.gen(function* () {
            if (!(yield* session.admits)) return;
            yield* views.modify(({ recovery }) => {
              recovery.sidebarWidth = clampSidebarWidth(width);
            });
            yield* outbox.changed;
          }),
        setFollowActiveFile: (follow) =>
          Effect.gen(function* () {
            if (!(yield* session.admits)) return;
            yield* views.modify(({ recovery }) => {
              recovery.followActiveFile = follow;
            });
            yield* outbox.changed;
          }),
        list: (checkout, path = '') => session.admitted(discovery.list(checkout, path)),
        reveal,
        endReveal: (checkout) => FiberMap.remove(reveals, checkoutKey(checkout)),
        refresh: (checkout) =>
          session.admitted(Effect.andThen(rewatchLost(checkout), refreshCheckout(checkout))),
        refreshCheckout,
        observe,
        rewatchLost,
      } satisfies EditorTreeShape;
    }),
  );
}
