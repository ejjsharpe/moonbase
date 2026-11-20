import { Equal } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import { followRef } from '../../follow-ref.ts';
import type { CheckoutView } from '../recovery/recovery-layout.ts';
import type { EditorViewsShape } from './views-service.ts';

/** A checkout's tabs: what its tab strip shows, without the positions that move as one types. */
export type CheckoutTabs = Pick<CheckoutView, 'openFiles' | 'active' | 'preview' | 'fileViews'>;

/**
 * The editor's views, and each piece of them a view reads. An update keeps the identity of what it
 * didn't change, so a change notifies only the atoms whose piece it changed.
 */
export function makeViewsAtoms(views: EditorViewsShape) {
  const state = followRef(views.state);
  /** The whole recovery layout, which every cursor move changes: read it only when acting. */
  const recovery = Atom.readable((get) => get(state).recovery);
  /** One checkout's view, positions included, by its ID. */
  const checkoutView = Atom.family((checkoutId: string) =>
    Atom.readable((get): CheckoutView | undefined => get(recovery).views.get(checkoutId)),
  );
  return {
    state,
    recovery,
    /** The checkouts the editor knows, which are open, and which is selected. */
    checkouts: Atom.readable((get) => {
      const { checkouts, openCheckoutIds, selectedCheckoutId } = get(recovery);
      return { checkouts, openCheckoutIds, selectedCheckoutId };
    }).pipe(Atom.withEquality(Equal.equals)),
    sidebarWidth: Atom.readable((get) => get(recovery).sidebarWidth),
    followActiveFile: Atom.readable((get) => get(recovery).followActiveFile ?? true),
    checkoutView,
    /** One checkout's tabs, by its ID. */
    checkoutTabs: Atom.family((checkoutId: string) =>
      Atom.readable((get): CheckoutTabs | undefined => {
        const view = get(checkoutView(checkoutId));
        return (
          view && {
            openFiles: view.openFiles,
            active: view.active,
            preview: view.preview,
            fileViews: view.fileViews,
          }
        );
      }).pipe(Atom.withEquality(Equal.equals)),
    ),
    /** One checkout's files tree, by its ID. */
    checkoutTree: Atom.family((checkoutId: string) =>
      Atom.readable((get) => get(checkoutView(checkoutId))?.tree),
    ),
  };
}
