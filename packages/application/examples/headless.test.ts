import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHeadlessApplication } from './headless.ts';

test('a direct public consumer runs editor-only, chat-only and combined applications', async () => {
  assert.deepEqual(await checkHeadlessApplication(), ['editor', 'chat', 'combined']);
});
