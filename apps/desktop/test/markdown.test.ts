import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MarkdownCache,
  canHighlight,
  getExternalLink,
  locateFences,
} from '../src/renderer/chat/markdown-model.ts';
test('exact original source ranges retain CRLF, whitespace, Unicode, repeated/embedded/nested fences', () => {
  for (const source of [
    '```ts\r\n  🌔\t\r\n```\r\n',
    '````md\n```inner\n🌔\n```\n````\n',
    '> ```ts\r\n> \t🌔  \r\n> ```\r\n',
    '- ```ts\n  🌔\t\n  ```\n',
    '~~~\none\n~~~\n\n~~~\ntwo\n~~~\n',
  ]) {
    const fences = locateFences(source);
    assert.ok(fences.length);
    for (const fence of fences) {
      assert.equal(fence.closed, true);
      assert.equal(
        fence.text,
        fence.ranges.map((range) => source.slice(range.start, range.end)).join(''),
      );
    }
  }
  assert.equal(locateFences('> ```ts\r\n> \t🌔  \r\n> ```\r\n')[0]!.text, '\t🌔  \r\n');
});
test('changed messages re-lex, references/fence closure invalidate interpretation, exact clones reuse bounded work', () => {
  const cache = new MarkdownCache();
  const first = cache.parse('entry', '1', '[read][ref]\n');
  assert.equal(cache.parse('entry', '1', '[read][ref]\n'), first);
  assert.equal(cache.stats.lex, 1);
  const next = cache.parse('entry', '2', '[read][ref]\n\n[ref]: https://example.com\n');
  assert.notEqual(next[0]!.signature, first[0]!.signature);
  assert.equal(locateFences('```js\nconst n=1')[0]!.closed, false);
  assert.equal(locateFences('```js\nconst n=1\n```')[0]!.closed, true);
  for (let i = 0; i < 256; i++) cache.parse(String(i), '1', 'message '.repeat(100));
  assert.ok(cache.stats.messages <= 128);
  assert.ok(cache.stats.retainedBytes <= 2 * 1024 * 1024);
});
test('highlighting limits never limit source and explicit HTTP(S) is the sole opener policy', () => {
  assert.equal(canHighlight('x'.repeat(65537), true), false);
  assert.equal(canHighlight('x\n'.repeat(2001), true), false);
  assert.equal(canHighlight('const n = 1', false), false);
  assert.equal(canHighlight('const n = 1', true), true);
  for (const link of [
    'javascript:x',
    'file:///tmp/x',
    'data:image/svg+xml,x',
    '//example.com',
    'https://user:password@example.com',
    'https://example.com/\n',
  ])
    assert.equal(getExternalLink(link), null);
  assert.equal(getExternalLink('https://example.com'), 'https://example.com/');
});
