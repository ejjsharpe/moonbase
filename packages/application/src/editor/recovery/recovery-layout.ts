import type {
  BufferView,
  RecoveryLayout,
  RecoveryState,
  RememberedFile,
} from '@moonbase/contracts/recovery';
import type {
  CheckoutTarget,
  CheckoutTree,
  FilePositions,
  FileTarget,
  FileView,
} from '@moonbase/contracts/workspace';
import { fileKey } from '../keys.ts';

// The recovery store names an open file by its buffer (epic #273 D3); the editor shows its tabs
// by path. These translate between the two: the store's layout read as the editor shows it, and
// the editor's view written back as the store's layout, with each tab's buffer ID.

/** One checkout's view as the editor shows it: its tabs and what it remembers, by path. */
export type CheckoutView = {
  openFiles: string[];
  /** The active tab's path, or `''`. */
  active: string;
  preview: string | null;
  fileViews: Map<string, FileView>;
  positions: Map<string, FilePositions>;
  tree: CheckoutTree;
};
/** The editor's recovery as it shows it: the store's layout, with tabs named by path. */
export type EditorRecovery = Omit<RecoveryLayout, 'views'> & {
  clientId: string;
  views: Map<string, CheckoutView>;
};
/** An open tab: its buffer in the store and the file it shows. */
export type EditorTab = { id: string; target: FileTarget };

export const emptyEditorRecovery = (clientId: string): EditorRecovery => ({
  clientId,
  checkouts: [],
  openCheckoutIds: [],
  selectedCheckoutId: null,
  views: new Map(),
  recentFiles: [],
  sidebarWidth: 270,
  followActiveFile: true,
});
export const emptyCheckoutView = (): CheckoutView => ({
  openFiles: [],
  active: '',
  preview: null,
  fileViews: new Map(),
  positions: new Map(),
  tree: { expanded: [], selected: [], focus: '', scroll: 0, hideIgnoredFiles: false },
});

/** A stored recovery as the editor shows it, with every buffer by its file's key. */
export function readRecoveryState(state: RecoveryState) {
  const buffers = new Map(state.buffers.map((b) => [b.id, b]));
  const views = new Map<string, CheckoutView>();
  for (const [checkoutId, view] of Object.entries(state.views)) {
    const pathOf = (id: string | null) => {
      const buffer = id === null ? undefined : buffers.get(id);
      return buffer?.target.checkout.checkoutId === checkoutId ? buffer.target.path : undefined;
    };
    const openFiles = view.tabs.flatMap((id) => pathOf(id) ?? []);
    const shown: CheckoutView = {
      openFiles,
      active:
        (view.active !== null && view.tabs.includes(view.active) && pathOf(view.active)) || '',
      preview:
        (view.preview !== null && view.tabs.includes(view.preview) && pathOf(view.preview)) || null,
      fileViews: new Map(),
      positions: new Map(),
      tree: structuredClone(view.tree),
    };
    // What the view remembers of closed files, then what its buffers have.
    for (const [path, memory] of Object.entries(view.remembered)) {
      if (memory.view) shown.fileViews.set(path, memory.view);
      if (memory.positions) shown.positions.set(path, structuredClone(memory.positions));
    }
    for (const [id, mode] of Object.entries(view.fileViews)) {
      const path = pathOf(id);
      if (path !== undefined) shown.fileViews.set(path, mode);
    }
    for (const [id, positions] of Object.entries(view.positions)) {
      const path = pathOf(id);
      if (path !== undefined) shown.positions.set(path, structuredClone(positions));
    }
    views.set(checkoutId, shown);
  }
  const { version: _version, buffers: _buffers, views: _views, ...layout } = state;
  const recovery: EditorRecovery = { ...structuredClone(layout), views };
  const tabs = new Map<string, EditorTab>(
    state.buffers.map((b) => [fileKey(b.target), { id: b.id, target: structuredClone(b.target) }]),
  );
  return { recovery, tabs };
}

/** The store's layout for the editor's recovery; `tabs` names each open file's buffer. */
export function toRecoveryLayout(
  recovery: EditorRecovery,
  tabs: ReadonlyMap<string, EditorTab>,
): RecoveryLayout {
  const checkouts = new Map(recovery.checkouts.map((c) => [c.checkoutId, c]));
  // Built as maps and written as own properties, so a path such as `__proto__` stays a key.
  const views = new Map<string, BufferView>();
  for (const [checkoutId, view] of recovery.views) {
    const checkout: CheckoutTarget | undefined = checkouts.get(checkoutId);
    if (!checkout) continue;
    const idOf = (path: string) => tabs.get(fileKey({ checkout, path }))?.id;
    const ids = [...new Set(view.openFiles.flatMap((path) => idOf(path) ?? []))];
    const tabOf = (path: string | null) => {
      const id = path ? idOf(path) : undefined;
      return id !== undefined && ids.includes(id) ? id : null;
    };
    const fileViews = new Map<string, FileView>(),
      positions = new Map<string, FilePositions>(),
      remembered = new Map<string, RememberedFile>();
    const remember = (path: string) => {
      const memory = remembered.get(path) ?? {};
      remembered.set(path, memory);
      return memory;
    };
    for (const [path, mode] of view.fileViews) {
      const id = tabOf(path);
      if (id) fileViews.set(id, mode);
      else remember(path).view = mode;
    }
    for (const [path, filePositions] of view.positions) {
      const id = tabOf(path);
      if (id) positions.set(id, structuredClone(filePositions));
      else remember(path).positions = structuredClone(filePositions);
    }
    views.set(checkoutId, {
      tabs: ids,
      active: tabOf(view.active),
      preview: tabOf(view.preview),
      fileViews: Object.fromEntries(fileViews),
      positions: Object.fromEntries(positions),
      remembered: Object.fromEntries(remembered),
      tree: structuredClone(view.tree),
    });
  }
  const { clientId: _clientId, views: _views, ...layout } = recovery;
  return { ...structuredClone(layout), views: Object.fromEntries(views) };
}
