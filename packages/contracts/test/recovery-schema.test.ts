import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Schema from 'effect/Schema';
import { emptyBufferView, emptyRecoveryState } from '@moonbase/contracts/recovery';
import {
  RecoveryLoadSchema,
  RecoveryStateSchema,
  recoveryInputSchemas,
} from '@moonbase/contracts/recovery-schema';

const checkout = (checkoutId: string) => ({
  hostId: 'host',
  checkoutId,
  projectId: 'project',
  root: '/' + checkoutId,
  vcs: 'none' as const,
});
const decodes = (value: unknown) => {
  try {
    Schema.decodeUnknownSync(RecoveryStateSchema, { onExcessProperty: 'error' })(value);
    return true;
  } catch {
    return false;
  }
};

test('a recovery state names only listed checkouts, one buffer per file, and its own checkout buffers in each view', () => {
  const [a, b] = [checkout('a'), checkout('b')];
  const state = {
    ...emptyRecoveryState('client'),
    checkouts: [a, b],
    buffers: [
      { id: 'one', target: { checkout: a, path: 'file.txt' } },
      { id: 'two', target: { checkout: b, path: 'file.txt' } },
    ],
    views: { a: { ...emptyBufferView(), tabs: ['one'], active: 'one' } },
  };
  assert(decodes(state));
  for (const invalid of [
    // A view naming another checkout's buffer, or one that is not open.
    { ...state, views: { a: { ...emptyBufferView(), tabs: ['two'] } } },
    { ...state, views: { a: { ...emptyBufferView(), positions: { gone: {} } } } },
    // Two buffers for one file, or one ID twice.
    { ...state, buffers: [state.buffers[0], { ...state.buffers[0], id: 'three' }] },
    { ...state, buffers: [state.buffers[0], { ...state.buffers[1], id: 'one' }] },
    // A buffer in a checkout the recovery does not list as it is.
    { ...state, checkouts: [a] },
    { ...state, checkouts: [a, { ...b, root: '/elsewhere' }] },
    // An active tab that is not a tab.
    { ...state, views: { a: { ...emptyBufferView(), active: 'one' } } },
    // A path out of its checkout.
    { ...state, buffers: [{ id: 'one', target: { checkout: a, path: '../outside' } }] },
    { ...state, recentFiles: [{ checkout: a, path: '../outside' }] },
  ])
    assert(!decodes(invalid));
});

test('the recovery commands round-trip their requests and a load, and refuse a field they do not know', () => {
  const strict = (schema: Schema.Top) =>
    Schema.decodeUnknownSync(schema as Schema.Decoder<unknown>, { onExcessProperty: 'error' });
  const target = { checkout: checkout('a'), path: 'file.txt' };
  const disk = { text: '', version: 'version' };
  const { version: _v, clientId: _c, buffers: _b, ...layout } = emptyRecoveryState('client');
  const requests = {
    loadRecovery: { clientId: 'client' },
    openTab: { clientId: 'client', bufferId: 'one', target },
    closeTab: { clientId: 'client', bufferId: 'one', discard: true },
    updateDraft: { clientId: 'client', bufferId: 'one', text: 'draft', disk },
    updateLayout: { clientId: 'client', layout },
  };
  for (const [name, request] of Object.entries(requests)) {
    const decode = strict(recoveryInputSchemas[name as keyof typeof recoveryInputSchemas]);
    assert.deepEqual(decode(request), request);
    assert.throws(() => decode({ ...request, unknown: true }));
  }
  const load = { state: emptyRecoveryState('client'), errors: [], operations: [] };
  assert.deepEqual(strict(RecoveryLoadSchema)(load), load);
  assert.throws(() => strict(RecoveryLoadSchema)({ ...load, revision: 1 }));
});
