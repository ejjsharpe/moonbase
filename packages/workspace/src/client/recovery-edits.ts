import { Effect, Semaphore } from 'effect';
import {
  emptyBufferView,
  emptyRecoveryState,
  type RecoveryEditInput,
  type RecoveryState,
  type RememberedFile,
} from '@moonbase/contracts/recovery';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  InvalidRecoveryRequestError,
  RecoveryPublicationError,
} from '@moonbase/contracts/workspace-errors';
import { attempt, type WorkspaceFailure } from '../attempt.ts';
import { hash, key, same } from '../validation.ts';
import { followCheckouts } from './feed-sync.ts';
import type { RecoveryContext } from './recovery-context.ts';

const invalidState = () => new InvalidRecoveryRequestError({ problem: 'invalid-state' });
const viewOf = (state: RecoveryState, checkoutId: string) =>
  (state.views[checkoutId] ??= emptyBufferView());

/**
 * The recovery store's edits, keyed by buffer ID. Each client's edits apply one at a time in the
 * order they arrive; each reads, changes and writes the recovery in one transaction (so a save's
 * or an operation's publication never interleaves with it) and returns once it committed. An
 * edit is the client's own word: it advances the client's publication, so a save begun before it
 * never restores older text over it.
 */
export const makeRecoveryEdits = (context: RecoveryContext) => {
  const { store } = context;
  const turns = new Map<string, Semaphore.Semaphore>();
  const inOrder = <A>(clientId: string, work: Effect.Effect<A, WorkspaceFailure>) =>
    Effect.suspend(() => {
      let turn = turns.get(clientId);
      if (!turn) turns.set(clientId, (turn = Semaphore.makeUnsafe(1)));
      return Semaphore.withPermit(turn)(work);
    });
  /** Applies `change` to the client's committed recovery; it returns `false` when it changed nothing. */
  const commit = (clientId: string, change: (state: RecoveryState) => boolean | void) =>
    store.transaction(() => {
      const stored = store.readRecovery(clientId);
      const state = stored?.state ?? emptyRecoveryState(clientId);
      if (change(state) === false) return;
      store.writeClientRecovery(clientId, stored?.revision ?? 0, state);
    });
  /** Verifies, and follows the feed of, the checkouts the recovery does not list yet. */
  const admitCheckouts = (clientId: string, targets: CheckoutTarget[]) =>
    Effect.gen(function* () {
      const listed = (yield* attempt(() => store.readRecovery(clientId)))?.state.checkouts ?? [];
      const added = targets.filter((t) => !listed.some((c) => same(c, t)));
      for (const target of added) yield* context.host.verifyCheckout(target);
      if (added.length) yield* followCheckouts(context, added);
      return added;
    });
  /** Refuses to drop a draft an uncertain operation may still own. */
  const assertDroppable = (target: { checkout: CheckoutTarget; path: string }) => {
    if (context.isDraftHeld(target))
      throw new RecoveryPublicationError({ pending: 'uncertain-draft' });
  };

  const openTab = ({ clientId, bufferId, target }: RecoveryEditInput<'openTab'>) =>
    inOrder(
      clientId,
      Effect.gen(function* () {
        const added = yield* admitCheckouts(clientId, [target.checkout]);
        yield* commit(clientId, (state) => {
          // An ID opened again names a buffer the client has, not one a move replaced.
          store.delete('replaced-buffers', key(clientId, bufferId));
          const open = state.buffers.find((b) => b.id === bufferId);
          // Already open: it stays where it is now, however the caller named it.
          if (open) {
            const view = viewOf(state, open.target.checkout.checkoutId);
            if (view.tabs.includes(bufferId)) return false;
            view.tabs.push(bufferId);
            return;
          }
          if (state.buffers.some((b) => same(b.target, target)))
            throw new InvalidRecoveryRequestError({ problem: 'buffer-target' });
          if (!state.checkouts.some((c) => same(c, target.checkout))) {
            if (!added.some((c) => same(c, target.checkout))) throw invalidState();
            state.checkouts.push(target.checkout);
          }
          state.buffers.push({ id: bufferId, target });
          const view = viewOf(state, target.checkout.checkoutId);
          view.tabs.push(bufferId);
          const memory = view.remembered[target.path];
          if (memory) {
            if (memory.view) view.fileViews[bufferId] = memory.view;
            if (memory.positions) view.positions[bufferId] = memory.positions;
            delete view.remembered[target.path];
          }
        });
      }),
    );

  const closeTab = ({ clientId, bufferId, discard }: RecoveryEditInput<'closeTab'>) =>
    inOrder(
      clientId,
      commit(clientId, (state) => {
        const index = state.buffers.findIndex((b) => b.id === bufferId);
        // Closing a buffer a move replaced is how its client says it has dealt with it.
        if (index < 0) {
          store.delete('replaced-buffers', key(clientId, bufferId));
          return false;
        }
        const { target, draft } = state.buffers[index];
        if (draft) {
          if (!discard) throw new InvalidRecoveryRequestError({ problem: 'draft-open' });
          assertDroppable(target);
        }
        state.buffers.splice(index, 1);
        const view = state.views[target.checkout.checkoutId];
        if (!view) return;
        view.tabs = view.tabs.filter((id) => id !== bufferId);
        if (view.preview === bufferId) view.preview = null;
        if (view.active === bufferId) {
          const tabAt = (path: string) =>
            state.buffers.find(
              (b) =>
                view.tabs.includes(b.id) && same(b.target, { checkout: target.checkout, path }),
            )?.id;
          view.active =
            state.recentFiles
              .filter((t) => same(t.checkout, target.checkout))
              .map((t) => tabAt(t.path))
              .find((id) => id !== undefined) ??
            view.tabs[0] ??
            null;
        }
        // Its view and positions are remembered for the file, as when the file is opened again.
        const memory: RememberedFile = {};
        if (view.fileViews[bufferId]) memory.view = view.fileViews[bufferId];
        if (view.positions[bufferId]) memory.positions = view.positions[bufferId];
        delete view.fileViews[bufferId];
        delete view.positions[bufferId];
        if (memory.view || memory.positions) view.remembered[target.path] = memory;
      }),
    );

  const updateDraft = ({ clientId, bufferId, text, disk }: RecoveryEditInput<'updateDraft'>) =>
    inOrder(
      clientId,
      Effect.gen(function* () {
        if (hash(disk.text) !== disk.version) return yield* invalidState();
        yield* commit(clientId, (state) => {
          const buffer = state.buffers.find((b) => b.id === bufferId);
          if (!buffer)
            throw new InvalidRecoveryRequestError({
              problem: store.get('replaced-buffers', key(clientId, bufferId))
                ? 'buffer-replaced'
                : 'unknown-buffer',
            });
          const { draft } = buffer;
          if (!draft) {
            if (text === disk.text) return false;
            buffer.draft = { text, disk };
            return;
          }
          // A draft keeps the baseline the store holds: a save that settled since the caller last
          // heard moved it, and the caller's older one would leave the draft over text no longer
          // on disk. The draft clears only when caller and store agree on its baseline and the
          // text is that baseline's; text the caller holds over another file text is unsaved.
          if (text === draft.disk.text && disk.version === draft.disk.version) {
            assertDroppable(buffer.target);
            delete buffer.draft;
            return;
          }
          if (draft.text === text) return false;
          draft.text = text;
        });
      }),
    );

  const updateLayout = ({ clientId, layout }: RecoveryEditInput<'updateLayout'>) =>
    inOrder(
      clientId,
      Effect.gen(function* () {
        const added = yield* admitCheckouts(clientId, layout.checkouts);
        yield* commit(clientId, (state) => {
          const known = (t: CheckoutTarget) =>
            state.checkouts.some((c) => same(c, t)) || added.some((c) => same(c, t));
          if (!layout.checkouts.every(known)) throw invalidState();
          const checkouts = [...layout.checkouts];
          // A checkout a buffer is in stays listed; one listed anew under its ID (a folder that
          // became a repository) takes its buffers with it.
          for (const buffer of state.buffers) {
            const listed = checkouts.find(
              (c) => c.checkoutId === buffer.target.checkout.checkoutId,
            );
            if (listed) buffer.target = { ...buffer.target, checkout: listed };
            else checkouts.push(buffer.target.checkout);
          }
          Object.assign(state, structuredClone(layout), { checkouts });
          if (layout.followActiveFile === undefined) delete state.followActiveFile;
        });
      }),
    );

  return { openTab, closeTab, updateDraft, updateLayout };
};
