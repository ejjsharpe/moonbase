import { randomUUID } from 'node:crypto';
import type { CheckoutView, EditorRecovery, FileTarget } from '@moonbase/contracts/workspace';
import type {
  BufferView,
  RecoveryBuffer,
  RecoveryState,
  RememberedFile,
} from '@moonbase/contracts/recovery';
import { canonical } from '../validation.ts';

// The renderer still publishes and loads path-keyed snapshots (`EditorRecovery`) until CL-13
// moves it to the store's edits. These translate at that one boundary: a path the renderer names
// keeps the buffer the store already holds for it, and gets a new one otherwise.

const targetKey = (target: FileTarget) => canonical(target);

/** The store's recovery for a renderer's snapshot, keeping the buffer IDs `retained` has. */
export function fromLegacyRecovery(
  legacy: EditorRecovery,
  retained: RecoveryState | null,
  mintId: () => string = randomUUID,
): RecoveryState {
  const known = new Map((retained?.buffers ?? []).map((b) => [targetKey(b.target), b.id]));
  const buffers = new Map<string, RecoveryBuffer>();
  const bufferFor = (target: FileTarget) => {
    const key = targetKey(target);
    let buffer = buffers.get(key);
    if (!buffer) buffers.set(key, (buffer = { id: known.get(key) ?? mintId(), target }));
    return buffer;
  };
  // Drafts first, so buffers keep the drafts' order and a reload lists them as published.
  for (const { target, text, disk } of legacy.drafts) bufferFor(target).draft = { text, disk };
  const checkouts = new Map(legacy.checkouts.map((c) => [c.checkoutId, c]));
  const views: Record<string, BufferView> = {};
  for (const [checkoutId, view] of Object.entries(legacy.views)) {
    const checkout = checkouts.get(checkoutId)!;
    const idOf = (path: string) => bufferFor({ checkout, path }).id;
    const tabs = view.openFiles.map(idOf);
    const held = (path: string) => buffers.has(targetKey({ checkout, path }));
    const next: BufferView = {
      tabs,
      active: view.active === '' ? null : idOf(view.active),
      preview: view.preview === null ? null : idOf(view.preview),
      fileViews: {},
      positions: {},
      remembered: {},
      tree: view.tree,
    };
    const remember = (path: string) => (next.remembered[path] ??= {});
    for (const [path, mode] of Object.entries(view.fileViews))
      if (held(path)) next.fileViews[idOf(path)] = mode;
      else remember(path).view = mode;
    for (const [path, positions] of Object.entries(view.positions))
      if (held(path)) next.positions[idOf(path)] = positions;
      else remember(path).positions = positions;
    views[checkoutId] = next;
  }
  const { drafts: _drafts, views: _views, version: _version, ...layout } = legacy;
  return { ...layout, version: 2, views, buffers: [...buffers.values()] };
}

/** The renderer's path-keyed snapshot of the store's recovery. */
export function toLegacyRecovery(state: RecoveryState): EditorRecovery {
  const paths = new Map(state.buffers.map((b) => [b.id, b.target.path]));
  const path = (id: string) => paths.get(id)!;
  const views: Record<string, CheckoutView> = {};
  for (const [checkoutId, view] of Object.entries(state.views)) {
    const remembered = Object.entries(view.remembered);
    const memory = <K extends keyof RememberedFile>(field: K) =>
      Object.fromEntries(
        remembered.flatMap(([p, file]) => (file[field] === undefined ? [] : [[p, file[field]]])),
      ) as Record<string, NonNullable<RememberedFile[K]>>;
    const byPath = <V>(entries: Record<string, V>) =>
      Object.fromEntries(Object.entries(entries).map(([id, value]) => [path(id), value]));
    views[checkoutId] = {
      openFiles: view.tabs.map(path),
      active: view.active === null ? '' : path(view.active),
      preview: view.preview === null ? null : path(view.preview),
      fileViews: { ...memory('view'), ...byPath(view.fileViews) },
      positions: { ...memory('positions'), ...byPath(view.positions) },
      tree: view.tree,
    };
  }
  const { buffers, views: _views, version: _version, ...layout } = state;
  return {
    ...layout,
    version: 1,
    views,
    drafts: buffers.flatMap((b) =>
      b.draft ? [{ target: b.target, text: b.draft.text, disk: b.draft.disk }] : [],
    ),
  };
}
