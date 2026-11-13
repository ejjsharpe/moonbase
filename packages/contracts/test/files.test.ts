import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateTo } from '@moonbase/contracts/files';

test('a file is private only to its owner and only without group or other bits', () => {
  assert.equal(isPrivateTo({ uid: 501, mode: 0o100600 }, 501), true);
  assert.equal(isPrivateTo({ uid: 501, mode: 0o40700 }, 501), true);
  assert.equal(isPrivateTo({ uid: 501, mode: 0o100600 }, 502), false);
  assert.equal(isPrivateTo({ uid: 501, mode: 0o100600 }, undefined), false);
  for (const bit of [0o040, 0o020, 0o010, 0o004, 0o002, 0o001])
    assert.equal(isPrivateTo({ uid: 501, mode: 0o100600 | bit }, 501), false);
});
