import type { Code, Root } from 'mdast';
import {
  getTranscriptDisclosureId,
  parseTranscriptMarkdown,
} from '../src/chat/transcript-source.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visit } from 'unist-util-visit';
import {
  MarkdownCache,
  canHighlight,
  getExternalLink,
  getSyntaxTone,
} from '../src/renderer/chat/markdown-model.ts';
test('parser block selection excludes indented literals and preserves meaningful code indentation', () => {
  for (const literal of ['same\n      ```\n', 'unclosed\n']) {
    const source = `- item\n\n      \`\`\`js\n      ${literal}\n  \`\`\`js\r\n  same\r\n  \`\`\`\r\n`;
    const { codeBlocks } = parseTranscriptMarkdown(source);
    assert.equal(codeBlocks.length, 1);
    assert.equal(codeBlocks[0]!.value, 'same');
    assert.equal(codeBlocks[0]!.position!.start.offset, source.lastIndexOf('```js'));
  }
  for (const prefix of ['> ', '>\t', '- ', '-\t', '- >\t', '> - ']) {
    const continuation = prefix.replace(/-/g, ' ');
    const source = `${prefix}\`\`\`python\r\n${continuation}def moon():\r\n${continuation}    print("🌔 é")\t  \r\n${continuation}\`\`\`\r\n`;
    const parsed = parseTranscriptMarkdown(source);
    assert.equal(parsed.codeBlocks.length, 1, prefix);
    assert.equal(parsed.codeBlocks[0]!.value, 'def moon():\r\n    print("🌔 é")\t  ', prefix);
    assert.equal(parsed.codeBlocks[0]!.data!.codeBlock?.closed, true, prefix);
  }
});
test('repeated and nested fences use parser order without body matching or source reconstruction', () => {
  const source =
    '```js\r\nsame\r\n```\r\n\n> ````md\r\n> ```inner\r\n> 🌔\r\n> ```\r\n> ````\r\n\n```js\nsame\n```\n';
  const parsed = parseTranscriptMarkdown(source);
  assert.deepEqual(
    parsed.codeBlocks.map((block) => block.value),
    ['same', '```inner\r\n🌔\r\n```', 'same'],
  );
  assert.deepEqual(
    parsed.codeBlocks.map((block) => block.position!.start.offset),
    [0, 21, 63],
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
    parseTranscriptMarkdown('```js\nconst n=1').codeBlocks[0]!.data!.codeBlock!.closed,
    false,
  );
  assert.equal(
    parseTranscriptMarkdown('```js\nconst n=1\n```').codeBlocks[0]!.data!.codeBlock!.closed,
    true,
  );
  const nested = cache.parse(
    'nested',
    '1',
    '- ```ts\r\n  body 🌔\t\r\noutside the list\r\n```\r\n',
  );
  let closed: boolean | undefined;
  visit(nested[0]!.tree, 'code', (node) => {
    closed = node.data?.codeBlock?.closed;
  });
  assert.equal(closed, false);
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
  assert.equal(parseTranscriptMarkdown(source).codeBlocks[0]!.value, '🌔');
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

test('many repeated CRLF fences keep their own parser positions and cache keys count toward retention', () => {
  const cache = new MarkdownCache();
  const fence = '```ts\r\nconst moon = "🌔";\r\n```\r\n\r\n';
  const blocks = cache.parse('many', '1', fence.repeat(1000));
  const code = blocks.filter((block) => block.tree.children[0]?.type === 'code');
  assert.equal(code.length, 1000);
  for (let i = 0; i < code.length; i++) {
    assert.equal((code[i]!.tree.children[0] as Code).position!.start.offset, i * fence.length);
    assert.equal((code[i]!.tree.children[0] as Code).value, 'const moon = "🌔";');
    assert.equal((code[i]!.tree.children[0] as Code).data!.codeBlock!.closed, true);
  }
  cache.clear();
  cache.parse('x'.repeat(2 * 1024 * 1024), '1', 'small text');
  assert.equal(cache.stats.messages, 0);
  assert.equal(cache.stats.retainedBytes, 0);
});

test('parser positions remain original UTF-16 and invalidate changed block action positions', () => {
  const cache = new MarkdownCache();
  const first = cache.parse('source', '1', '🌔\r\n\r\n```js\r\nbody\r\n```');
  const next = cache.parse('source', '2', '🌔 extra\r\n\r\n```js\r\nbody\r\n```');
  const before = first[1]!.tree.children[0] as Code;
  assert.equal(before.position!.start.offset, 6);
  assert.equal(before.data!.hProperties!['data-code-start'], 6);
  assert.notEqual(first[1]!.signature, next[1]!.signature);
});

const countNodes = (blocks: { tree: Root }[], type: string) => {
  let count = 0;
  for (const block of blocks) visit(block.tree, type, () => void count++);
  return count;
};

test('reference definitions keep one document block within the cache bound', () => {
  const source =
    Array.from({ length: 150 }, (_, i) => `Paragraph ${i} uses [text][ref${i}].`).join('\n\n') +
    '\n\n' +
    Array.from({ length: 150 }, (_, i) => `[ref${i}]: https://example.com/${i}`).join('\n') +
    '\n';
  const cache = new MarkdownCache();
  const blocks = cache.parse('references', '1', source);
  assert.equal(blocks.length, 1);
  assert.equal(countNodes(blocks, 'definition'), 150);
  assert.equal(countNodes(blocks, 'linkReference'), 150);
  assert.equal(cache.stats.messages, 1);
  assert.ok(cache.stats.retainedBytes < 512 * 1024, String(cache.stats.retainedBytes));
  assert.equal(cache.parse('references', '1', source), blocks);
  assert.equal(cache.stats.lex, 1);
});

test('a late definition re-renders earlier references and keeps original code selectors', () => {
  const cache = new MarkdownCache();
  const streamed = '🌔 [read][ref] and [^note]\r\n\r\n```js\r\nbody\r\n```\r\n\r\n> quoted\r\n';
  const sources = [
    streamed,
    streamed + '\r\n> [ref]: https://example.com\r\n',
    streamed + '\r\n> [ref]: https://example.com\r\n\r\n[^note]: Footnote\r\n',
  ];
  const [split, reference, footnote] = sources.map((source, revision) =>
    cache.parse('late', String(revision), source),
  );
  assert.equal(split!.length, 3);
  assert.equal(countNodes(split!, 'linkReference'), 0);
  assert.equal(countNodes(split!, 'definition'), 0);
  assert.equal(reference!.length, 1);
  assert.deepEqual(
    [split!, reference!].map((blocks) => blocks.map((block) => block.key)),
    [['0', '1', '2'], ['document']],
  );
  assert.equal(countNodes(reference!, 'linkReference'), 1);
  assert.equal(countNodes(reference!, 'definition'), 1);
  assert.notEqual(reference![0]!.signature, split![0]!.signature);
  assert.equal(footnote!.length, 1);
  assert.equal(countNodes(footnote!, 'footnoteReference'), 1);
  for (const [index, blocks] of [split!, reference!, footnote!].entries()) {
    const selectors: unknown[] = [];
    for (const block of blocks)
      visit(block.tree, 'code', (node) => {
        selectors.push(node.data?.hProperties?.['data-code-start']);
      });
    assert.deepEqual(
      selectors,
      parseTranscriptMarkdown(sources[index]!).codeBlocks.map(
        (node) => node.position!.start.offset,
      ),
    );
    assert.deepEqual(selectors, [sources[index]!.indexOf('```js')]);
  }
});

test('least recently read messages leave first at the entry and byte bounds', () => {
  const cache = new MarkdownCache();
  cache.parse('kept', '1', 'kept');
  for (let i = 0; i < 127; i++) cache.parse(String(i), '1', 'message');
  assert.equal(cache.stats.messages, 128);
  cache.parse('kept', '1', 'kept');
  cache.parse('new', '1', 'message');
  assert.equal(cache.stats.messages, 128);
  assert.equal(cache.stats.lex, 129);
  cache.parse('kept', '1', 'kept');
  assert.equal(cache.stats.lex, 129);
  cache.parse('0', '1', 'message');
  assert.equal(cache.stats.lex, 130);

  cache.clear();
  assert.equal(cache.stats.messages, 0);
  const large = 'x'.repeat(256 * 1024);
  for (const identity of ['a', 'b', 'c']) cache.parse(identity, '1', large);
  assert.equal(cache.stats.messages, 2);
  assert.ok(cache.stats.retainedBytes <= 2 * 1024 * 1024);
  const lexed = cache.stats.lex;
  cache.parse('c', '1', large);
  assert.equal(cache.stats.lex, lexed);
  cache.parse('a', '1', large);
  assert.equal(cache.stats.lex, lexed + 1);
  const oversized = cache.parse('c', '1', 'y'.repeat(1024 * 1024));
  assert.equal(oversized.length, 1);
  assert.equal(cache.stats.messages, 1);
});

test('streamed text keeps unchanged block signatures and estimates retention from source length', () => {
  const cache = new MarkdownCache();
  const first = cache.parse(
    'stream',
    '',
    '# Title\n\nFirst paragraph\n\n```ts\nconst a = 1;\n```\n\nTail',
  );
  const next = cache.parse(
    'stream',
    '',
    '# Title\n\nFirst paragraph\n\n```ts\nconst a = 1;\n```\n\nTail grows',
  );
  assert.deepEqual(
    first.slice(0, 3).map((block) => block.signature),
    next.slice(0, 3).map((block) => block.signature),
  );
  assert.notEqual(first[3]!.signature, next[3]!.signature);
  // One identity holds one parse, whatever the streamed revision.
  assert.equal(cache.stats.messages, 1);
  assert.equal(cache.stats.lex, 2);
  assert.ok(cache.stats.retainedBytes < 1024);
});

test('Monaco token types map to highlight tones; identifiers and delimiters stay plain', () => {
  const tones = Object.fromEntries(
    [
      'comment.ts',
      'comment.doc.ts',
      'keyword.ts',
      'keyword.flow.python',
      'string.ts',
      'string.escape.ts',
      'string.key.json',
      'string.value.json',
      'number.ts',
      'number.hex.ts',
      'type.identifier.ts',
      'regexp.ts',
      'tag.html',
      'metatag.html',
      'attribute.name.html',
      'attribute.value.html',
      'predefined.sql',
      'variable.predefined.ruby',
      'variable.ruby',
      'operator.sql',
      'support.function.css',
      'annotation.java',
      'identifier.ts',
      'delimiter.parenthesis.ts',
      '',
    ].map((type) => [type, getSyntaxTone(type)]),
  );
  assert.deepEqual(tones, {
    'comment.ts': 'comment',
    'comment.doc.ts': 'comment',
    'keyword.ts': 'keyword',
    'keyword.flow.python': 'keyword',
    'string.ts': 'string',
    'string.escape.ts': 'string',
    'string.key.json': 'property',
    'string.value.json': 'string',
    'number.ts': 'number',
    'number.hex.ts': 'number',
    'type.identifier.ts': 'type',
    'regexp.ts': 'regexp',
    'tag.html': 'tag',
    'metatag.html': 'keyword',
    'attribute.name.html': 'attribute',
    'attribute.value.html': 'string',
    'predefined.sql': 'constant',
    'variable.predefined.ruby': 'constant',
    'variable.ruby': 'variable',
    'operator.sql': 'operator',
    'support.function.css': 'function',
    'annotation.java': 'keyword',
    'identifier.ts': undefined,
    'delimiter.parenthesis.ts': undefined,
    '': undefined,
  });
});
