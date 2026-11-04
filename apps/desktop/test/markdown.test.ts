import { getTranscriptDisclosureId } from '../src/chat/transcript-source.ts';
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

test('quote prefixes with fence-like text cannot make source-location matching backtrack', () => {
  assert.deepEqual(locateFences('> '.repeat(5000) + 'not a fence ``` later'), []);
  const source = '1. item\n\n    ```ts\r\n    🌔\r\n    ```\r\n';
  assert.equal(locateFences(source)[0]!.text, '🌔\r\n');
  const cache = new MarkdownCache();
  const blocks = cache.parse('deep', '1', '> '.repeat(1000) + 'literal');
  assert.ok(blocks.length);
});

test('disclosure IDs preserve exact identities within application memory bounds', async () => {
  const first = await getTranscriptDisclosureId('🌔'.repeat(64), 'part'.repeat(64));
  assert.ok(Buffer.byteLength(first) <= 256);
  assert.equal(await getTranscriptDisclosureId('🌔'.repeat(64), 'part'.repeat(64)), first);
  assert.notEqual(await getTranscriptDisclosureId('🌔'.repeat(64), 'other'.repeat(50)), first);
  assert.notEqual(
    await getTranscriptDisclosureId('entry:part', 'tail'),
    await getTranscriptDisclosureId('entry', 'part:tail'),
  );
});

test('many original CRLF fences keep their own source locations and cache keys count toward retention', () => {
  const cache = new MarkdownCache();
  const fence = '```ts\r\nconst moon = "🌔";\r\n```\r\n\r\n';
  const blocks = cache.parse('many', '1', fence.repeat(1000));
  const code = blocks.filter((block) => block.token.type === 'code');
  assert.equal(code.length, 1000);
  for (let i = 0; i < code.length; i++) {
    assert.equal(code[i]!.token.sourceCode!.start, i * fence.length);
    assert.equal(code[i]!.token.sourceCode!.text, 'const moon = "🌔";\r\n');
  }
  cache.clear();
  cache.parse('x'.repeat(2 * 1024 * 1024), '1', 'small text');
  assert.equal(cache.stats.messages, 0);
  assert.equal(cache.stats.retainedBytes, 0);
});
