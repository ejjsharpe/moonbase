import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Effect, Fiber, Option, Stream } from 'effect';
import { WorkspaceService, type WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import type {
  RecoveryEdit,
  RecoveryEditInput,
  RecoveryLayout,
  RecoveryOutline,
} from '@moonbase/contracts/recovery';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { toWireError } from '@moonbase/contracts/workspace-errors';
import { dropReply, dropRequest, harness, openCheckout } from './split-fixture.ts';
import { isError } from './recovery-fixture.ts';

type Client = ReturnType<ReturnType<typeof harness>['startClient']>;
type Edit<K extends RecoveryEdit> = Omit<RecoveryEditInput<K>, 'clientId'>;

const layoutOf = ({ version: _v, clientId: _c, buffers: _b, ...layout }: RecoveryOutline) =>
  layout as RecoveryLayout;

/** One window's recovery edits and outline subscription, through the client's service. */
function editor({ runtime }: Client, clientId: string) {
  const edit =
    <K extends RecoveryEdit>(name: K) =>
    (input: Edit<K>) =>
      runtime.runPromise(
        Effect.flatMap(WorkspaceService, (service) =>
          (service[name] as (input: RecoveryEditInput<K>) => Effect.Effect<void, never>)({
            ...input,
            clientId,
          } as RecoveryEditInput<K>),
        ).pipe(Effect.mapError(toWireError)),
      );
  return {
    openTab: edit('openTab'),
    closeTab: edit('closeTab'),
    updateDraft: edit('updateDraft'),
    updateLayout: edit('updateLayout'),
    /** Collects the outlines `watchRecovery` publishes. */
    watch() {
      const seen: RecoveryOutline[] = [];
      const fiber = runtime.runFork(
        Effect.flatMap(WorkspaceService, (service) =>
          Stream.runForEach(service.watchRecovery({ clientId }), (outline) =>
            Effect.sync(() => {
              seen.push(outline);
            }),
          ),
        ),
      );
      return {
        seen,
        /** Waits, by polling the event loop, until `count` outlines have arrived. */
        async until(count: number) {
          for (let turn = 0; seen.length < count; turn++) {
            assert(turn < 100_000, 'outline not published');
            await new Promise((resolve) => setImmediate(resolve));
          }
        },
        stop: () => runtime.runPromise(Fiber.interrupt(fiber)),
      };
    },
    /** The window's layout as last published. */
    async layout() {
      const outline = await runtime.runPromise(
        Effect.flatMap(WorkspaceService, (service) =>
          Stream.runHead(service.watchRecovery({ clientId })),
        ),
      );
      return layoutOf(Option.getOrThrow(outline));
    },
  };
}
const load = (client: Client, clientId: string) =>
  client.client.command('loadRecovery', { clientId });
const moveWith = async (client: Client, checkout: CheckoutTarget, from: string, to: string) =>
  client.client.command('mutate', {
    id: 'move-' + from,
    clientId: 'mover',
    checkout,
    kind: 'move',
    sources: await client.client.command('inspectEntries', { checkout, paths: [from] }),
    destination: to,
  });

async function setup(h: ReturnType<typeof harness>, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(h.root, name), text);
  const { host } = await h.startHost();
  const checkout = await openCheckout(host, h.root);
  const read = (path: string) => Effect.runPromise(host.readFile({ checkout, path }));
  return { host, checkout, read, at: (path: string) => ({ checkout, path }) };
}

