import { Context, Effect, Layer } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import { readOwn } from './record.ts';
import { EditorError, type EditorFailure } from './editor-errors.ts';
import { EditorSession } from './session/session-service.ts';
import { EditorAlerts } from './alerts/alerts-service.ts';
import { EditorViews } from './views/views-service.ts';
import { EditorBuffers } from './buffers/buffers-service.ts';
import { EditorOperations } from './operations/operations-service.ts';
import { RecoveryOutbox } from './recovery/recovery-outbox-service.ts';
import { RecoverySync } from './recovery/recovery-sync-service.ts';
import { readRecoveryState } from './recovery/recovery-layout.ts';
import { EditorTabs } from './tabs/tabs-service.ts';
import { EditorTree } from './tree/tree-service.ts';

export type EditorLoaderShape = {
  /**
   * Loads the editor's recovery from the store, once: its tabs, drafts and operations, then
   * watches each open checkout and shows its active file. Later calls join the first.
   */
  readonly load: Effect.Effect<void, EditorFailure>;
};

/** Loads the editor, and stops it first as it closes. */
export class EditorLoader extends Context.Service<EditorLoader, EditorLoaderShape>()(
  'moonbase/editor/EditorLoader',
) {
  static readonly layer = Layer.effect(
    EditorLoader,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      const session = yield* EditorSession;
      const alerts = yield* EditorAlerts;
      const views = yield* EditorViews;
      const buffers = yield* EditorBuffers;
      const operations = yield* EditorOperations;
      const outbox = yield* RecoveryOutbox;
      const recovery = yield* RecoverySync;
      const tabs = yield* EditorTabs;
      const tree = yield* EditorTree;
      const { clientId } = session;
      // Built last, this closes first: nothing is accepted, reported or sent once it starts.
      yield* Effect.addFinalizer(() => Effect.andThen(session.close, outbox.clear));
      const closing = Effect.map(session.get, (s) => s.closing);

      const loadOnce = Effect.gen(function* () {
        if ((yield* session.get).ready) return;
        yield* session.update((s) => ({ ...s, loading: true }));
        const loaded = yield* workspace
          .loadRecovery({ clientId })
          .pipe(Effect.tapError(alerts.report));
        if (yield* closing) return;
        if (loaded.state.clientId !== clientId)
          return yield* new EditorError({ reason: 'foreign-recovery' });
        const { recovery: shown, tabs: held } = readRecoveryState(loaded.state);
        // A since-removed Hide button saved choices it never applied; they are dropped.
        for (const view of Object.values(shown.views)) delete view.tree.hideIgnored;
        yield* views.modify((draft) => {
          draft.recovery = shown;
        });
        yield* buffers.modify((d) => {
          d.tabs = new Map(held);
        });
        for (const error of loaded.errors) yield* alerts.report(error);
        for (const buffer of loaded.state.buffers)
          if (buffer.draft)
            yield* buffers.showDraft({ id: buffer.id, target: buffer.target }, buffer.draft);
        yield* operations.restore(loaded.operations);
        yield* session.update((s) => ({ ...s, ready: true }));
        yield* recovery.watch;
        if (loaded.operations.length)
          yield* Effect.catch(recovery.reconcile(undefined, loaded), alerts.report);
        const selectedCheckoutId = (yield* views.get).recovery.selectedCheckoutId;
        const { recovery: restored } = yield* views.get;
        for (const checkout of restored.checkouts.filter((target) =>
          restored.openCheckoutIds.includes(target.checkoutId),
        )) {
          if (yield* closing) break;
          yield* tree.observe(checkout);
          const selected = readOwn((yield* views.get).recovery.views, checkout.checkoutId);
          if (selected?.active)
            yield* tabs.openFile(
              { checkout, path: selected.active },
              { view: readOwn(selected.fileViews, selected.active) ?? 'file' },
            );
          yield* tree.refreshCheckout(checkout);
        }
        yield* views.modify(({ recovery }) => {
          recovery.selectedCheckoutId = selectedCheckoutId;
        });
        yield* session.update((s) => ({ ...s, loading: false }));
        yield* outbox.changed;
      });
      const load = yield* Effect.cached(session.run(loadOnce));
      return {
        load: Effect.andThen(session.assertAccepting, load),
      } satisfies EditorLoaderShape;
    }),
  );
}
