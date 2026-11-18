import { isPathAtOrInside } from '@moonbase/contracts/paths';
import { Effect, Queue, Schema, Stream } from 'effect';
import { RecoveryStateSchema } from '@moonbase/contracts/recovery-schema';
import {
  InvalidRecoveryRequestError,
  type WorkspaceError,
} from '@moonbase/contracts/workspace-errors';
import {
  emptyBufferView,
  emptyRecoveryState,
  type RecoveryBuffer,
  type RecoveryEditInput,
  type RecoveryOutline,
  type RecoveryState,
} from '@moonbase/contracts/recovery';
import type {
  CheckoutTarget,
  FileDocument,
  FileTarget,
  OperationResult,
} from '@moonbase/contracts/workspace';
import { checkoutKey, fileKey } from '../editor/index.ts';

type FauxRecoveryDependencies = {
  /** The seeded checkout, or a failure for one the fake doesn't hold. */
  exact(checkout: CheckoutTarget): unknown;
  fail(error: WorkspaceError): never;
};
const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) => checkoutKey(a) === checkoutKey(b);
const sameTarget = (a: FileTarget, b: FileTarget) => fileKey(a) === fileKey(b);
const isValidState = Schema.is(RecoveryStateSchema);
const outlineOf = (state: RecoveryState): RecoveryOutline => ({
  ...state,
  buffers: state.buffers.map(({ draft, ...buffer }) =>
    draft ? { ...buffer, draft: { baseline: draft.disk.version } } : buffer,
  ),
});

/**
 * The recovery store of the faux workspace, in memory: each client's buffer-keyed recovery, its
 * edits, and an outline watch. It keeps the store's rules that the editor relies on (a buffer's
 * draft and baseline, a move re-pathing buffers, a clean buffer giving way) and none of its
 * durability.
 */
