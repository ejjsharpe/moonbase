import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as Atom from 'effect/reactivity/Atom';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { getChatAtoms } from '../../src/chat/chat-atoms.ts';
import { chatFixture, openChat, waitFor } from './chat-fixture.ts';

test("typing a draft tells only the drafts' readers, not the list, header or transcript", async (t) => {
  const f = await chatFixture(t, { local: true });
  await f.start();
  await openChat(f);
  const atoms = getChatAtoms(f.services());
  assert.equal(getChatAtoms(f.services()), atoms, 'one set of atoms per chat');
  const registry = AtomRegistry.make();
  const { drafts, fileSearch: _, ...others } = atoms;
  const told = new Map<string, number>();
  for (const [name, atom] of Object.entries(others) as [string, Atom.Atom<unknown>][]) {
    registry.get(atom);
    registry.subscribe(atom, () => told.set(name, (told.get(name) ?? 0) + 1));
  }
  registry.get(drafts);
  registry.subscribe(drafts, () => {});
  await f.setDraft('Hello');
  await f.setDraft('Hello there');
  await waitFor(() => registry.get(drafts).draft === 'Hello there');
  assert.deepEqual([...told], []);
  // A change the list does show still reaches it.
  await f.markSeen('chat', '2030-01-01T00:00:00Z');
  await waitFor(() => told.has('seen'));
});
