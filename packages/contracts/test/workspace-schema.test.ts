import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import {
  ApplicationError,
  emptyRecovery,
  type WorkspaceCommand,
  type CommandInput,
  type CommandOutput,
} from '@moonbase/contracts/workspace';
import {
  decodeWorkspaceInput,
  decodeWorkspaceOutput,
  decodeEditorRecovery,
  decodeWorkspaceEvent,
  decodeWorkspaceWatchInput,
  isWorkspaceCommand,
} from '@moonbase/contracts/workspace-schema';
import {
  decodeConnectionInput,
  decodeConnectionOutput,
  decodeConnectionProfile,
  decodeConnectionSnapshot,
  isConnectionCommand,
} from '@moonbase/contracts/connection-schema';
import { decodeApplicationErrorDTO } from '@moonbase/contracts/error-schema';
import { decodeChatHostHealth } from '@moonbase/contracts/host-schema';

const checkout = {
  hostId: 'host',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/checkout',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const folder = {
  hostId: 'host',
  checkoutId: 'folder',
  projectId: 'folder-project',
  root: '/folder',
  vcs: 'none' as const,
};
const target = { checkout, path: 'file.txt' };
const disk = { text: '', version: 'version' };
const entry = { target, identity: 'inode', directory: false };
const operation = {
  id: 'operation',
  clientId: 'client',
  checkout,
  kind: 'copy' as const,
  sources: [entry],
  destination: 'copy.txt',
};
const receipt = { clientId: 'client', requestId: 'publication', previousRevision: 1, revision: 2 };
const result = {
  ...operation,
  recoveryChanges: [receipt],
  outcome: 'completed' as const,
  items: [{ source: target.path, destination: 'copy.txt', outcome: 'completed' as const }],
};
const state = {
  ...emptyRecovery('client'),
  checkouts: [checkout],
  openCheckoutIds: [checkout.checkoutId],
  selectedCheckoutId: checkout.checkoutId,
  drafts: [{ target, text: 'draft', disk }],
  views: {
    [checkout.checkoutId]: {
      openFiles: [target.path],
      active: target.path,
      preview: null,
      fileViews: { [target.path]: 'file' as const },
      positions: { [target.path]: { 'file:original': { line: 1, column: 1, top: 0, left: 0 } } },
      tree: { expanded: [''], selected: [], focus: '', scroll: 0, hideIgnoredFiles: true },
    },
  },
};
const inputs = {
  openCheckout: { root: checkout.root },
  readFile: target,
  saveFile: {
    target,
    clientId: 'client',
    requestId: 'save',
    text: '',
    expectedVersion: disk.version,
  },
  listDirectory: { checkout, path: '', hideIgnored: false },
  getIgnoredPaths: { checkout, path: '', paths: [target.path] },
  gitStatus: { checkout },
  listWorktrees: { checkout },
  createWorktree: { checkout, base: 'main', branch: 'feature/one', location: '/feature-one' },
  initializeRepository: { checkout: folder },
  readComparison: { target, area: 'staged' },
  lookupFiles: { checkout, query: '', limit: 100, history: [target.path] },
  searchText: { checkout, query: 'needle', matchCase: false, wholeWord: true, regex: false },
  inspectEntries: { checkout, paths: [target.path] },
  mutate: operation,
  operationStatus: { clientId: 'client', id: operation.id },
  acknowledgeOperation: { clientId: 'client', operationClientId: 'other', id: operation.id },
  loadRecovery: { clientId: 'client' },
  persistRecovery: { clientId: 'client', requestId: receipt.requestId, expectedRevision: 1, state },
  getRecoveryPublication: { clientId: 'client', requestId: receipt.requestId },
} satisfies { [K in WorkspaceCommand]: CommandInput<K> };
const outputs = {
  openCheckout: checkout,
  readFile: disk,
  saveFile: {
    kind: 'saved',
    disk,
    recoveryChanges: [receipt],
    persistencePending: false,
    message: '',
  },
  listDirectory: {
    entries: [{ path: target.path, directory: false, ignored: false }],
    partial: false,
  },
  getIgnoredPaths: { paths: [target.path] },
  gitStatus: { branch: '', changes: [{ path: target.path, area: 'staged', kind: 'modified' }] },
  listWorktrees: {
    worktrees: [
      { root: checkout.root, branch: 'main', main: true, locked: false, prunable: false },
    ],
  },
  createWorktree: { ...checkout, checkoutId: 'feature', root: '/feature-one', worktree: 'linked' },
  initializeRepository: { ...checkout, checkoutId: folder.checkoutId, root: folder.root },
  readComparison: { original: '', title: '', working: null },
  lookupFiles: {
    matches: [{ path: target.path, score: 0, positions: [] }],
    history: [],
    partial: false,
  },
  searchText: {
    files: [
      {
        path: target.path,
        matches: [
          { line: 2, text: 'a needle', ranges: [{ start: 2, end: 8 }], before: ['x'], after: [] },
        ],
      },
    ],
    partial: false,
  },
  inspectEntries: [entry],
  mutate: result,
  operationStatus: null,
  acknowledgeOperation: undefined,
  loadRecovery: { revision: 1, state, errors: [], operations: [] },
  persistRecovery: receipt,
  getRecoveryPublication: null,
} satisfies { [K in WorkspaceCommand]: CommandOutput<K> };
for (const operation of Object.keys(inputs) as WorkspaceCommand[]) {
  test(`${operation} shared schema preserves known request and reply values`, () => {
    assert.deepEqual(decodeWorkspaceInput(operation, inputs[operation]), inputs[operation]);
    const expected =
      operation === 'mutate'
        ? {
            id: result.id,
            clientId: result.clientId,
            checkout,
            kind: result.kind,
            recoveryChanges: result.recoveryChanges.map(
              ({ clientId, previousRevision, revision }) => ({
                clientId,
                previousRevision,
                revision,
              }),
            ),
            outcome: result.outcome,
            items: result.items,
          }
        : outputs[operation];
    // Receipts used as recovery changes deliberately project their request ID.
    const actual = decodeWorkspaceOutput(operation, outputs[operation]);
    if (operation === 'saveFile')
      assert.equal(decodeWorkspaceOutput('saveFile', actual).kind, 'saved');
    else assert.deepEqual(actual, expected);
    assert.throws(
      () => decodeWorkspaceInput(operation, { ...inputs[operation], unknown: 'secret' }),
      (e) => ApplicationError.is(e) && e.code === 'InvalidInput' && !e.message.includes('secret'),
    );
  });
}
test('all saved objects reject unfamiliar nested fields before reply projection', () => {
  const paths = [
    [],
    ['checkouts', 0],
    ['drafts', 0],
    ['drafts', 0, 'target'],
    ['drafts', 0, 'disk'],
    ['views', checkout.checkoutId],
    ['views', checkout.checkoutId, 'tree'],
    ['views', checkout.checkoutId, 'positions', target.path, 'file:original'],
  ];
  for (const path of paths) {
    const unknown = structuredClone(state);
    let object: unknown = unknown;
    for (const key of path) object = Reflect.get(object as object, key);
    Object.assign(object as object, { foreign: 'preserve original' });
    const bytes = JSON.stringify(unknown);
    assert.throws(() => decodeEditorRecovery(unknown));
    assert.throws(() =>
      decodeWorkspaceInput('persistRecovery', { ...inputs.persistRecovery, state: unknown }),
    );
    assert.throws(() =>
      decodeWorkspaceOutput('loadRecovery', { ...outputs.loadRecovery, state: unknown }),
    );
    assert.equal(JSON.stringify(unknown), bytes);
  }
  assert.deepEqual(decodeEditorRecovery(state), state);
});
test('recovery saved before Follow Active File and Hide Ignored Files still decodes', () => {
  // Saved by earlier builds: no followActiveFile, and the old Hide button's tree.hideIgnored.
  const { followActiveFile: _follow, ...current } = structuredClone(state);
  const { hideIgnoredFiles: _hide, ...tree } = current.views[checkout.checkoutId].tree;
  const prior = {
    ...current,
    views: {
      [checkout.checkoutId]: {
        ...current.views[checkout.checkoutId],
        tree: { ...tree, hideIgnored: true },
      },
    },
  };
  const decoded = decodeEditorRecovery(prior);
  assert.equal(Object.hasOwn(decoded, 'followActiveFile'), false);
  assert.equal(decoded.views[checkout.checkoutId].tree.hideIgnoredFiles, undefined);
  assert.equal(decoded.views[checkout.checkoutId].tree.hideIgnored, true);
  assert.deepEqual(decoded.drafts, state.drafts);
  assert.deepEqual(
    decodeWorkspaceOutput('loadRecovery', { ...outputs.loadRecovery, state: prior }).state,
    decoded,
  );
  assert.throws(() => decodeEditorRecovery({ ...state, followActiveFile: 'yes' }));
});
test('reply projection, dynamic keys, optional omission and mutable DTOs remain supported', () => {
  const decoded = decodeEditorRecovery(state);
  decoded.drafts.push({ target, text: '', disk });
  decoded.views['another'] = structuredClone(state.views[checkout.checkoutId]);
  decoded.views[checkout.checkoutId].fileViews['another.txt'] = 'staged';
  decoded.views[checkout.checkoutId].positions['another.txt'] = {};
  delete decoded.views['another'];
  decoded.views[checkout.checkoutId].positions[target.path].file = {
    line: 2,
    column: 3,
    left: 0,
    top: 4,
  };
  assert.equal(decoded.drafts.length, 2);
  assert.equal(state.drafts.length, 1);
  assert.deepEqual(
    decodeWorkspaceInput('listDirectory', { checkout, path: '', hideIgnored: undefined }),
    { checkout, path: '' },
  );
  assert.deepEqual(decodeWorkspaceOutput('readFile', { ...disk, private: 'hidden' }), disk);
  const proto = JSON.parse('{"__proto__":"file","constructor":"file"}');
  const special = structuredClone(state);
  special.views[checkout.checkoutId].fileViews = proto;
  assert.deepEqual(decodeEditorRecovery(special).views[checkout.checkoutId].fileViews, proto);
});
test('file bytes, finite values, identity grammars and collection bounds retain distinct policies', () => {
  for (const text of ['', '\ufeff', '😀'.repeat(524288)])
    assert.equal(decodeWorkspaceInput('saveFile', { ...inputs.saveFile, text }).text, text);
  for (const text of ['\0', '\ud800', '😀'.repeat(524289)])
    assert.throws(() => decodeWorkspaceInput('saveFile', { ...inputs.saveFile, text }));
  for (const bad of [-1, 1.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      decodeWorkspaceInput('persistRecovery', { ...inputs.persistRecovery, expectedRevision: bad }),
    );
  assert.throws(() => decodeWorkspaceInput('loadRecovery', { clientId: 'chat:identity' }));
  assert.deepEqual(decodeConnectionInput('connect', { profileId: 'chat:identity' }), {
    profileId: 'chat:identity',
  });
  assert.throws(() => decodeWorkspaceInput('lookupFiles', { checkout, query: '', limit: 101 }));
  for (const name of ['-b', '--force', 'has space', '', 'a\nb'])
    for (const field of ['base', 'branch'])
      assert.throws(() =>
        decodeWorkspaceInput('createWorktree', { ...inputs.createWorktree, [field]: name }),
      );
  assert.throws(() => decodeWorkspaceOutput('openCheckout', { ...checkout, worktree: 'bare' }));
  // A plain folder has no branch or worktree, and initializing one always gives Git.
  assert.deepEqual(decodeWorkspaceOutput('openCheckout', folder), folder);
  for (const bad of [
    { ...folder, branch: 'main' },
    { ...folder, worktree: 'main' },
    { ...folder, vcs: 'svn' },
    { ...checkout, vcs: 'none' },
  ])
    assert.throws(() => decodeWorkspaceInput('gitStatus', { checkout: bad }));
  assert.throws(() => decodeWorkspaceOutput('initializeRepository', folder));
  // Saved targets from before `vcs` existed decode as Git checkouts.
  const { vcs: _, ...saved } = checkout;
  assert.deepEqual(decodeWorkspaceOutput('openCheckout', saved), checkout);
  assert.deepEqual(
    decodeEditorRecovery({ ...state, checkouts: [saved], drafts: [], recentFiles: [] }).checkouts,
    [checkout],
  );
  assert.throws(() =>
    decodeEditorRecovery({ ...state, drafts: Array.from({ length: 513 }, () => state.drafts[0]) }),
  );
  for (const value of ['constructor', '__proto__', 'unknown', 1, null]) {
    assert.equal(isWorkspaceCommand(value), false);
    assert.equal(isConnectionCommand(value), false);
  }
  assert.deepEqual(decodeWorkspaceWatchInput({ checkout, paths: [''] }), { checkout, paths: [''] });
  assert.deepEqual(decodeWorkspaceEvent({ checkout, paths: [], ready: true, private: 'hidden' }), {
    checkout,
    paths: [],
    ready: true,
  });
});
const host = { hostId: 'host', storeId: 'store' };
const health = { ...host, protocol: 2, version: '0.1.0', capabilities: ['', 'chat-v0', 'chat-v0'] };
const profile = {
  id: 'profile',
  label: 'Personal host',
  destination: 'user@[::1]',
  remotePort: 22,
  expected: host,
};
test('connection and health decoders preserve states, void, order, and configuration projection', () => {
  assert.deepEqual(
    decodeConnectionProfile({ ...profile, extra: true, expected: { ...host, extra: true } }),
    profile,
  );
  for (const state of ['disconnected', 'connecting', 'disconnecting', 'connected', 'failed']) {
    const snapshot = {
      profile,
      state,
      connectionId: state === 'disconnected' ? null : 'generation',
      ...(state === 'connected' ? { health } : {}),
    };
    assert.deepEqual(decodeConnectionSnapshot(snapshot), snapshot);
    assert.deepEqual(decodeConnectionOutput('getConnection', snapshot), snapshot);
    assert.deepEqual(decodeConnectionOutput('connect', snapshot), snapshot);
  }
  assert.equal(decodeConnectionOutput('disconnect', undefined), undefined);
  assert.throws(() => decodeConnectionOutput('disconnect', null));
  assert.throws(() => decodeConnectionInput('getConnection', { extra: 1 }));
  assert.throws(() => decodeConnectionInput('disconnect', { connectionId: '' }));
  assert.throws(() =>
    decodeConnectionSnapshot({ profile, state: 'connected', connectionId: null, health }),
  );
  assert.deepEqual(decodeChatHostHealth({ ...health, token: 'private' }), health);
  for (const changed of [
    { protocol: 1 },
    { version: 'other' },
    { capabilities: ['other'] },
    { capabilities: ['chat-v0', 'x'.repeat(65)] },
  ])
    assert.throws(() => decodeChatHostHealth({ ...health, ...changed }));
});
test('error DTOs decode strictly without authenticating a plain value as ApplicationError', () => {
  const dto = { code: 'Uncertain', message: '', target };
  const decoded = decodeApplicationErrorDTO(dto);
  assert.deepEqual(decoded, dto);
  assert.equal(ApplicationError.is(decoded), false);
  for (const bad of [
    { ...dto, extra: true },
    { ...dto, code: 'unknown' },
    { ...dto, target: { ...target, extra: 'secret' } },
  ])
    assert.throws(
      () => decodeApplicationErrorDTO(bad),
      (e) => ApplicationError.is(e) && e.code === 'Incompatible' && !e.message.includes('secret'),
    );
});
for (const entry of ['workspace-schema', 'connection-schema', 'host-schema', 'error-schema'])
  test(`${entry} bundles without privileged implementations or application services`, async () => {
    const bundle = await build({
      absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
      entryPoints: [`@moonbase/contracts/${entry}`],
      bundle: true,
      platform: 'browser',
      write: false,
      metafile: true,
    });
    assert.deepEqual(
      Object.keys(bundle.metafile.inputs).filter((path) =>
        /packages\/(?:application|pi-runtime|ssh|workspace)\/|node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?react(?:-dom)?\/|electron|@earendil-works|node:/.test(
          path,
        ),
      ),
      [],
    );
  });
