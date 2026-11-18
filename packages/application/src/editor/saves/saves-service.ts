import { Context, Effect, Layer } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import type { FileTarget, FileView } from '@moonbase/contracts/workspace';
import { readOwn, writeOwn } from '../record.ts';
import { EditorError, isRefusal, type EditorFailure } from '../editor-errors.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorAlerts } from '../alerts/alerts-service.ts';
import { EditorViews } from '../views/views-service.ts';
import { EditorBuffers } from '../buffers/buffers-service.ts';
import type { EditorBuffer } from '../buffers/buffers.ts';
import { EditorDiscovery } from '../discovery/discovery-service.ts';
import { EditorOperations } from '../operations/operations-service.ts';
import { RecoveryOutbox } from '../recovery/recovery-outbox-service.ts';
import { RecoverySync } from '../recovery/recovery-sync-service.ts';
import { fileKey } from '../keys.ts';
import { EditorTabs } from '../tabs/tabs-service.ts';
import { conflictComparison } from '../tabs/tabs.ts';
import { EditorMutations } from '../mutation/mutation-service.ts';
import { makeSaveRequest } from './saves.ts';

export type EditorSavesShape = {
  /**
   * Saves a buffer: succeeds true once its text is on disk and recovery holds the outcome. A
   * conflict, a save whose recovery is uncertain or a refusal succeeds false, with the reason
   * reported; edits are kept either way.
   */
  readonly save: (target: FileTarget, overwrite?: boolean) => Effect.Effect<boolean, EditorFailure>;
  /** `save` for an action already admitted, such as a Close's own Save. */
  readonly saveFile: (target: FileTarget) => Effect.Effect<boolean, EditorFailure>;
  /** Discards a buffer's edits and shows the file as it is on disk. */
  readonly reload: (target: FileTarget) => Effect.Effect<boolean, EditorFailure>;
  /** Keeps the edits over a file that changed on disk, leaving the conflict view. */
  readonly cancelConflict: (target: FileTarget) => Effect.Effect<void, EditorFailure>;
};