export function fauxRecovery({ exact, fail }: FauxRecoveryDependencies) {
  const recoveries = new Map<string, RecoveryState>();
  const watchers = new Set<{ clientId: string; offer: (outline: RecoveryOutline) => void }>();
  const stats = { edits: 0 };
  const read = (clientId: string) =>
    structuredClone(recoveries.get(clientId) ?? emptyRecoveryState(clientId));
  const write = (clientId: string, state: RecoveryState) => {
    const before = JSON.stringify(outlineOf(read(clientId)));
    recoveries.set(clientId, structuredClone(state));
    const outline = outlineOf(state);
    if (JSON.stringify(outline) === before) return;
    for (const watcher of watchers)
      if (watcher.clientId === clientId) watcher.offer(structuredClone(outline));
  };
  const edit = (clientId: string, change: (state: RecoveryState) => void) => {
    const state = read(clientId);
    change(state);
    // Like the store, an edit that would leave an invalid recovery is refused and changes nothing.
    if (!isValidState(state)) fail(new InvalidRecoveryRequestError({ problem: 'invalid-state' }));
    stats.edits++;
    write(clientId, state);
  };
  const viewOf = (state: RecoveryState, checkoutId: string) =>
    (state.views[checkoutId] ??= emptyBufferView());

  const openTab = ({ clientId, bufferId, target }: RecoveryEditInput<'openTab'>) =>
    edit(clientId, (state) => {
      const open = state.buffers.find((b) => b.id === bufferId);
      if (open) {
        const view = viewOf(state, open.target.checkout.checkoutId);
        if (!view.tabs.includes(bufferId)) view.tabs.push(bufferId);
        return;
      }
      if (state.buffers.some((b) => sameTarget(b.target, target)))
        fail(new InvalidRecoveryRequestError({ problem: 'buffer-target' }));
      exact(target.checkout);
      if (!state.checkouts.some((c) => sameCheckout(c, target.checkout)))
        state.checkouts.push(target.checkout);
      state.buffers.push({ id: bufferId, target });
      const view = viewOf(state, target.checkout.checkoutId);
      view.tabs.push(bufferId);
      const memory = view.remembered[target.path];
      if (memory?.view) view.fileViews[bufferId] = memory.view;
      if (memory?.positions) view.positions[bufferId] = memory.positions;
      delete view.remembered[target.path];
    });
  const closeTab = ({ clientId, bufferId, discard }: RecoveryEditInput<'closeTab'>) =>
    edit(clientId, (state) => {
      const index = state.buffers.findIndex((b) => b.id === bufferId);
      if (index < 0) return;
      const { target, draft } = state.buffers[index];
      if (draft && !discard) fail(new InvalidRecoveryRequestError({ problem: 'draft-open' }));
      state.buffers.splice(index, 1);
      const view = state.views[target.checkout.checkoutId];
      if (!view) return;
      view.tabs = view.tabs.filter((id) => id !== bufferId);
      if (view.active === bufferId) view.active = view.tabs[0] ?? null;
      if (view.preview === bufferId) view.preview = null;
      const fileView = view.fileViews[bufferId],
        positions = view.positions[bufferId];
      delete view.fileViews[bufferId];
      delete view.positions[bufferId];
      if (fileView || positions)
        view.remembered[target.path] = {
          ...(fileView ? { view: fileView } : {}),
          ...(positions ? { positions } : {}),
        };
    });
  const updateDraft = ({ clientId, bufferId, text, disk }: RecoveryEditInput<'updateDraft'>) =>
    edit(clientId, (state) => {
      const buffer = state.buffers.find((b) => b.id === bufferId);
      if (!buffer) return fail(new InvalidRecoveryRequestError({ problem: 'unknown-buffer' }));
      if (!buffer.draft) {
        if (text !== disk.text) buffer.draft = { text, disk };
      } else if (text === buffer.draft.disk.text && disk.version === buffer.draft.disk.version)
        delete buffer.draft;
      else buffer.draft.text = text;
    });
  const updateLayout = ({ clientId, layout }: RecoveryEditInput<'updateLayout'>) =>
    edit(clientId, (state) => {
      for (const checkout of layout.checkouts) exact(checkout);
      const checkouts = [...layout.checkouts];
      for (const buffer of state.buffers) {
        const listed = checkouts.find((c) => c.checkoutId === buffer.target.checkout.checkoutId);
        if (listed) buffer.target = { ...buffer.target, checkout: listed };
        else checkouts.push(buffer.target.checkout);
      }
      Object.assign(state, structuredClone(layout), { checkouts });
      for (const [checkoutId, view] of Object.entries(state.views)) {
        const owned = (id: string | null) =>
          state.buffers.some((b) => b.id === id && b.target.checkout.checkoutId === checkoutId);
        view.tabs = view.tabs.filter(owned);
        if (!owned(view.active)) view.active = null;
        if (!owned(view.preview)) view.preview = null;
        for (const memory of [view.fileViews, view.positions])
          for (const id of Object.keys(memory)) if (!owned(id)) delete memory[id];
      }
    });

  return {
    stats,
    /** A client's recovery as it loads. */
    load: (clientId: string) => read(clientId),
    /** Whether a client's recovery names the checkout. */
    names: (clientId: string, checkout: CheckoutTarget) =>
      read(clientId).checkouts.some((c) => sameCheckout(c, checkout)),
    clients: () => [...recoveries.keys()],
    openTab,
    closeTab,
    updateDraft,
    updateLayout,
    /** A save the store took in: drafts over the saved file now stand over its new text. */
    applySave(clientId: string, target: FileTarget, disk: FileDocument) {
      const state = recoveries.get(clientId);
      if (!state) return;
      for (const buffer of state.buffers)
        if (buffer.draft && sameTarget(buffer.target, target)) buffer.draft.disk = disk;
      write(clientId, state);
    },
    /**
     * Applies an operation's completed items to every recovery naming its checkout: a move
     * re-paths buffers (a clean buffer at the destination gives way, one with a draft holds it),
     * a copy gives each copied draft a buffer at its destination, and Trash moves nothing.
     */
    applyOperation(result: OperationResult, read: (path: string) => FileDocument | undefined) {
      for (const [clientId, stored] of recoveries) {
        if (!stored.checkouts.some((c) => sameCheckout(c, result.checkout))) continue;
        const state = structuredClone(stored);
        for (const item of result.items) {
          if (item.outcome !== 'completed' || !item.destination || result.kind === 'trash')
            continue;
          const destination = item.destination;
          const inside = (target: FileTarget) =>
            sameCheckout(target.checkout, result.checkout) &&
            isPathAtOrInside(target.path, item.source);
          const move = (path: string) => destination + path.slice(item.source.length);
          const at = (path: string, except?: RecoveryBuffer) =>
            state.buffers.find(
              (b) =>
                b !== except &&
                sameCheckout(b.target.checkout, result.checkout) &&
                b.target.path === path,
            );
          if (result.kind === 'copy') {
            // oxlint-disable-next-line no-useless-spread -- Copies append buffers; visit the originals.
            for (const buffer of [...state.buffers]) {
              if (!buffer.draft || !inside(buffer.target)) continue;
              const path = move(buffer.target.path),
                held = at(path),
                disk = read(path);
              if (held?.draft || !disk) continue;
              const draft = { text: buffer.draft.text, disk };
              if (held) held.draft = draft;
              else
                state.buffers.push({
                  id: crypto.randomUUID(),
                  target: { ...buffer.target, path },
                  draft,
                });
            }
            continue;
          }
          if (result.kind !== 'move') continue;
          // oxlint-disable-next-line no-useless-spread -- A buffer that gives way leaves the list.
          for (const buffer of [...state.buffers]) {
            if (!state.buffers.includes(buffer) || !inside(buffer.target)) continue;
            const path = move(buffer.target.path),
              held = at(path, buffer);
            if (held?.draft) continue;
            if (held) {
              state.buffers.splice(state.buffers.indexOf(held), 1);
              const view = state.views[result.checkout.checkoutId];
              if (view) {
                const swap = (id: string) => (id === held.id ? buffer.id : id);
                view.tabs = [...new Set(view.tabs.map(swap))];
                if (view.active !== null) view.active = swap(view.active);
                if (view.preview !== null) view.preview = swap(view.preview);
                // The arriving buffer takes over the view and positions of the one giving way.
                for (const memory of [view.fileViews, view.positions] as Record<
                  string,
                  unknown
                >[]) {
                  if (held.id in memory && !(buffer.id in memory))
                    memory[buffer.id] = memory[held.id];
                  delete memory[held.id];
                }
              }
            }
            buffer.target = { ...buffer.target, path };
          }
          state.recentFiles = state.recentFiles.map((t) =>
            inside(t) ? { ...t, path: move(t.path) } : t,
          );
          // What the view remembers of closed files, and its tree, follow the move by path.
          const view = state.views[result.checkout.checkoutId];
          if (view) {
            const rename = (path: string) =>
              isPathAtOrInside(path, item.source) ? move(path) : path;
            view.remembered = Object.fromEntries(
              Object.entries(view.remembered).map(([path, file]) => [rename(path), file]),
            );
            view.tree.expanded = view.tree.expanded.map(rename);
            view.tree.selected = view.tree.selected.map(rename);
            view.tree.focus = rename(view.tree.focus);
          }
        }
        write(clientId, state);
      }
    },
    watch: (clientId: string) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.sliding<RecoveryOutline>(1);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const watcher = {
                clientId,
                offer: (outline: RecoveryOutline) => {
                  Queue.offerUnsafe(queue, outline);
                },
              };
              watchers.add(watcher);
              watcher.offer(outlineOf(read(clientId)));
              return watcher;
            }),
            (watcher) => Effect.sync(() => watchers.delete(watcher)),
          );
          return Stream.fromQueue(queue);
        }),
      ),
  };
}
