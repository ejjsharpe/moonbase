import { Context, Deferred, Effect, Layer, SubscriptionRef } from 'effect';
import type { CheckoutTarget, FileTarget } from '@moonbase/contracts/workspace';
import { readOwn, writeOwn } from '../record.ts';
import { EditorError, type EditorFailure } from '../editor-errors.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorAlerts } from '../alerts/alerts-service.ts';
import { EditorViews } from '../views/views-service.ts';
import { findClosedAction, rememberClosed } from '../views/views.ts';
import { EditorBuffers } from '../buffers/buffers-service.ts';
import { isDirty, isSaving, type EditorBuffer } from '../buffers/buffers.ts';
import { EditorDiscovery } from '../discovery/discovery-service.ts';
import { EditorOperations } from '../operations/operations-service.ts';
import { RecoveryOutbox } from '../recovery/recovery-outbox-service.ts';
import { RecoverySync } from '../recovery/recovery-sync-service.ts';
import { closeRecoveryReferences, fileKey } from '../recovery/recovery-references.ts';
import { EditorTabs } from '../tabs/tabs-service.ts';
import { EditorTree } from '../tree/tree-service.ts';
import { EditorSaves } from '../saves/saves-service.ts';
import {
  captureTargets,
  isCloseChoice,
  isRecoveryReady,
  type CloseChoice,
  type ClosePrompt,
} from './preservation.ts';

type CloseKind = 'files' | 'checkout' | 'quit';

export type EditorPreservationShape = {
  readonly closePrompt: SubscriptionRef.SubscriptionRef<ClosePrompt | null>;
  /**
   * Closes files: asks Save, Discard or Cancel for each with unsaved changes, then closes them.
   * Their drafts are kept until the store has committed each close, so a failure loses nothing.
   */
  readonly close: (targets: FileTarget[]) => Effect.Effect<boolean, EditorFailure>;
  readonly closeCheckout: (checkout: CheckoutTarget) => Effect.Effect<boolean, EditorFailure>;
  /** Asks about every buffer with unsaved changes, as Quit does; its tabs stay. */
  readonly prepareQuit: Effect.Effect<boolean, EditorFailure>;
  /** Confirms recovery is complete once composition has fenced admissions. */
  readonly finishQuitPreparation: Effect.Effect<boolean>;
  readonly answerClose: (promptId: string, choice: CloseChoice) => Effect.Effect<void>;
  /** Opens the files of the checkout's last close again. */
  readonly reopen: (checkout: CheckoutTarget) => Effect.Effect<boolean, EditorFailure>;
  /** Whether everything the editor holds is in recovery. */
  readonly recoveryReady: Effect.Effect<boolean>;
};

/** Closing files, checkouts and the editor without losing unsaved work, and reopening them. */
export class EditorPreservation extends Context.Service<
  EditorPreservation,
  EditorPreservationShape
