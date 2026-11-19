import { Context, Effect, FiberHandle, FiberSet, Layer, Scope, Semaphore, Stream } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import type { RecoveryLoad, RecoveryOutline, RecoveryState } from '@moonbase/contracts/recovery';
import type { OperationResult } from '@moonbase/contracts/workspace';
import { EditorError, type EditorFailure } from '../editor-errors.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorAlerts } from '../alerts/alerts-service.ts';
import { EditorViews } from '../views/views-service.ts';
import { isCheckoutListed } from '../views/views.ts';
import { EditorBuffers } from '../buffers/buffers-service.ts';
import { isDirty } from '../buffers/buffers.ts';
import { EditorOperations } from '../operations/operations-service.ts';
import { operationKey } from '../operations/operations.ts';
import { RecoveryOutbox, type OutboxSender } from './recovery-outbox-service.ts';
import { toRecoveryLayout } from './recovery-layout.ts';
import { closeRecoveryReferences, sameCheckout } from './recovery-references.ts';

export type RecoverySyncShape = {
  /**
   * Sends the recovery edits made so far; succeeds once each has committed. Fails while a close
   * or reload is preserving, and waits for a running `initializeRepository`.
   */
  readonly flush: Effect.Effect<void, EditorFailure>;
  /** Sends the edits made so far, for an action already holding the editor (a close's own). */
  readonly send: Effect.Effect<void, EditorFailure>;
  /** Follows the store's outline of this editor's recovery as it changes, if not already. */
  readonly watch: Effect.Effect<void>;
  /**
   * Reads this editor's recovery from the store (which also takes in other clients' moves) and
   * follows it, takes in the operations it has not acknowledged (and `result`), then
   * acknowledges each settled one.
   */
  readonly reconcile: (
    result?: OperationResult,
    initial?: RecoveryLoad,
  ) => Effect.Effect<void, EditorFailure>;
};

/**
 * Keeps the editor and its recovery store in step: sends the outbox, follows the store's outline
 * and takes in file operations' outcomes.
 */
