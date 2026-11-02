import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as chat from '@moonbase/application/chat';
import * as compatibility from '@moonbase/chat';

test('temporary chat package forwards the canonical model and controller identities', () => {
  assert.equal(compatibility.makeChatModel, chat.makeChatModel);
  assert.equal(compatibility.makeChatController, chat.makeChatController);
});
