import { Context, Effect, Exit, Fiber, FiberHandle, Layer, Option, SubscriptionRef } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import { getParentPath } from '@moonbase/contracts/paths';
import {
  maximumFileBytes,
  type CheckoutTarget,
  type Comparison,
  type EditorPosition,
  type FileDocument,
  type FileTarget,
  type FileView,
} from '@moonbase/contracts/workspace';
import { EditorError, type EditorFailure } from '../editor-errors.ts';
import { isRelativePath } from '../relative-path.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorAlerts } from '../alerts/alerts-service.ts';
import { EditorViews } from '../views/views-service.ts';
import { isCheckoutOpen } from '../views/views.ts';
import { EditorBuffers } from '../buffers/buffers-service.ts';
import { isClean, isDirty, newBuffer } from '../buffers/buffers.ts';
import { EditorDiscovery } from '../discovery/discovery-service.ts';
import { RecoveryOutbox } from '../recovery/recovery-outbox-service.ts';
import { fileKey } from '../recovery/recovery-references.ts';
import { conflictComparison, placeOpenedFile, type OpenOptions } from './tabs.ts';

export type { OpenOptions };

export type EditorTabsShape = {
  /**
   * Opens a file as the active tab, reading it from disk (or its comparison), or `intent:
   * 'preview'` in the checkout's one preview tab. Succeeds false when it was superseded by a newer
   * open or selection, when `current` turned false, or when the file couldn't be read.
   */
  readonly open: (
    target: FileTarget,
    options?: OpenOptions,
  ) => Effect.Effect<boolean, EditorFailure>;
  /** `open` for an action already admitted. */
  readonly openFile: (
    target: FileTarget,
    options?: OpenOptions,
  ) => Effect.Effect<boolean, EditorFailure>;
  /** Opens the selected checkout's active file if it isn't shown as its view asks. */
  readonly activateSelected: Effect.Effect<boolean, EditorFailure>;
  /** Cancels any running open, as a newer selection or a preservation does. */
  readonly cancelActivation: Effect.Effect<void>;
  /** Runs `read` as the activation unless an open runs; succeeds whether it ran to completion. */
  readonly whileIdle: (read: Effect.Effect<void>) => Effect.Effect<void>;
  readonly navigate: (
    checkout: CheckoutTarget,
    direction: 1 | -1,
  ) => Effect.Effect<boolean, EditorFailure>;
  readonly edit: (target: FileTarget, text: string) => Effect.Effect<void, EditorFailure>;
  /** Keeps a preview tab open as an ordinary tab. */
  readonly keepOpen: (target: FileTarget) => Effect.Effect<void, EditorFailure>;
  readonly reorder: (
    checkout: CheckoutTarget,
    from: string,
    to: number,
  ) => Effect.Effect<void, EditorFailure>;
  readonly position: (
    target: FileTarget,
    mode: FileView | `${FileView}:original`,
    position: EditorPosition,
  ) => Effect.Effect<void>;
  /**
   * Holds the editor for a close or reload: no open runs and edits are refused until `work`
   * ends; then the selected file is shown again and the edits made meanwhile are sent. While
   * another close or reload holds it, `work` doesn't run and this is false.
   */
  readonly whilePreserving: <E, R>(
    work: Effect.Effect<boolean, E, R>,
  ) => Effect.Effect<boolean, E, R>;
};

