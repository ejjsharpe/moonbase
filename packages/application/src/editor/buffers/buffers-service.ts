import { Context, Effect, Layer, SubscriptionRef } from 'effect';
import type { FileDocument, FileTarget } from '@moonbase/contracts/workspace';
import { EditorAlerts } from '../alerts/alerts-service.ts';
import { EditorDiscovery } from '../discovery/discovery-service.ts';
import { RecoveryOutbox } from '../recovery/recovery-outbox-service.ts';
import { emptyCheckoutView, type EditorTab } from '../recovery/recovery-layout.ts';
import { fileKey, sameCheckout } from '../recovery/recovery-references.ts';
import { EditorViews } from '../views/views-service.ts';
import {
  draftBuffers,
  settleBuffers,
  emptyBuffers,
  findBufferById,
  isDirty,
  newBuffer,
  type BuffersDraft,
  type BuffersState,
  type EditorBuffer,
} from './buffers.ts';
import { findFreePath } from './free-path.ts';

export type EditorBuffersShape = {
  readonly state: SubscriptionRef.SubscriptionRef<BuffersState>;
  readonly get: Effect.Effect<BuffersState>;
  /**
   * Changes a draft of the buffers, which then replaces them: `f` may change the maps and each
   * buffer or tab it reads from them.
   */
  readonly modify: <A>(f: (draft: BuffersDraft) => A) => Effect.Effect<A>;
  readonly find: (target: FileTarget) => Effect.Effect<EditorBuffer | undefined>;
  /** Changes the buffer with this identity, wherever a move has taken it. */
  readonly updateBuffer: (id: string, f: (buffer: EditorBuffer) => void) => Effect.Effect<void>;
  /** Sends a buffer's text to the recovery store. */
  readonly sendDraft: (target: FileTarget) => Effect.Effect<void>;
  /** Opens a tab in the recovery store for a file the editor shows a tab for. */
  readonly openTab: (target: FileTarget) => Effect.Effect<void>;
  /** Closes a clean tab in the recovery store; the editor no longer shows it. */
  readonly closeTab: (target: FileTarget) => Effect.Effect<void>;
  /** Shows a buffer the store holds with a draft as an open tab with that text. */
  readonly showDraft: (
    tab: EditorTab,
    draft: { text: string; disk: FileDocument },
  ) => Effect.Effect<void>;
  /**
   * Keeps text the store has no place for (its buffer was replaced) as a draft at a new path
   * beside its file, with the file text it was edited from, and says where.
   */
  readonly keepElsewhere: (buffer: EditorBuffer) => Effect.Effect<void>;
  /** Moves a tab, its buffer and its view to where the store's buffer now is. */
  readonly moveTab: (key: string, target: FileTarget) => Effect.Effect<void>;
  /** Forgets closed files' buffers, tabs and comparisons. */
  readonly forget: (keys: readonly string[]) => Effect.Effect<void>;
};

