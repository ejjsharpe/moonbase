import {
  getTranscriptDisclosureId,
  parseTranscriptMarkdown,
} from '../src/chat/transcript-source.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MarkdownCache,
  canHighlight,
  getExternalLink,
  type LocatedToken,
} from '../src/renderer/chat/markdown-model.ts';
test('parser block selection excludes indented literals and preserves meaningful code indentation', () => {
  for (const literal of ['same\n      ```\n', 'unclosed\n']) {
    const source = `- item\n\n      \`\`\`js\n      ${literal}\n  \`\`\`js\r\n  same\r\n  \`\`\`\r\n`;
    const { codeBlocks } = parseTranscriptMarkdown(source);
    assert.equal(codeBlocks.length, 1);
    assert.equal(codeBlocks[0]!.text, 'same');
    assert.equal((codeBlocks[0] as LocatedToken).codeBlock?.index, 0);
  }
  for (const prefix of ['> ', '>\t', '- ', '-\t', '- >\t', '> - ']) {
    const continuation = prefix.replace(/-/g, ' ');
    const source = `${prefix}\`\`\`python\r\n${continuation}def moon():\r\n${continuation}    print("🌔 é")\t  \r\n${continuation}\`\`\`\r\n`;
    const parsed = parseTranscriptMarkdown(source);
    assert.equal(parsed.codeBlocks.length, 1, prefix);
    assert.equal(parsed.codeBlocks[0]!.text, 'def moon():\n    print("🌔 é")\t  ', prefix);
    assert.equal((parsed.codeBlocks[0] as LocatedToken).codeBlock?.closed, true, prefix);
  }
});
test('repeated and nested fences use parser order without body matching or source reconstruction', () => {
  const source =
    '```js\r\nsame\r\n```\r\n\n> ````md\r\n> ```inner\r\n> 🌔\r\n> ```\r\n> ````\r\n\n```js\nsame\n```\n';
  const parsed = parseTranscriptMarkdown(source);
  assert.deepEqual(
    parsed.codeBlocks.map((block) => block.text),
    ['same', '```inner\n🌔\n```', 'same'],
  );
  assert.deepEqual(
    parsed.codeBlocks.map((block) => (block as LocatedToken).codeBlock?.index),
    [0, 1, 2],
  );
});
test('changed messages re-lex, references/fence closure invalidate interpretation, exact clones reuse bounded work', () => {
  const cache = new MarkdownCache();
  const first = cache.parse('entry', '1', '[read][ref]\n');
  assert.equal(cache.parse('entry', '1', '[read][ref]\n'), first);
  assert.equal(cache.stats.lex, 1);
  const next = cache.parse('entry', '2', '[read][ref]\n\n[ref]: https://example.com\n');
  assert.notEqual(next[0]!.signature, first[0]!.signature);
  assert.equal(
    (parseTranscriptMarkdown('```js\nconst n=1').codeBlocks[0] as LocatedToken).codeBlock!.closed,
    false,
  );
  assert.equal(
    (parseTranscriptMarkdown('```js\nconst n=1\n```').codeBlocks[0] as LocatedToken).codeBlock!
      .closed,
    true,
  );
  const nested = cache.parse(
    'nested',
    '1',
    '- ```ts\r\n  body 🌔\t\r\noutside the list\r\n```\r\n',
  );
  assert.match(nested[0]!.signature, /"closed":false/);
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

test('deep quote and ordered-list input stays readable without source-location reconstruction', () => {
  assert.deepEqual(
    parseTranscriptMarkdown('> '.repeat(5000) + 'not a fence ``` later').codeBlocks,
    [],
  );
  const source = '1. item\n\n    ```ts\r\n    🌔\r\n    ```\r\n';
  assert.equal(parseTranscriptMarkdown(source).codeBlocks[0]!.text, '🌔');
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

test('many repeated CRLF fences keep their own parser indexes and cache keys count toward retention', () => {
  const cache = new MarkdownCache();
  const fence = '```ts\r\nconst moon = "🌔";\r\n```\r\n\r\n';
  const blocks = cache.parse('many', '1', fence.repeat(1000));
  const code = blocks.filter((block) => block.token.type === 'code');
  assert.equal(code.length, 1000);
  for (let i = 0; i < code.length; i++) {
    assert.equal(code[i]!.token.codeBlock!.index, i);
    assert.equal((code[i]!.token as { text: string }).text, 'const moon = "🌔";');
    assert.equal(code[i]!.token.codeBlock!.closed, true);
  }
  cache.clear();
  cache.parse('x'.repeat(2 * 1024 * 1024), '1', 'small text');
  assert.equal(cache.stats.messages, 0);
  assert.equal(cache.stats.retainedBytes, 0);
});