/** Opening, arranging and editing the tabs of the editor's checkouts. */
export class EditorTabs extends Context.Service<EditorTabs, EditorTabsShape>()(
  'moonbase/editor/EditorTabs',
) {
  static readonly layer = Layer.effect(
    EditorTabs,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      const session = yield* EditorSession;
      const alerts = yield* EditorAlerts;
      const views = yield* EditorViews;
      const buffers = yield* EditorBuffers;
      const discovery = yield* EditorDiscovery;
      const outbox = yield* RecoveryOutbox;
      const activation = yield* FiberHandle.make<boolean, never>();
      const admitted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        session.run(Effect.andThen(session.admit, effect));

      /** Whether the file's folder lists in full without it: a failed read found nothing there. */
      const isMissing = (target: FileTarget) =>
        discovery
          .read(
            target.checkout,
            workspace.listDirectory({
              checkout: target.checkout,
              path: getParentPath(target.path),
              includeIgnoredStatus: false,
            }),
            false,
          )
          .pipe(
            // A listing cut short or with an error doesn't show the file is gone.
            Effect.map(
              (listing) =>
                !listing.partial &&
                !listing.error &&
                !listing.entries.some((entry) => entry.path === target.path),
            ),
            Effect.orElseSucceed(() => false),
          );

      const read = (target: FileTarget, mode: FileView, isCurrent: Effect.Effect<boolean>) =>
        Effect.gen(function* () {
          const key = fileKey(target);
          const hasBuffer = Effect.map(buffers.find(target), (buffer) => !!buffer);
          if (mode === 'file' || mode === 'conflict') {
            const disk = yield* Effect.exit(
              discovery.read(target.checkout, workspace.readFile(target)),
            );
            if (Exit.isSuccess(disk))
              return { disk: disk.value as FileDocument | null, comparison: undefined };
            if (!(yield* isCurrent) || !(yield* hasBuffer))
              return yield* Effect.failCause(disk.cause);
            yield* alerts.report(new EditorError({ reason: 'file-unavailable' }));
            // A missing file is created by its Save, which never replaces one that exists after
            // all. One there but unreadable now (permissions, a passing failure) saves over.
            const missing = yield* isMissing(target);
            const buffer = yield* buffers.find(target);
            if (missing && buffer && (yield* isCurrent))
              yield* buffers.updateBuffer(buffer.id, (b) => {
                b.newFile = true;
              });
            return { disk: null, comparison: undefined };
          }
          const comparison = yield* Effect.exit(
            discovery.read(target.checkout, workspace.readComparison({ target, area: mode })),
          );
          if (Exit.isSuccess(comparison))
            return { disk: comparison.value.working ?? null, comparison: comparison.value };
          if (!(yield* isCurrent) || !(yield* hasBuffer))
            return yield* Effect.failCause(comparison.cause);
          yield* alerts.report(new EditorError({ reason: 'comparison-unavailable' }));
          return {
            disk: null,
            comparison: (yield* discovery.get).comparisons[key] as Comparison | undefined,
          };
        });

      const showOpened = (
        target: FileTarget,
        mode: FileView,
        options: OpenOptions,
        disk: FileDocument | null,
        comparison: Comparison | undefined,
      ) =>
        Effect.gen(function* () {
          const key = fileKey(target);
          yield* buffers.modify((d) => {
            let buffer = d.buffers.get(key);
            if (buffer && disk && mode === 'file') buffer.newFile = undefined;
            if (!buffer && disk) {
              buffer = newBuffer(target, disk);
              d.buffers.set(key, buffer);
            } else if (buffer && disk && isClean(buffer)) {
              buffer.disk = disk;
              buffer.text = disk.text;
            }
            if (buffer && disk && buffer.disk.version !== disk.version) buffer.conflict = disk;
          });
          const known = (yield* discovery.get).comparisons[key];
          let shown = comparison;
          if (mode === 'conflict') shown = disk ? conflictComparison(disk) : known;
          yield* discovery.update((s) => {
            const comparisons = { ...s.comparisons },
              comparisonAttempts = { ...s.comparisonAttempts };
            if (mode === 'file') delete comparisonAttempts[key];
            else comparisonAttempts[key] = { mode };
            if (shown) comparisons[key] = shown;
            else delete comparisons[key];
            return { ...s, comparisons, comparisonAttempts };
          });
          // The host's text says why; it reaches the UI only as fixed text.
          if (shown?.error) yield* alerts.report(new EditorError({ reason: 'host-reported' }));
          const held = yield* buffers.get;
          const opened = held.buffers.get(key);
          const placed = yield* views.modify(({ recovery }) => {
            const selected = recovery.views.get(target.checkout.checkoutId)!;
            const placed = placeOpenedFile(
              selected,
              target.path,
              options.intent,
              (path) => {
                const old = held.buffers.get(fileKey({ checkout: target.checkout, path }));
                return !old || isClean(old);
              },
              !opened || !isDirty(opened),
            );
            selected.fileViews.set(target.path, mode);
            recovery.selectedCheckoutId = target.checkout.checkoutId;
            recovery.recentFiles = [
              target,
              ...recovery.recentFiles.filter((item) => fileKey(item) !== key),
            ].slice(0, 100);
            return placed;
          });
          if (placed.closedPreview !== undefined) {
            const previous = { checkout: target.checkout, path: placed.closedPreview };
            yield* buffers.closeTab(previous);
            yield* buffers.forget([fileKey(previous)]);
          }
          if (placed.opened) yield* buffers.openTab(target);
          yield* outbox.changed;
        });

      const openFile: EditorTabsShape['openFile'] = (target, options = {}) =>
        Effect.gen(function* () {
          const selected = yield* views.view(target.checkout);
          if (!isRelativePath(target.path))
            return yield* new EditorError({ reason: 'invalid-path' });
          if ((yield* session.get).preserving) return false;
          const key = fileKey(target),
            mode = options.view ?? selected.fileViews.get(target.path) ?? 'file';
          const isCurrent = Effect.map(
            Effect.all([session.get, views.get]),
            ([{ closing, preserving }, { recovery }]) =>
              !closing &&
              !preserving &&
              (options.current?.() ?? true) &&
              isCheckoutOpen(recovery, target.checkout),
          );
          const work = Effect.gen(function* () {
            const opened = yield* Effect.exit(read(target, mode, isCurrent));
            if (Exit.isFailure(opened)) {
              if ((yield* isCurrent) && mode !== 'file') {
                const working = (yield* discovery.get).comparisons[key]?.working?.version;
                yield* discovery.update((s) => ({
                  ...s,
                  comparisonAttempts: {
                    ...s.comparisonAttempts,
                    [key]: { mode, failedWorkingVersion: working },
                  },
                }));
              }
              return false;
            }
            if (!(yield* isCurrent)) return false;
            yield* showOpened(target, mode, options, opened.value.disk, opened.value.comparison);
            return true;
          }).pipe(Effect.catchCause(() => Effect.succeed(false)));
          const fiber = yield* FiberHandle.run(activation)(work);
          const exit = yield* Fiber.await(fiber);
          return Exit.isSuccess(exit) ? exit.value : false;
        });

      const activateSelected: Effect.Effect<boolean, EditorFailure> = Effect.gen(function* () {
        const { closing, preserving } = yield* session.get;
        if (closing || preserving) return false;
        const { recovery } = yield* views.get;
        const checkout = recovery.checkouts.find(
          (target) => target.checkoutId === recovery.selectedCheckoutId,
        );
        if (!checkout) {
          yield* FiberHandle.clear(activation);
          return true;
        }
        const path = recovery.views.get(checkout.checkoutId)?.active;
        if (!path) return true;
        const target = { checkout, path },
          key = fileKey(target),
          mode = (yield* views.view(checkout)).fileViews.get(path) ?? 'file';
        const { comparisons, comparisonAttempts } = yield* discovery.get;
        const attempt = comparisonAttempts[key],
          working = comparisons[key]?.working,
          hasBuffer = !!(yield* buffers.find(target));
        // A failed activation stays settled for that working version, not future availability.
        const needsWorking =
          !hasBuffer && working != null && working.version !== attempt?.failedWorkingVersion;
        if (mode === 'file' ? hasBuffer : attempt?.mode === mode && !needsWorking) return true;
        return yield* openFile(target, {
          current: () => {
            const { recovery } = SubscriptionRef.getUnsafe(views.state);
            return (
              recovery.selectedCheckoutId === checkout.checkoutId &&
              recovery.views.get(checkout.checkoutId)?.active === path
            );
          },
        });
      });

      const keepOpen = (target: FileTarget) =>
        Effect.gen(function* () {
          const view = yield* views.view(target.checkout);
          if (view.preview !== target.path) return;
          yield* views.modify(({ recovery }) => {
            recovery.views.get(target.checkout.checkoutId)!.preview = null;
          });
          yield* outbox.changed;
        });

      return {
        open: (target, options = {}) =>
          admitted(
            Effect.gen(function* () {
              // The folder's reads end during `git init`: open the file once it is the repository.
              if ((yield* session.get).initializing === target.checkout.checkoutId) {
                yield* session.awaitInitialization;
                const { recovery } = yield* views.get;
                const checkout = recovery.checkouts.find(
                  (item) => item.checkoutId === target.checkout.checkoutId,
                );
                if (!checkout || (yield* session.get).closing) return false;
                return yield* openFile({ ...target, checkout }, options);
              }
              return yield* openFile(target, options);
            }),
          ),
        openFile,
        activateSelected,
        cancelActivation: FiberHandle.clear(activation),
        whileIdle: (work) =>
          Effect.gen(function* () {
            if (Option.isSome(yield* FiberHandle.get(activation))) return;
            const fiber = yield* FiberHandle.run(activation)(Effect.as(work, true));
            yield* Fiber.await(fiber);
          }),
        navigate: (checkout, direction) =>
          admitted(
            Effect.gen(function* () {
              const selected = yield* views.view(checkout),
                paths = selected.openFiles;
              if (!paths.length) return false;
              const next =
                (paths.indexOf(selected.active) + direction + paths.length) % paths.length;
              return yield* openFile({ checkout, path: paths[next] });
            }),
          ),
        edit: (target, text) =>
          admitted(
            Effect.gen(function* () {
              yield* views.view(target.checkout);
              if (!isRelativePath(target.path))
                return yield* new EditorError({ reason: 'invalid-path' });
              if ((yield* session.get).preserving)
                return yield* new EditorError({ reason: 'preserving' });
              if (new TextEncoder().encode(text).length > maximumFileBytes)
                return yield* new EditorError({ reason: 'text-too-large' });
              const buffer = yield* buffers.find(target);
              if (!buffer) return yield* new EditorError({ reason: 'not-open' });
              yield* buffers.updateBuffer(buffer.id, (b) => {
                b.text = text;
              });
              yield* buffers.sendDraft(target);
              if (text !== buffer.disk.text) yield* keepOpen(target);
              yield* outbox.changed;
            }),
          ),
        keepOpen: (target) => admitted(keepOpen(target)),
        reorder: (checkout, from, to) =>
          admitted(
            Effect.gen(function* () {
              const selected = yield* views.view(checkout);
              if ((yield* session.get).preserving || !selected.openFiles.includes(from)) return;
              yield* views.modify(({ recovery }) => {
                const view = recovery.views.get(checkout.checkoutId)!;
                view.openFiles.splice(view.openFiles.indexOf(from), 1);
                view.openFiles.splice(Math.max(0, Math.min(to, view.openFiles.length)), 0, from);
              });
              yield* keepOpen({ checkout, path: from });
              yield* outbox.changed;
            }),
          ),
        position: (target, mode, position) =>
          Effect.gen(function* () {
            const { admissionsOpen, closing, preserving } = yield* session.get;
            if (!admissionsOpen || closing || preserving) return;
            const changed = yield* views.modify(({ recovery }) => {
              if (!isCheckoutOpen(recovery, target.checkout)) return false;
              const selected = recovery.views.get(target.checkout.checkoutId);
              if (!selected?.openFiles.includes(target.path)) return false;
              const positions = selected.positions.get(target.path) ?? {};
              positions[mode] = position;
              selected.positions.set(target.path, positions);
              return true;
            });
            if (changed) yield* outbox.changed;
          }),
        whilePreserving: (work) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              // Checking the gate and taking it are one step, and only its owner releases it.
              const owner = yield* SubscriptionRef.modify(session.state, (s) =>
                s.preserving ? [false, s] : [true, { ...s, preserving: true }],
              );
              if (!owner) return false;
              return yield* restore(Effect.andThen(FiberHandle.clear(activation), work)).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    if ((yield* session.get).closing) return;
                    yield* session.update((s) => ({ ...s, preserving: false }));
                    yield* Effect.catch(activateSelected, alerts.report);
                    yield* outbox.schedule;
                  }),
                ),
              );
            }),
          ),
      } satisfies EditorTabsShape;
    }),
  );
}