/** The open buffers, with their drafts and their tabs in the recovery store. */
export class EditorBuffers extends Context.Service<EditorBuffers, EditorBuffersShape>()(
  'moonbase/editor/EditorBuffers',
) {
  static readonly layer = Layer.effect(
    EditorBuffers,
    Effect.gen(function* () {
      const views = yield* EditorViews;
      const outbox = yield* RecoveryOutbox;
      const discovery = yield* EditorDiscovery;
      const alerts = yield* EditorAlerts;
      const state = yield* SubscriptionRef.make<BuffersState>(emptyBuffers);
      const get = SubscriptionRef.get(state);
      const modify = <A>(f: (draft: BuffersDraft) => A) =>
        SubscriptionRef.modify(state, (current) => {
          const draft = draftBuffers(current);
          const result = f(draft);
          return [result, settleBuffers(current, draft)] as const;
        });
      const forgetComparisons = (keys: readonly string[]) =>
        discovery.update((s) => {
          const comparisons = { ...s.comparisons },
            comparisonAttempts = { ...s.comparisonAttempts };
          for (const key of keys) {
            delete comparisons[key];
            delete comparisonAttempts[key];
          }
          return { ...s, comparisons, comparisonAttempts };
        });
      const showDraft: EditorBuffersShape['showDraft'] = (tab, draft) =>
        Effect.gen(function* () {
          const key = fileKey(tab.target);
          yield* modify((d) => {
            d.tabs.set(key, structuredClone(tab));
            d.buffers.set(key, newBuffer(tab.target, draft.disk, draft.text));
          });
          const checkoutId = tab.target.checkout.checkoutId;
          yield* views.modify(({ recovery }) => {
            const view = recovery.views.get(checkoutId) ?? emptyCheckoutView();
            recovery.views.set(checkoutId, view);
            if (!view.openFiles.includes(tab.target.path)) view.openFiles.push(tab.target.path);
            if (view.preview === tab.target.path) view.preview = null;
          });
        });
      const keepElsewhere: EditorBuffersShape['keepElsewhere'] = (buffer) =>
        Effect.gen(function* () {
          const { checkout } = buffer.target;
          const { tabs } = yield* get;
          const taken = new Set(
            [...tabs.values()]
              .filter((tab) => sameCheckout(tab.target.checkout, checkout))
              .map((tab) => tab.target.path),
          );
          // Files the editor has listed are taken too; a Save creates the file and never replaces one.
          for (const listing of Object.values((yield* discovery.get).listings))
            for (const entry of listing.entries) taken.add(entry.path);
          const target = { checkout, path: findFreePath(buffer.target.path, taken) };
          const tab = { id: crypto.randomUUID(), target };
          yield* showDraft(tab, { text: buffer.text, disk: buffer.disk });
          yield* modify((d) => {
            d.buffers.get(fileKey(target))!.newFile = true;
          });
          yield* outbox.openTab(tab.id, target);
          yield* outbox.updateDraft(tab.id, buffer.text, buffer.disk);
          yield* alerts.report(
            `${buffer.target.path} was replaced while it had unsaved changes. They are kept in ${target.path}; Save creates it.`,
          );
        });
      /** A tab whose clean buffer a move replaced leaves; text not yet sent is kept elsewhere. */
      const dropReplacedTab = (key: string) =>
        Effect.gen(function* () {
          const { tab, buffer } = yield* modify((d) => {
            const tab = d.tabs.get(key)!,
              buffer = d.buffers.get(key);
            d.tabs.delete(key);
            d.closed.add(tab.id);
            d.buffers.delete(key);
            return { tab, buffer };
          });
          // The store keeps the replaced ID until the client closes it.
          yield* outbox.closeTab(tab.id);
          if (buffer && isDirty(buffer)) yield* keepElsewhere(buffer);
          yield* forgetComparisons([key]);
        });
      return {
        state,
        get,
        modify,
        find: (target) => Effect.map(get, (s) => s.buffers.get(fileKey(target))),
        updateBuffer: (id, f) =>
          SubscriptionRef.update(state, (current) => {
            // Found in the state itself, so the draft copies only this buffer.
            const found = findBufferById(current, id);
            if (!found) return current;
            const draft = draftBuffers(current);
            f(draft.buffers.get(found[0])!);
            return settleBuffers(current, draft);
          }),
        sendDraft: (target) =>
          Effect.gen(function* () {
            const key = fileKey(target);
            const { tabs, buffers } = yield* get;
            const tab = tabs.get(key),
              buffer = buffers.get(key);
            if (tab && buffer) yield* outbox.updateDraft(tab.id, buffer.text, buffer.disk);
          }),
        openTab: (target) =>
          Effect.gen(function* () {
            const key = fileKey(target);
            const tab = yield* modify((d) => {
              if (d.tabs.has(key)) return undefined;
              const tab = { id: crypto.randomUUID(), target: structuredClone(target) };
              d.tabs.set(key, tab);
              return tab;
            });
            if (tab) yield* outbox.openTab(tab.id, tab.target);
          }),
        closeTab: (target) =>
          Effect.gen(function* () {
            const key = fileKey(target);
            const tab = yield* modify((d) => {
              const tab = d.tabs.get(key);
              if (!tab) return undefined;
              d.tabs.delete(key);
              d.closed.add(tab.id);
              return tab;
            });
            if (tab) yield* outbox.closeTab(tab.id);
          }),
        showDraft,
        keepElsewhere,
        moveTab: (key, target) =>
          Effect.gen(function* () {
            const next = fileKey(target);
            // A clean buffer at the destination gave way to this one in the store.
            if ((yield* get).tabs.has(next)) yield* dropReplacedTab(next);
            const source = yield* modify((d) => {
              const tab = d.tabs.get(key)!,
                source = tab.target.path;
              d.tabs.delete(key);
              tab.target = structuredClone(target);
              d.tabs.set(next, tab);
              const buffer = d.buffers.get(key);
              if (buffer) {
                d.buffers.delete(key);
                buffer.target = structuredClone(target);
                d.buffers.set(next, buffer);
              }
              return source;
            });
            yield* discovery.update((s) => {
              const comparisons = { ...s.comparisons },
                comparisonAttempts = { ...s.comparisonAttempts };
              delete comparisonAttempts[key];
              if (comparisons[key]) {
                comparisons[next] = comparisons[key];
                delete comparisons[key];
              }
              return { ...s, comparisons, comparisonAttempts };
            });
            yield* views.modify(({ recovery }) => {
              const view = recovery.views.get(target.checkout.checkoutId);
              if (!view) return;
              const rename = (path: string) => (path === source ? target.path : path);
              view.openFiles = [...new Set(view.openFiles.map(rename))];
              view.active = rename(view.active);
              if (view.preview !== null) view.preview = rename(view.preview);
              for (const memory of [view.fileViews, view.positions] as Map<string, unknown>[])
                if (memory.has(source)) {
                  memory.set(target.path, memory.get(source));
                  memory.delete(source);
                }
            });
          }),
        forget: (keys) =>
          Effect.gen(function* () {
            yield* modify((d) => {
              for (const key of keys) {
                const tab = d.tabs.get(key);
                if (tab) d.closed.add(tab.id);
                d.tabs.delete(key);
                d.buffers.delete(key);
              }
            });
            yield* forgetComparisons(keys);
          }),
      } satisfies EditorBuffersShape;
    }),
  );
}
