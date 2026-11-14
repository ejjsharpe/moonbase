import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendMentions,
  findMentionQuery,
  findMentionRanges,
  insertMention,
  rebaseMentions,
  removeMentionBefore,
} from '../src/renderer/chat/composer/mention-text.ts';
import { isChatMentionPath } from '@moonbase/contracts/chat';

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

test('files mentioned from the file tree join the draft relative to the chat folder', () => {
  assert.deepEqual(
    appendMentions('Look at', [], ['/repo/src/a.ts', '/repo/My notes.md'], '/repo'),
    {
      text: 'Look at @src/a.ts @"My notes.md" ',
      mentions: [{ path: 'src/a.ts' }, { path: 'My notes.md' }],
      outside: 0,
      unmentionable: 0,
    },
  );
  // Already mentioned, outside the folder, or the folder itself: left out.
  assert.deepEqual(
    appendMentions(
      '@src/a.ts ',
      [{ path: 'src/a.ts' }],
      ['/repo/src/a.ts', '/other/b.ts', '/repo'],
      '/repo/',
    ),
    { text: '@src/a.ts ', mentions: [{ path: 'src/a.ts' }], outside: 2, unmentionable: 0 },
  );
  assert.deepEqual(appendMentions('', [], ['/repo/b.ts'], '/repo').text, '@b.ts ');
  // A sibling folder that shares the prefix is not inside.
  assert.equal(appendMentions('', [], ['/repository/b.ts'], '/repo').outside, 1);
  // An unknown folder mentions nothing rather than every path from the root.
  assert.deepEqual(appendMentions('hi', [], ['/Users/e/repo/a.ts'], ''), {
    text: 'hi',
    mentions: [],
    outside: 1,
    unmentionable: 0,
  });
});

test('files whose paths a mention cannot hold are left out of the draft and counted', () => {
  const long = `/repo/${'a'.repeat(1025)}.ts`;
  const files = ['/repo/a\\b.txt', '/repo/say "hi".md', '/repo/tab\there.md', long, '/repo/ok.ts'];
  const appended = appendMentions('', [], files, '/repo');
  assert.deepEqual(appended, {
    text: '@ok.ts ',
    mentions: [{ path: 'ok.ts' }],
    outside: 0,
    unmentionable: 4,
  });
  // Every kept path is one ChatMentionSchema accepts.
  assert.ok(appended.mentions.every((mention) => isChatMentionPath(mention.path)));
  assert.deepEqual(appendMentions('hi', [], ['/repo/a\\b.txt'], '/repo'), {
    text: 'hi',
    mentions: [],
    outside: 0,
    unmentionable: 1,
  });
});

test('mentions moved to another folder are respelled inside it and written out outside it', () => {
  const mentions = [{ path: 'src/a.ts' }, { path: 'README.md' }, { path: 'src/My notes.md' }];
  const text = 'Read @src/a.ts, @README.md and @"src/My notes.md".';
  const repo = () => '/repo';
  // Outside the folder, a mention becomes its absolute path, which no later mention can spell.
  assert.deepEqual(rebaseMentions(text, mentions, repo, '/repo/src/'), {
    text: 'Read @a.ts, /repo/README.md and @"My notes.md".',
    mentions: [{ path: 'a.ts' }, { path: 'My notes.md' }],
    dropped: 1,
  });
  assert.deepEqual(
    rebaseMentions('See @a.ts', [{ path: 'a.ts' }], () => '/repo/src', '/repo'),
    {
      text: 'See @src/a.ts',
      mentions: [{ path: 'src/a.ts' }],
      dropped: 0,
    },
  );
  // Each mention keeps its own folder.
  const folders: Record<string, string> = { 'a.ts': '/notes', 'b.ts': '/repo' };
  assert.deepEqual(
    rebaseMentions(
      '@a.ts @b.ts',
      [{ path: 'a.ts' }, { path: 'b.ts' }],
      (p) => folders[p]!,
      '/repo',
    ),
    { text: '/notes/a.ts @b.ts', mentions: [{ path: 'b.ts' }], dropped: 1 },
  );
  // A sibling sharing the prefix, or the filesystem root, is not inside.
  assert.deepEqual(rebaseMentions('@a.ts', [{ path: 'a.ts' }], repo, '/repository'), {
    text: '/repo/a.ts',
    mentions: [],
    dropped: 1,
  });
  assert.equal(rebaseMentions('@a.ts', [{ path: 'a.ts' }], repo, '/').dropped, 1);
});
