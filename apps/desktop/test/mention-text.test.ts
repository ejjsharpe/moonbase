import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findMentionQuery,
  findMentionRanges,
  insertMention,
  removeMentionBefore,
} from '../src/renderer/chat/mention-text.ts';

test('an @ at a word start opens a query; an email or a finished mention does not', () => {
  assert.deepEqual(findMentionQuery('@', 1, []), { start: 0, query: '' });
  assert.deepEqual(findMentionQuery('Read @src/ap', 12, []), { start: 5, query: 'src/ap' });
  assert.deepEqual(findMentionQuery('Read @src/ap and', 12, []), { start: 5, query: 'src/ap' });
  assert.equal(findMentionQuery('me@example.com', 14, []), null);
  assert.equal(findMentionQuery('Read @src/a.ts now', 18, []), null);
  assert.equal(findMentionQuery('@src/a.ts', 9, [{ path: 'src/a.ts' }]), null);
  assert.deepEqual(findMentionQuery('@src/a.ts', 9, []), { start: 0, query: 'src/a.ts' });
});

test('a picked file replaces its query with the mention and one space', () => {
  assert.deepEqual(insertMention('Read @ap now', { start: 5, query: 'ap' }, 8, 'src/app.ts'), {
    text: 'Read @src/app.ts now',
    caret: 17,
  });
  assert.deepEqual(insertMention('@no', { start: 0, query: 'no' }, 3, 'docs/My notes.md'), {
    text: '@"docs/My notes.md" ',
    caret: 20,
  });
});

test('mentions are found only as whole words, and Backspace removes one whole', () => {
  const mentions = [{ path: 'a.ts' }, { path: 'docs/My notes.md' }];
  const text = 'See @a.ts, @a.ts @"docs/My notes.md" and @a.tsx';
  assert.deepEqual(findMentionRanges(text, mentions), [
    { start: 4, end: 9, path: 'a.ts' },
    { start: 11, end: 16, path: 'a.ts' },
    { start: 17, end: 36, path: 'docs/My notes.md' },
  ]);
  assert.deepEqual(removeMentionBefore(text, 36, mentions), {
    text: 'See @a.ts, @a.ts  and @a.tsx',
    caret: 17,
  });
  assert.equal(removeMentionBefore(text, 35, mentions), null);
  assert.deepEqual(findMentionRanges('Open @a.ts.', mentions), [
    { start: 5, end: 10, path: 'a.ts' },
  ]);
  assert.deepEqual(findMentionRanges('Open @a.ts.bak', mentions), []);
});