test('edits apply in order by buffer, are durable once they return, and a restart publishes what committed', async () => {
  const h = harness();
  try {
    const { host, at, read } = await setup(h, { 'file.txt': 'original' });
    const disk = await read('file.txt');
    let alice = h.startClient('alice', host);
    const window = editor(alice, 'window');
    await window.openTab({ bufferId: 'b1', target: at('file.txt') });
    // Keystrokes sent back to back apply in the order they were sent.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        window.updateDraft({ bufferId: 'b1', text: 'draft ' + i, disk }),
      ),
    );
    // The process ends right after the edit returned, before anything else ran.
    await alice.runtime.dispose();
    alice = h.startClient('alice', host);
    const restarted = editor(alice, 'window');
    // What committed before the crash is what the new process publishes first.
    const outlines = restarted.watch();
    await outlines.until(1);
    assert.deepEqual(outlines.seen[0].buffers, [
      { id: 'b1', target: at('file.txt'), draft: { baseline: disk.version } },
    ]);
    const loaded = (await load(alice, 'window')).state;
    assert.deepEqual(loaded.drafts, [{ target: at('file.txt'), text: 'draft 19', disk }]);
    assert.deepEqual(loaded.views[at('file.txt').checkout.checkoutId]?.openFiles, ['file.txt']);
    // A buffer with a draft closes only when told to discard it.
    await assert.rejects(restarted.closeTab({ bufferId: 'b1' }), isError('InvalidInput'));
    // Text back at its baseline is no draft.
    await restarted.updateDraft({ bufferId: 'b1', text: 'original', disk });
    assert.deepEqual((await load(alice, 'window')).state.drafts, []);
    await restarted.closeTab({ bufferId: 'b1' });
    // An edit to a buffer that is not open is refused, never recreated at a path.
    await assert.rejects(
      restarted.updateDraft({ bufferId: 'b1', text: 'late', disk }),
      isError('InvalidInput'),
    );
    // The refused close published nothing; clearing the draft and closing did.
    await outlines.until(3);
    assert.deepEqual(outlines.seen.at(-1)?.buffers, []);
    await outlines.stop();

    // Quit with an edit in flight: closing waits for it, so it is durable if it returned and
    // absent (with the earlier text kept) if it did not.
    await restarted.openTab({ bufferId: 'b2', target: at('file.txt') });
    await restarted.updateDraft({ bufferId: 'b2', text: 'before quit', disk });
    const pending = restarted
      .updateDraft({ bufferId: 'b2', text: 'at quit', disk })
      .then(() => true)
      .catch(() => false);
    await alice.runtime.dispose();
    const committed = await pending;
    alice = h.startClient('alice', host);
    assert.equal(
      (await load(alice, 'window')).state.drafts[0]?.text,
      committed ? 'at quit' : 'before quit',
    );
  } finally {
    await h.close();
  }
});

test('an edit during a save, or after its reply was lost, is never overwritten by the saved text', async () => {
  const h = harness();
  try {
    const { host, checkout, at, read } = await setup(h, { 'file.txt': 'original' });
    const save = (requestId: string, text: string, expectedVersion: string) => ({
      target: at('file.txt'),
      clientId: 'window',
      requestId,
      text,
      expectedVersion,
    });
    // The host commits the save, then its reply waits until the edit has landed.
    let committed!: () => void, release!: () => void;
    const onHost = new Promise<void>((resolve) => (committed = resolve));
    const reply = new Promise<void>((resolve) => (release = resolve));
    const held = (inner: WorkspaceHostServiceShape): WorkspaceHostServiceShape => ({
      ...inner,
      saveFile: (input) =>
        Effect.tap(inner.saveFile(input), () =>
          Effect.promise(() => {
            committed();
            return reply;
          }),
        ),
    });
    let disk = await read('file.txt');
    const alice = h.startClient('alice', host, held);
    const window = editor(alice, 'window');
    await window.openTab({ bufferId: 'b1', target: at('file.txt') });
    await window.updateDraft({ bufferId: 'b1', text: 'saving', disk });
    const saving = alice.client.command('saveFile', save('during', 'saving', disk.version));
    await onHost;
    await window.updateDraft({ bufferId: 'b1', text: 'typed during save', disk });
    release();
    const saved = await saving;
    assert.equal(saved.kind, 'saved');
    // The newer text stays, over the file text the save left.
    assert.deepEqual((await load(alice, 'window')).state.drafts, [
      { target: at('file.txt'), text: 'typed during save', disk: saved.disk },
    ]);
    // A keystroke sent before the window heard of the save keeps the baseline the save left,
    // so typing back to the saved text leaves no draft.
    await window.updateDraft({ bufferId: 'b1', text: 'typed after save', disk });
    assert.deepEqual((await load(alice, 'window')).state.drafts, [
      { target: at('file.txt'), text: 'typed after save', disk: saved.disk },
    ]);
    await window.updateDraft({ bufferId: 'b1', text: 'saving', disk: saved.disk });
    assert.deepEqual((await load(alice, 'window')).state.drafts, []);
    await alice.runtime.dispose();

    // The host saves, then the reply and every status question are lost; the next edit lands.
    // A save that never reached the host is restored only while no edit came after it.
    for (const [name, lose] of [
      ['lost-reply', dropReply('saveFile')],
      ['never-arrived', dropRequest('saveFile')],
    ] as const) {
      disk = await read('file.txt');
      let carol = h.startClient('carol-' + name, host, lose);
      const tab = editor(carol, 'window');
      await tab.openTab({ bufferId: 'b1', target: at('file.txt') });
      // Loading resolves the saves of the checkouts the window has open.
      await tab.updateLayout({
        layout: {
          ...(await tab.layout()),
          openCheckoutIds: [checkout.checkoutId],
          selectedCheckoutId: checkout.checkoutId,
        },
      });
      await tab.updateDraft({ bufferId: 'b1', text: 'sent text', disk });
      await assert.rejects(carol.client.command('saveFile', save(name, 'sent text', disk.version)));
      await tab.updateDraft({ bufferId: 'b1', text: 'newer than the save', disk });
      await carol.runtime.dispose();
      carol = h.startClient('carol-' + name, host);
      const [draft] = (await load(carol, 'window')).state.drafts;
      assert.equal(draft?.text, 'newer than the save');
      // A lost reply's save settles from the host: the newer draft is over the text it saved.
      assert.equal(draft?.disk.text, name === 'lost-reply' ? 'sent text' : disk.text);
      await carol.runtime.dispose();
    }
  } finally {
    await h.close();
  }
});

