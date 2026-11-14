import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Schema from 'effect/Schema';
import { emptyBufferView, emptyRecoveryState } from '@moonbase/contracts/recovery';
import { RecoveryStateSchema } from '@moonbase/contracts/recovery-schema';

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
  ])
    assert(!decodes(invalid));
});