/** Saving buffers to disk, and reloading them from it. */
export class EditorSaves extends Context.Service<EditorSaves, EditorSavesShape>()(
  'moonbase/editor/EditorSaves',
) {
  static readonly layer = Layer.effect(
    EditorSaves,
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
      const mutations = yield* EditorMutations;
      const admitted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        session.run(Effect.andThen(session.admit, effect));
      const closing = Effect.map(session.get, (s) => s.closing);
      /** Clears `saving` once the save ends, unless the editor closed meanwhile. */
      const settle = (buffer: EditorBuffer) =>
        Effect.flatMap(closing, (closed) =>
          closed
            ? Effect.void
            : buffers.updateBuffer(buffer.id, (b) => {
                b.saving = false;
              }),
        );
      const textOf = (buffer: EditorBuffer) =>
        Effect.map(
          buffers.get,
          ({ buffers }) => [...buffers.values()].find((b) => b.id === buffer.id)?.text,
        );

      /**
       * Saves a buffer whose file isn't on disk by creating the file with its text. Creation never
       * replaces a file: one that exists by now refuses it, and the text stays a draft.
       */
      const createFile = (buffer: EditorBuffer) =>
        Effect.gen(function* () {
          const { target } = buffer;
          const result = yield* mutations.dispatch(
            {
              checkout: target.checkout,
              kind: 'create-file',
              sources: [],
              destination: target.path,
              text: buffer.text,
            },
            buffer,
          );
          if (result.outcome !== 'completed') return false;
          const disk = yield* workspace.readFile(target).pipe(Effect.tapError(alerts.report));
          yield* buffers.updateBuffer(buffer.id, (b) => {
            b.newFile = undefined;
            b.disk = disk;
            b.conflict = undefined;
          });
          // The file holds the text now. The store's draft still stands over the file it was kept
          // from, so it is dropped as a Discard would, keeping the tab; newer typing is sent after.
          const tab = (yield* buffers.get).tabs.get(fileKey(target));
          if (tab) yield* outbox.discardDraft(tab.id, tab.target);
          yield* buffers.sendDraft(target);
          yield* outbox.updateLayout;
          yield* recovery.send;
          return (yield* textOf(buffer)) === disk.text;
        }).pipe(
          Effect.catch((error) => Effect.as(alerts.report(error), false)),
          Effect.ensuring(settle(buffer)),
        );

      const saveFile = (target: FileTarget, overwrite = false) =>
        Effect.gen(function* () {
          yield* views.view(target.checkout);
          if ((yield* session.get).initializing === target.checkout.checkoutId) {
            yield* alerts.report(new EditorError({ reason: 'initializing-save' }));
            return false;
          }
          if (yield* operations.isUncertainFor(target)) {
            yield* alerts.report(new EditorError({ reason: 'save-uncertain' }));
            return false;
          }
          // Taking the Save and marking it running is one step, so a second Save can't start.
          const taken = yield* buffers.modify((d) => {
            const buffer = d.buffers.get(fileKey(target));
            if (!buffer || buffer.saving) return undefined;
            buffer.saving = true;
            if (!buffer.newFile)
              buffer.pendingSave = makeSaveRequest(buffer, target, session.clientId, overwrite);
            return { ...buffer };
          });
          if (!taken) return false;
          if (taken.newFile) return yield* createFile(taken);
          const request = taken.pendingSave!;
          // A draft sent while the Save settles could reach the store after it, over the baseline
          // the Save replaced and that nothing moves again: the buffer's drafts wait for its end.
          const tab = (yield* buffers.get).tabs.get(fileKey(target));
          const release = tab ? outbox.releaseDraft(tab.id) : Effect.void;
          if (tab) yield* outbox.holdDraft(tab.id);
          return yield* Effect.gen(function* () {
            const result = yield* workspace.saveFile(request).pipe(
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  yield* alerts.report(error);
                  if (!(yield* closing) && isRefusal(error))
                    yield* buffers.updateBuffer(taken.id, (b) => {
                      b.pendingSave = undefined;
                    });
                }),
              ),
            );
            if (yield* closing) return false;
            if (result.kind === 'conflict') {
              yield* buffers.updateBuffer(taken.id, (b) => {
                b.pendingSave = undefined;
                b.conflict = result.disk;
              });
              yield* alerts.report(
                'Disk changed. Your edits are retained. Compare, overwrite this version, reload or cancel.',
              );
              return false;
            }
            if (result.persistencePending) {
              // The host's own note on it is not shown: no host text reaches the UI.
              yield* alerts.report(
                'Saved on disk; recovery is uncertain. Edits retained. Retry the same Save before closing.',
              );
              return false;
            }
            // The store took the save's outcome in before it answered: its draft now stands over
            // the saved text, and the buffer's text clears it once it matches.
            yield* buffers.updateBuffer(taken.id, (b) => {
              b.disk = result.disk;
              b.conflict = undefined;
              b.pendingSave = undefined;
            });
            yield* release;
            const saved = [...(yield* buffers.get).buffers.values()].find((b) => b.id === taken.id);
            if (saved) yield* buffers.sendDraft(saved.target);
            yield* Effect.catch(recovery.send, alerts.report);
            return (yield* textOf(taken)) === result.disk.text;
          }).pipe(Effect.ensuring(Effect.andThen(release, settle(taken))));
        });

      return {
        save: (target, overwrite = false) => admitted(saveFile(target, overwrite)),
        saveFile: (target) => session.run(saveFile(target)),
        reload: (target) =>
          admitted(
            Effect.gen(function* () {
              const captured = structuredClone(target),
                key = fileKey(captured);
              yield* views.view(captured.checkout);
              const buffer = yield* buffers.find(captured);
              const modes = yield* session.get;
              if (!buffer || buffer.pendingSave || modes.holdingUnsaved || modes.initializing)
                return false;
              const sameBuffer = Effect.map(
                buffers.get,
                (s) => s.buffers.get(key)?.id === buffer.id,
              );
              return yield* tabs.whileHoldingUnsaved(
                Effect.gen(function* () {
                  const disk = yield* workspace
                    .readFile(captured)
                    .pipe(Effect.tapError(alerts.report));
                  if ((yield* closing) || !(yield* sameBuffer))
                    return yield* new EditorError({ reason: 'reload-changed' });
                  const tab = (yield* buffers.get).tabs.get(key);
                  if (tab) {
                    yield* outbox.discardDraft(tab.id, tab.target);
                    yield* outbox.updateLayout;
                    yield* recovery.send;
                  }
                  if (!(yield* sameBuffer)) {
                    yield* alerts.report(
                      'Reload committed for its original target; a changed live buffer was retained.',
                    );
                    return true;
                  }
                  yield* buffers.updateBuffer(buffer.id, (b) => {
                    b.disk = disk;
                    b.text = disk.text;
                    b.conflict = undefined;
                  });
                  const view = yield* views.view(captured.checkout);
                  if (readOwn(view.fileViews, captured.path) === 'conflict')
                    yield* discovery.update((s) => ({
                      ...s,
                      comparisons: { ...s.comparisons, [key]: conflictComparison(disk) },
                      comparisonAttempts: { ...s.comparisonAttempts, [key]: { mode: 'conflict' } },
                    }));
                  yield* outbox.changed;
                  return true;
                }),
              );
            }),
          ),
        cancelConflict: (target) =>
          Effect.gen(function* () {
            if (!(yield* session.get).admissionsOpen) return;
            const buffer = yield* buffers.find(target);
            if (buffer)
              yield* buffers.updateBuffer(buffer.id, (b) => {
                b.conflict = undefined;
              });
            const view = yield* views.view(target.checkout);
            if (readOwn(view.fileViews, target.path) === 'conflict')
              yield* views.modify(({ recovery }) => {
                writeOwn<FileView>(
                  readOwn(recovery.views, target.checkout.checkoutId)!.fileViews,
                  target.path,
                  'file',
                );
              });
            yield* outbox.changed;
          }),
      } satisfies EditorSavesShape;
    }),
  );
}