test('a move takes its buffers along, and a clean buffer at the destination gives way to a dirty one', async () => {
  const h = harness();
  try {
    const { host, checkout, at, read } = await setup(h, {
      'file.txt': 'original',
      'second.txt': 'second',
      'p.txt': 'p',
      'q.txt': 'q',
    });
    const disk = await read('file.txt');
    const alice = h.startClient('alice', host);
    const window = editor(alice, 'window');
    const open = async (bufferId: string, path: string, text?: string) => {
      await window.openTab({ bufferId, target: at(path) });
      if (text !== undefined)
        await window.updateDraft({ bufferId, text, disk: await read(path).catch(() => disk) });
    };
    await open('clean', 'file.txt');
    await open('dirty', 'second.txt', 'dirty text');
    // A buffer with a draft at a path that does not exist yet holds it against a move.
    await open('holder', 'taken.txt', 'holder text');
    await open('own', 'p.txt', 'own text');
    await open('q', 'q.txt');
    const position = { file: { line: 3, column: 1, top: 40, left: 0 } };
    const layout = await window.layout();
    layout.views[checkout.checkoutId] = {
      ...layout.views[checkout.checkoutId]!,
      active: 'q',
      preview: 'clean',
      fileViews: { clean: 'file' },
      positions: { clean: position, q: position },
    };
    await window.updateLayout({ layout });
    // Another installation moves two files; the feed brings the moves in when alice loads.
    const bob = h.startClient('bob', host);
    await moveWith(bob, checkout, 'file.txt', 'moved.txt');
    await moveWith(bob, checkout, 'second.txt', 'taken.txt');
    const loaded = await load(alice, 'window');
    // The draft whose destination held another draft stays where it was, and is named.
    assert(loaded.errors.some((error) => error.includes('second.txt')));
    // The clean buffer's first keystroke and a layout written before the window heard of the
    // move both land on the moved buffer, not at the old path.
    await window.updateDraft({ bufferId: 'clean', text: 'typed after move', disk });
    await window.updateLayout({ layout });
    // This client's own move of a dirty file onto an open clean one replaces it: the clean
    // buffer gives way, and its tab, focus and position go to the moved draft.
    await alice.client.command('mutate', {
      id: 'replace',
      clientId: 'window',
      checkout,
      kind: 'move',
      sources: await alice.client.command('inspectEntries', { checkout, paths: ['p.txt'] }),
      replacements: await alice.client.command('inspectEntries', { checkout, paths: ['q.txt'] }),
      destination: 'q.txt',
    });
    const state = (await load(alice, 'window')).state;
    const view = state.views[checkout.checkoutId]!;
    assert.deepEqual(view.openFiles, ['moved.txt', 'second.txt', 'taken.txt', 'q.txt']);
    assert.equal(view.active, 'q.txt');
    assert.equal(view.preview, 'moved.txt');
    assert.deepEqual(view.positions, { 'moved.txt': position, 'q.txt': position });
    assert.deepEqual(
      state.drafts.map((d) => [d.target.path, d.text]),
      [
        ['moved.txt', 'typed after move'],
        ['second.txt', 'dirty text'],
        ['taken.txt', 'holder text'],
        ['q.txt', 'own text'],
      ],
    );
  } finally {
    await h.close();
  }
});