export class RecoverySync extends Context.Service<RecoverySync, RecoverySyncShape>()(
  'moonbase/editor/RecoverySync',
) {
  static readonly layer = Layer.effect(
    RecoverySync,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      const session = yield* EditorSession;
      const alerts = yield* EditorAlerts;
      const views = yield* EditorViews;
      const buffers = yield* EditorBuffers;
      const operations = yield* EditorOperations;
      const outbox = yield* RecoveryOutbox;
      const { clientId } = session;
      const factsLock = yield* Semaphore.make(1);
      // Owned by the session: closing the editor interrupts its sends and its recovery watch.
      const sends = yield* Scope.provide(FiberSet.make(), session.scope);
      const recoveryWatch = yield* Scope.provide(FiberHandle.make(), session.scope);
      const loadRecovery = (report = true) =>
        workspace
          .loadRecovery({ clientId })
          .pipe(Effect.tapError((error) => (report ? alerts.report(error) : Effect.void)));

      /**
       * Takes in where the store holds this editor's buffers: a tab whose buffer a move took to
       * another file follows it, and a tab at that file whose clean buffer gave way leaves (its
       * unsent text kept at a new path). A draft the store made itself (a copy, a restored save)
       * opens as a tab; an outline has no text, so its text is read with the next reconcile. A
       * `full` state, read just now, also gets the edits it lacks: tabs it doesn't hold, and text
       * it holds otherwise.
       */
      const follow = (
        store: RecoveryOutline | RecoveryState,
        full: boolean,
      ): Effect.Effect<void, EditorFailure> =>
        Effect.gen(function* () {
          const held = new Map(store.buffers.map((buffer) => [buffer.id, buffer]));
          const shown = new Set([...(yield* buffers.get).tabs.values()].map((tab) => tab.id));
          let changed = false,
            unread = false;
          for (const [key, tab] of (yield* buffers.get).tabs) {
            const buffer = held.get(tab.id);
            // A checkout relisted under its ID (after `git init`) is the editor's own rebind.
            if (!buffer || !sameCheckout(buffer.target.checkout, tab.target.checkout)) continue;
            const current = (yield* buffers.get).tabs.get(key);
            if (buffer.target.path === tab.target.path || current?.id !== tab.id) continue;
            yield* buffers.moveTab(key, buffer.target);
            changed = true;
          }
          for (const buffer of store.buffers) {
            if (!buffer.draft || (yield* buffers.get).closed.has(buffer.id)) continue;
            if (shown.has(buffer.id)) {
              // A draft the store made over a clean tab (another window's copy onto it) is the
              // newer: the tab takes it, rather than sending its stale text over it.
              const own = yield* buffers.find(buffer.target);
              if (!own || isDirty(own) || (yield* outbox.isDraftPending(buffer.id))) continue;
              if (!('text' in buffer.draft)) {
                unread = true;
                continue;
              }
              if (own.text === buffer.draft.text && own.disk.version === buffer.draft.disk.version)
                continue;
              const draft = buffer.draft;
              yield* buffers.updateBuffer(own.id, (b) => {
                b.text = draft.text;
                b.disk = structuredClone(draft.disk);
              });
              changed = true;
              continue;
            }
            if (!('text' in buffer.draft)) {
              unread = true;
              continue;
            }
            if (!isCheckoutListed((yield* views.get).recovery, buffer.target.checkout)) continue;
            const own = yield* buffers.find(buffer.target);
            // This editor's text for the file, under a buffer the store doesn't hold, stays newer.
            if (own && isDirty(own) && own.text !== buffer.draft.text)
              yield* buffers.keepElsewhere(own);
            yield* buffers.showDraft({ id: buffer.id, target: buffer.target }, buffer.draft);
            changed = true;
          }
          if (full) {
            const state = store as RecoveryState;
            const drafts = new Map(state.buffers.map((buffer) => [buffer.id, buffer.draft?.text]));
            // A clean buffer the editor no longer shows (one whose close was lost) is closed, so it
            // never holds a file the editor opens again under another buffer.
            for (const buffer of state.buffers)
              if (
                !buffer.draft &&
                !shown.has(buffer.id) &&
                !(yield* outbox.isTabPending(buffer.id))
              )
                yield* outbox.closeTab(buffer.id);
            const current = yield* buffers.get;
            for (const [key, tab] of current.tabs) {
              if (yield* outbox.isTabPending(tab.id)) continue;
              if (!held.has(tab.id)) yield* outbox.openTab(tab.id, tab.target);
              const buffer = current.buffers.get(key);
              const text = buffer && (isDirty(buffer) ? buffer.text : undefined);
              if (buffer && text !== drafts.get(tab.id)) yield* buffers.sendDraft(buffer.target);
            }
            yield* outbox.forgetLayout;
            changed = true;
          }
          if (unread) yield* FiberSet.run(sends)(Effect.catch(reconcile(), alerts.report));
          if (changed) yield* outbox.changed;
        });

      const watch: Effect.Effect<void> = FiberHandle.run(recoveryWatch, { onlyIfMissing: true })(
        workspace.watchRecovery({ clientId }).pipe(
          Stream.runForEach((outline) => Effect.catch(follow(outline, false), alerts.report)),
          Effect.catch(alerts.report),
        ),
      ).pipe(Effect.asVoid);

      const reconcile: RecoverySyncShape['reconcile'] = (result, initial) =>
        session.run(
          factsLock.withPermits(1)(
            Effect.gen(function* () {
              yield* session.awaitInitialization;
              yield* watch;
              const loaded = initial ?? (yield* loadRecovery());
              if (loaded.state.clientId !== clientId)
                return yield* new EditorError({ reason: 'foreign-recovery' });
              yield* follow(loaded.state, true);
              const facts = [
                ...new Map(
                  [...loaded.operations, ...(result ? [result] : [])].map((fact) => [
                    operationKey(fact.clientId, fact.id),
                    fact,
                  ]),
                ).values(),
              ];
              for (const fact of facts) yield* operations.applyFacts(fact);
              if (facts.length) yield* outbox.changed;
              for (const fact of facts) {
                if (fact.outcome === 'uncertain') continue;
                yield* workspace
                  .acknowledgeOperation({ clientId, operationClientId: fact.clientId, id: fact.id })
                  .pipe(Effect.tapError(alerts.report));
                yield* operations.acknowledge(fact.clientId, fact.id);
              }
            }),
          ),
        );

      /**
       * A close whose reply was lost committed, as the store showed later: the Discard stands. A
       * closed tab closes here too; a Discard that keeps its tab (Quit, Reload) drops its text.
       */
      const finishClose: OutboxSender['finishClose'] = (edit, reopen) =>
        Effect.gen(function* () {
          const entry = [...(yield* buffers.get).tabs].find(([, tab]) => tab.id === edit.bufferId);
          if (!entry) return;
          const [key, tab] = entry;
          if (reopen) {
            const buffer = (yield* buffers.get).buffers.get(key);
            if (buffer)
              yield* buffers.updateBuffer(buffer.id, (b) => {
                b.text = b.disk.text;
                b.conflict = undefined;
              });
            yield* outbox.openTab(tab.id, tab.target);
          } else {
            yield* views.modify(({ recovery }) =>
              closeRecoveryReferences(recovery, [tab.target], 'files'),
            );
            yield* buffers.forget([key]);
          }
          yield* outbox.changed;
        });

      const sender: OutboxSender = {
        // A layout now would name the folder target that `git init` retires.
        ready: session.awaitInitialization,
        layout: Effect.map(Effect.all([views.get, buffers.get]), ([{ recovery }, { tabs }]) =>
          toRecoveryLayout(recovery, tabs),
        ),
        send: (kind, input) =>
          session
            .run(
              (workspace[kind] as (input: unknown) => Effect.Effect<unknown, EditorFailure>)(input),
            )
            .pipe(Effect.asVoid),
        resync: (edit) =>
          Effect.gen(function* () {
            // A tab the store would not close (it holds a draft the editor did not know) stays.
            if (edit.kind === 'closeTab') {
              yield* buffers.modify((d) => d.closed.delete(edit.bufferId));
              return false;
            }
            const loaded = yield* loadRecovery();
            yield* follow(loaded.state, true);
            return true;
          }),
        settleClose: (bufferId) =>
          Effect.map(
            loadRecovery(false),
            (loaded) => !loaded.state.buffers.some((buffer) => buffer.id === bufferId),
          ),
        finishClose,
        shownTab: (bufferId) =>
          Effect.map(buffers.get, ({ tabs }) => {
            const tab = [...tabs.values()].find((shown) => shown.id === bufferId);
            return tab && structuredClone(tab.target);
          }),
      };

      const send = session.run(outbox.send(false, sender));
      // Edits go a quiet moment after the last change; a send once begun is not cut short by a
      // later change, only by the editor closing.
      yield* outbox.scheduled.pipe(
        Stream.debounce('150 millis'),
        Stream.runForEach(() =>
          FiberSet.run(sends)(Effect.catch(outbox.send(true, sender), alerts.report)),
        ),
        Effect.forkIn(session.scope),
      );

      return {
        flush: session.run(
          Effect.gen(function* () {
            yield* session.assertReady;
            // An edit now would name the folder target that `git init` retires.
            yield* session.awaitInitialization;
            if ((yield* session.get).preserving)
              return yield* new EditorError({ reason: 'preserving-flush' });
            yield* send;
          }),
        ),
        send,
        watch,
        reconcile,
      } satisfies RecoverySyncShape;
    }),
  );
}