>()('moonbase/editor/EditorPreservation') {
  static readonly layer = Layer.effect(
    EditorPreservation,
    Effect.gen(function* () {
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
      const saves = yield* EditorSaves;
      const closePrompt = yield* SubscriptionRef.make<ClosePrompt | null>(null);
      let answer: Deferred.Deferred<CloseChoice> | undefined;
      const admitted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        session.run(Effect.andThen(session.admit, effect));
      const closing = Effect.map(session.get, (s) => s.closing);
      const recoveryReady = Effect.map(
        Effect.all([session.get, outbox.get, buffers.get, operations.get]),
        ([modes, sent, held, known]) => isRecoveryReady(modes, sent, held, known),
      );
      // A closing editor answers a pending prompt Cancel.
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => (answer ? Deferred.succeed(answer, 'cancel') : Effect.void)),
      );

      const choose = (buffer: EditorBuffer) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<CloseChoice>();
          const prompt = { id: crypto.randomUUID(), buffer };
          answer = reply;
          yield* SubscriptionRef.set(closePrompt, prompt);
          return yield* Deferred.await(reply).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                if (answer === reply) answer = undefined;
                yield* SubscriptionRef.update(closePrompt, (shown) =>
                  shown?.id === prompt.id ? null : shown,
                );
              }),
            ),
          );
        });

      /**
       * Closes files whose drafts were saved or discarded: once every edit made so far has
       * committed, the store closes their tabs (discarding the drafts chosen), and only then does
       * the editor. A Quit keeps its tabs, dropping only discarded drafts.
       */
      const closeFiles = (
        targets: readonly FileTarget[],
        discarded: ReadonlySet<string>,
        kind: CloseKind,
        checkout: CheckoutTarget | undefined,
      ) =>
        Effect.gen(function* () {
          yield* recovery.send;
          const { tabs: shown } = yield* buffers.get;
          for (const target of targets) {
            const key = fileKey(target),
              tab = shown.get(key);
            if (!tab) continue;
            if (kind !== 'quit') yield* outbox.closeTab(tab.id, discarded.has(key));
            else if (discarded.has(key)) yield* outbox.discardDraft(tab.id, tab.target);
          }
          yield* recovery.send;
          const closed = yield* views.modify(({ recovery }) =>
            closeRecoveryReferences(recovery, targets, kind, checkout, true),
          );
          if (kind === 'quit')
            yield* buffers.modify((d) => {
              for (const key of discarded) {
                const buffer = d.buffers.get(key);
                if (!buffer) continue;
                buffer.text = buffer.disk.text;
                buffer.conflict = undefined;
              }
            });
          else {
            yield* buffers.forget(targets.map(fileKey));
            if (kind === 'checkout' && checkout) {
              yield* tree.endReveal(checkout);
              yield* discovery.release(checkout);
            }
          }
          yield* outbox.updateLayout;
          yield* recovery.send;
          return closed;
        });

      const preserve = (targets: FileTarget[], kind: CloseKind, checkout?: CheckoutTarget) =>
        Effect.gen(function* () {
          yield* session.assertReady;
          const modes = yield* session.get;
          if (modes.initializing) {
            yield* alerts.report(new EditorError({ reason: 'initializing-close' }));
            return false;
          }
          if (modes.preserving || [...(yield* buffers.get).buffers.values()].some(isSaving))
            return false;
          const captured = captureTargets(targets);
          for (const target of captured)
            if (yield* operations.isUncertainFor(target)) {
              yield* alerts.report(new EditorError({ reason: 'close-uncertain' }));
              return false;
            }
          return yield* tabs.whilePreserving(
            Effect.gen(function* () {
              const discarded = new Set<string>();
              for (const target of captured) {
                const buffer = yield* buffers.find(target);
                if (!buffer || !isDirty(buffer)) continue;
                const choice = yield* choose(structuredClone(buffer));
                if ((yield* closing) || choice === 'cancel') return false;
                if (choice === 'discard') discarded.add(fileKey(target));
                else if (!(yield* saves.saveFile(target))) return false;
              }
              const closed = yield* closeFiles(
                captured,
                discarded,
                kind,
                checkout && structuredClone(checkout),
              );
              if (kind !== 'quit')
                yield* views.modify((draft) => {
                  draft.closed = rememberClosed(draft.closed, closed);
                });
              return true;
            }).pipe(Effect.catch((error) => Effect.as(alerts.report(error), false))),
          );
        });

      return {
        closePrompt,
        close: (targets) => admitted(preserve(targets, 'files')),
        closeCheckout: (checkout) =>
          admitted(
            Effect.gen(function* () {
              const selected = yield* views.view(checkout);
              return yield* preserve(
                selected.openFiles.map((path) => ({ checkout, path })),
                'checkout',
                checkout,
              );
            }),
          ),
        prepareQuit: admitted(
          Effect.flatMap(buffers.get, (held) =>
            preserve(
              [...held.buffers.values()].map((buffer) => buffer.target),
              'quit',
            ),
          ),
        ),
        finishQuitPreparation: session.run(
          Effect.gen(function* () {
            const modes = yield* session.get;
            if (
              modes.admissionsOpen ||
              !modes.ready ||
              modes.loading ||
              modes.closing ||
              modes.preserving ||
              modes.initializing ||
              [...(yield* buffers.get).buffers.values()].some(
                (buffer) => isDirty(buffer) || isSaving(buffer),
              ) ||
              [...(yield* operations.get).values()].some((known) => !known.acknowledged)
            )
              return false;
            if (yield* recoveryReady) return true;
            const flushed = yield* Effect.exit(recovery.flush);
            if (flushed._tag === 'Failure') {
              const failure = flushed.cause.reasons.find((reason) => reason._tag === 'Fail');
              if (failure) yield* alerts.report(failure.error);
              return false;
            }
            return yield* recoveryReady;
          }),
        ),
        answerClose: (promptId, choice) =>
          Effect.gen(function* () {
            if (!(yield* session.get).admissionsOpen) return;
            const shown = yield* SubscriptionRef.get(closePrompt);
            if (!answer || shown?.id !== promptId || !isCloseChoice(choice)) return;
            yield* Deferred.succeed(answer, choice);
          }),
        reopen: (checkout) =>
          admitted(
            Effect.gen(function* () {
              yield* views.view(checkout);
              if ((yield* session.get).preserving) return false;
              const found = findClosedAction((yield* views.get).closed, checkout);
              if (!found) return false;
              const { action, index } = found;
              const reopened = yield* views.modify(({ recovery }) => {
                const selected = readOwn(recovery.views, checkout.checkoutId)!;
                const added: string[] = [];
                for (const file of action.files)
                  if (!selected.openFiles.includes(file.path)) {
                    selected.openFiles.splice(
                      Math.min(file.index, selected.openFiles.length),
                      0,
                      file.path,
                    );
                    writeOwn(selected.fileViews, file.path, file.view);
                    if (file.positions)
                      writeOwn(selected.positions, file.path, structuredClone(file.positions));
                    added.push(file.path);
                  }
                selected.active = action.active;
                selected.preview = null;
                return added;
              });
              for (const path of reopened) yield* buffers.openTab({ checkout, path });
              yield* outbox.updateLayout;
              const success = yield* tabs.openFile({ checkout, path: action.active });
              yield* recovery.flush;
              yield* views.modify((draft) => {
                draft.closed = draft.closed.filter((_, at) => at !== index);
              });
              return success;
            }),
          ),
        recoveryReady,
      } satisfies EditorPreservationShape;
    }),
  );
}
