import assert from 'node:assert/strict';
import { test } from 'node:test';
import { areJsonValuesEqual, getJsonKey } from '@moonbase/contracts/common';

test('JSON values compare whatever their key order', () => {
  assert.ok(
    areJsonValuesEqual(
      { kind: 'live', target: { hostId: 'h', conversationId: 'c' }, revision: 2 },
      { revision: 2, target: { conversationId: 'c', hostId: 'h' }, kind: 'live' },
    ),
  );
  assert.ok(!areJsonValuesEqual({ a: 1, b: 2 }, { a: 1, b: 3 }));
  assert.ok(!areJsonValuesEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!areJsonValuesEqual({ a: 1, b: 2 }, { a: 1, c: 2 }));
});

test('JSON arrays compare element-wise in order, including nested arrays', () => {
  assert.ok(areJsonValuesEqual([1, [2, { x: [3] }]], [1, [2, { x: [3] }]]));
  assert.ok(areJsonValuesEqual([{ a: 1, b: [2] }], [{ b: [2], a: 1 }]));
  assert.ok(!areJsonValuesEqual([1, 2], [2, 1]));
  assert.ok(!areJsonValuesEqual([1, [2, 3]], [1, [2]]));
  assert.ok(!areJsonValuesEqual({ path: [1, [2]] }, { path: [1, [3]] }));
});

test('undefined-valued keys count as absent, as in JSON', () => {
  assert.ok(areJsonValuesEqual({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(areJsonValuesEqual({ a: 1 }, { c: undefined, a: 1 }));
  assert.ok(areJsonValuesEqual({ nested: { b: undefined } }, { nested: {} }));
  assert.ok(!areJsonValuesEqual({ a: undefined }, { a: null }));
  assert.ok(areJsonValuesEqual(undefined, undefined));
  assert.ok(!areJsonValuesEqual(undefined, null));
});

test('primitives compare by value and never equal objects or arrays', () => {
  assert.ok(areJsonValuesEqual('a', 'a'));
  assert.ok(areJsonValuesEqual(0, 0));
  assert.ok(areJsonValuesEqual(null, null));
  assert.ok(!areJsonValuesEqual(1, '1'));
  assert.ok(!areJsonValuesEqual(0, false));
  assert.ok(!areJsonValuesEqual('', null));
  assert.ok(!areJsonValuesEqual(null, {}));
  assert.ok(!areJsonValuesEqual({}, null));
  assert.ok(!areJsonValuesEqual('[object Object]', {}));
  assert.ok(!areJsonValuesEqual([], {}));
  assert.ok(!areJsonValuesEqual({}, []));
  assert.ok(!areJsonValuesEqual({ 0: 'a', length: 1 }, ['a']));
  assert.ok(areJsonValuesEqual({}, {}));
  assert.ok(areJsonValuesEqual([], []));
});

test('values outside plain decoded data are not JSON-normalized', () => {
  assert.ok(!areJsonValuesEqual([undefined], [null]));
  assert.ok(!areJsonValuesEqual(NaN, NaN));
});

test('JSON keys match whatever the key order', () => {
  assert.equal(
    getJsonKey([{ kind: 'live', target: { b: 1, a: [{ y: 2, x: 1 }] } }, 'p']),
    getJsonKey([{ target: { a: [{ x: 1, y: 2 }], b: 1 }, kind: 'live' }, 'p']),
  );
  assert.equal(getJsonKey({ a: 1, b: undefined }), getJsonKey({ a: 1 }));
  assert.notEqual(getJsonKey({ a: 1 }), getJsonKey({ a: 2 }));
  assert.notEqual(getJsonKey([1, 2]), getJsonKey([2, 1]));
});
