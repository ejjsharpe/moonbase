import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from 'effect';
import type * as Atom from 'effect/reactivity/Atom';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import {
  checkoutKey,
  fileKey,
  makeEditorAtoms,
  type EditorServices,
} from '@moonbase/application/editor';
import { checkout, fixture, target } from './editor-fixture.ts';

test('typing in a buffer notifies none of the atoms the files tree, the tabs or the workbench read', async () => {
  const f = await fixture('atoms-typing');
  const registry = AtomRegistry.make();
  const atoms = makeEditorAtoms(f.editor.context as Context.Context<EditorServices>);
  const typed = target('a.ts');
  try {
    await f.editor.open(typed, { intent: 'keep' });
    await f.editor.open(target('b.ts'), { intent: 'keep' });
    // The pieces the workbench's root, its files tree and its tab strip subscribe to.
    const read: Record<string, Atom.Atom<unknown>> = {
      checkouts: atoms.views.checkouts,
      tabs: atoms.views.checkoutTabs(checkout.checkoutId),
      tree: atoms.views.checkoutTree(checkout.checkoutId),
      followActiveFile: atoms.views.followActiveFile,
      sidebarWidth: atoms.views.sidebarWidth,
      listings: atoms.discovery.listings(checkoutKey(checkout)),
      git: atoms.discovery.git(checkoutKey(checkout)),
      dirtyPaths: atoms.buffers.dirtyPaths(checkoutKey(checkout)),
      typedStatus: atoms.buffers.status(fileKey(typed)),
      otherStatus: atoms.buffers.status(fileKey(target('b.ts'))),
      ready: atoms.session.ready,
      preserving: atoms.session.preserving,
      closePrompt: atoms.closePrompt,
      mutating: atoms.mutating,
    };
    const notified = new Map<string, number>();
    // Read once, as a view reads what it renders, so each change after reaches its listener.
    registry.mount(atoms.snapshot);
    for (const [name, atom] of Object.entries(read)) {
      registry.subscribe(atom, () => notified.set(name, (notified.get(name) ?? 0) + 1));
      registry.get(atom);
    }
    /** Types `text` at `column`, as Monaco sends it, once the atoms have it. */
    const type = (text: string, column: number) =>
      new Promise<void>((resolve) => {
        const landed = () =>
          registry.get(atoms.buffers.state).buffers.get(fileKey(typed))?.text === text &&
          registry.get(atoms.views.checkoutView(checkout.checkoutId))?.positions.get(typed.path)
            ?.file?.column === column;
        const off = registry.subscribe(atoms.snapshot, () => {
          if (!landed()) return;
          off();
          resolve();
        });
        f.editor.edit(typed, text);
        f.editor.position(typed, 'file', { line: 1, column, top: 0, left: 0 });
      });
    // The first keystroke makes the buffer dirty, which its tab and the tree show.
    await type('const a = 1;x', 14);
    assert.equal(registry.get(atoms.buffers.status(fileKey(typed)))?.dirty, true);
    notified.clear();
    await type('const a = 1;xy', 15);
    await type('const a = 1;xyz', 16);
    await f.editor.flush();
    assert.deepEqual(Object.fromEntries(notified), {});
  } finally {
    registry.dispose();
    await f.dispose();
  }
});
