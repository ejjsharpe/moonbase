import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatWorktreeBranch } from '../src/renderer/chat/worktree.ts';

test('a new chat’s worktree branch is named from the first words of its message', () => {
  assert.equal(
    chatWorktreeBranch("Tidy the composer's spacing"),
    'chat/tidy-the-composers-spacing',
  );
  assert.equal(
    chatWorktreeBranch('Compare @src/app.ts with @"docs/My notes.md" and fix it'),
    'chat/compare-with-and-fix-it',
  );
  assert.equal(chatWorktreeBranch('Café déjà vu'), 'chat/cafe-deja-vu');
  assert.equal(
    chatWorktreeBranch('Refactor the extraordinarily complicated synchronization layer today'),
    'chat/refactor-the-extraordinarily-complicated',
  );
  assert.equal(chatWorktreeBranch('a'.repeat(60)), `chat/${'a'.repeat(40)}`);
  assert.equal(chatWorktreeBranch('✨ ⚡️'), 'chat/task');
});