test('Trash keeps an open buffer and its draft, and an uncertain Trash keeps its draft from being dropped', async () => {
  const h = harness();
  try {
    const { host, checkout, at, read } = await setup(h, {
      'file.txt': 'original',
      'other.txt': 'other',
    });
    const disk = await read('file.txt');
    const alice = h.startClient('alice', host);
    const window = editor(alice, 'window');
    await window.openTab({ bufferId: 'b1', target: at('file.txt') });
    await window.updateDraft({ bufferId: 'b1', text: 'kept', disk });
    const bob = h.startClient('bob', host);
    await bob.client.command('mutate', {
      id: 'trash',
      clientId: 'trasher',
      checkout,
      kind: 'trash',
      sources: await bob.client.command('inspectEntries', { checkout, paths: ['file.txt'] }),
    });
    await load(alice, 'window');
    await window.updateDraft({ bufferId: 'b1', text: 'edited after trash', disk });
    assert.deepEqual((await load(alice, 'window')).state.drafts, [
      { target: at('file.txt'), text: 'edited after trash', disk },
    ]);
    await assert.rejects(window.closeTab({ bufferId: 'b1' }), isError('InvalidInput'));

    // This client's own Trash whose outcome is unknown may still own the draft.
    const otherDisk = await read('other.txt');
    let carol = h.startClient('carol', host, dropReply('mutate'));
    let tab = editor(carol, 'window');
    await tab.openTab({ bufferId: 'b2', target: at('other.txt') });
    await tab.updateDraft({ bufferId: 'b2', text: 'unsaved', disk: otherDisk });
    await assert.rejects(
      carol.client.command('mutate', {
        id: 'uncertain-trash',
        clientId: 'window',
        checkout,
        kind: 'trash',
        sources: await carol.client.command('inspectEntries', { checkout, paths: ['other.txt'] }),
      }),
    );
    await assert.rejects(
      tab.updateDraft({ bufferId: 'b2', text: 'other', disk: otherDisk }),
      isError('Persistence'),
    );
    await assert.rejects(tab.closeTab({ bufferId: 'b2', discard: true }), isError('Persistence'));
    assert.equal((await load(carol, 'window')).state.drafts[0]?.text, 'unsaved');
    // Once the host says what happened, the user may discard it.
    await carol.runtime.dispose();
    carol = h.startClient('carol', host);
    tab = editor(carol, 'window');
    assert.equal(
      (await carol.client.command('operationStatus', { clientId: 'window', id: 'uncertain-trash' }))
        ?.outcome,
      'completed',
    );
    await tab.closeTab({ bufferId: 'b2', discard: true });
    assert.deepEqual((await load(carol, 'window')).state.drafts, []);
  } finally {
    await h.close();
  }
});

test('two windows edit their own recoveries in one store, and each outline changes only with its own state', async () => {
  const h = harness();
  try {
    const { host, checkout, at, read } = await setup(h, { 'file.txt': 'original' });
    const disk = await read('file.txt');
    const alice = h.startClient('alice', host);
    const one = editor(alice, 'one'),
      two = editor(alice, 'two');
    await one.openTab({ bufferId: 'b', target: at('file.txt') });
    await two.openTab({ bufferId: 'b', target: at('file.txt') });
    const outlines = one.watch();
    await outlines.until(1);
    await Promise.all([
      one.updateDraft({ bufferId: 'b', text: 'one a', disk }),
      two.updateDraft({ bufferId: 'b', text: 'two a', disk }),
      one.updateDraft({ bufferId: 'b', text: 'one b', disk }),
      two.updateDraft({ bufferId: 'b', text: 'two b', disk }),
    ]);
    await one.updateLayout({ layout: { ...layoutOf(outlines.seen[0]), sidebarWidth: 300 } });
    // The draft appearing and the layout publish; the second keystroke and the other window's
    // edits publish nothing.
    await outlines.until(3);
    assert.equal(outlines.seen.length, 3);
    assert.deepEqual(outlines.seen[1].buffers[0]?.draft, { baseline: disk.version });
    assert.equal(outlines.seen[2].sidebarWidth, 300);
    await outlines.stop();
    // A move re-paths both windows' buffers, and each window's next edit lands there.
    await moveWith(h.startClient('bob', host), checkout, 'file.txt', 'moved.txt');
    await load(alice, 'one');
    await two.updateDraft({ bufferId: 'b', text: 'two c', disk });
    for (const [window, text] of [
      ['one', 'one b'],
      ['two', 'two c'],
    ])
      assert.deepEqual(
        (await load(alice, window)).state.drafts.map((d) => [d.target.path, d.text]),
        [['moved.txt', text]],
      );
  } finally {
    await h.close();
  }
});

test('the renderer snapshot keeps buffer IDs by path, edits fence older snapshots, and an unreadable recovery is never written', async () => {
  const h = harness();
  try {
    const { host, checkout, at, read } = await setup(h, { 'file.txt': 'original' });
    const disk = await read('file.txt');
    const alice = h.startClient('alice', host);
    const snapshot = (revision: number, text: string) =>
      alice.client.command('persistRecovery', {
        clientId: 'window',
        requestId: 'snapshot-' + revision,
        expectedRevision: revision,
        state: {
          version: 1,
          clientId: 'window',
          checkouts: [checkout],
          openCheckoutIds: [checkout.checkoutId],
          selectedCheckoutId: checkout.checkoutId,
          views: {
            [checkout.checkoutId]: {
              openFiles: ['file.txt'],
              active: 'file.txt',
              preview: null,
              fileViews: { 'file.txt': 'file', 'closed.txt': 'unstaged' },
              positions: {},
              tree: { expanded: [], selected: [], focus: '', scroll: 0 },
            },
          },
          drafts: [{ target: at('file.txt'), text, disk }],
          recentFiles: [],
          sidebarWidth: 270,
        },
      });
    await snapshot(0, 'from snapshot');
    const window = editor(alice, 'window');
    const outlines = window.watch();
    await outlines.until(1);
    const [buffer] = outlines.seen[0].buffers;
    assert.deepEqual(outlines.seen[0].views[checkout.checkoutId]?.remembered, {
      'closed.txt': { view: 'unstaged' },
    });
    await outlines.stop();
    // The same path keeps its buffer across snapshots, so an edit by ID still finds it.
    await snapshot(1, 'second snapshot');
    await window.updateDraft({ bufferId: buffer!.id, text: 'edited by id', disk });
    const loaded = await load(alice, 'window');
    assert.equal(loaded.state.drafts[0]?.text, 'edited by id');
    assert.equal(loaded.state.views[checkout.checkoutId]?.fileViews['closed.txt'], 'unstaged');
    // The edit was the window's own word: a snapshot made before it is refused.
    await assert.rejects(snapshot(2, 'stale snapshot'), isError('Conflict'));
    await snapshot(loaded.revision, 'current snapshot');
    await alice.runtime.dispose();
    const database = new DatabaseSync(join(h.base, 'alice', 'moonbase-workspace-v1.sqlite'));
    try {
      database.prepare('UPDATE recovery SET body=? WHERE client=?').run('{', 'window');
      const before = database.prepare('SELECT revision, body FROM recovery').all();
      const restarted = h.startClient('alice', host);
      await assert.rejects(
        editor(restarted, 'window').updateDraft({ bufferId: buffer!.id, text: 'lost?', disk }),
        isError('Persistence'),
      );
      assert.deepEqual(database.prepare('SELECT revision, body FROM recovery').all(), before);
    } finally {
      database.close();
    }
  } finally {
    await h.close();
  }
});
