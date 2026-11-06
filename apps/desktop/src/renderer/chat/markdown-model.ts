import { LRUCache } from 'lru-cache';
import type { Root } from 'mdast';
import { EXIT, visit } from 'unist-util-visit';
import { parseTranscriptMarkdown } from '../../chat/transcript-source.ts';
import { fitsStructuredSource } from './source-limits.ts';
/** `signature` changes whenever the block's rendering can: its source text or its offset. */
export type MarkdownBlock = { key: string; tree: Root; signature: string };
type ParsedMessage = { source: string; blocks: MarkdownBlock[] };
const cacheLimits = { messages: 128, bytes: 2 * 1024 * 1024 } as const;
/** UTF-16 source/key (2 bytes per unit) plus the parsed tree, estimated from source length. */
const retainedBytesPerUnit = 3;
/** Lines a code block shows before "Show all". */
export const foldedCodeLines = 40;
/** Work counted across every cache, so a fixture can prove reading does not redo it. */
export const markdownWork = { lex: 0, tokenize: 0 };
/** A private, per-view bounded cache keyed by exact identity/revision and checked against exact source, never DTO object identity. */
export class MarkdownCache {
  private messages = new LRUCache<string, ParsedMessage>({
    max: cacheLimits.messages,
    maxSize: cacheLimits.bytes,
    sizeCalculation: ({ source }, key) => retainedBytesPerUnit * (key.length + source.length),
  });
  private lexed = 0;
  get stats() {
    return {
      lex: this.lexed,
      retainedBytes: this.messages.calculatedSize,
      messages: this.messages.size,
    };
  }
  parse(identity: string, revision: string, source: string): MarkdownBlock[] {
    const key = JSON.stringify([identity, revision]);
    const old = this.messages.get(key);
    if (old?.source === source) return old.blocks;
    this.lexed++;
    markdownWork.lex++;
    const { tree } = parseTranscriptMarkdown(source);
    markCodeFolds(tree, source);
    // Definitions apply document-wide, so only messages without them split into blocks.
    let definitions = false;
    visit(tree, ['definition', 'footnoteDefinition'], () => {
      definitions = true;
      return EXIT;
    });
    const blocks = (
      definitions ? [tree] : tree.children.map((node): Root => ({ type: 'root', children: [node] }))
    ).map((block, index) => ({
      // A merged document must not reuse a pinned split block's DOM.
      key: definitions ? 'document' : String(index),
      tree: block,
      signature: definitions ? source : getBlockSignature(block, source),
    }));
    this.messages.set(key, { source, blocks });
    return blocks;
  }
  clear() {
    this.messages.clear();
  }
}
/**
 * Records where a long code block's folded lines start in the source (`data-code-fold`), so Find
 * can map the shown and folded lines separately and unfold for a match in the folded ones.
 */
function markCodeFolds(tree: Root, source: string) {
  visit(tree, 'code', (node) => {
    const start = node.position?.start.offset;
    if (start === undefined || node.value.split('\n').length <= foldedCodeLines) return;
    // A fenced block's content starts on the line after its fence.
    const fenced = /^ {0,3}(`{3,}|~{3,})/.test(source.slice(start, start + 8));
    let fold = start;
    for (let line = 0; line < foldedCodeLines + (fenced ? 1 : 0); line++) {
      const next = source.indexOf('\n', fold);
      if (next < 0) return;
      fold = next + 1;
    }
    node.data = {
      ...node.data,
      hProperties: { ...node.data?.hProperties, 'data-code-fold': fold },
    };
  });
}
/**
 * A split block's tree is determined by its own source slice, and its code actions by the slice's
 * offset in the message.
 */
function getBlockSignature(block: Root, source: string) {
  const position = block.children[0]?.position;
  const start = position?.start.offset,
    end = position?.end.offset;
  if (start === undefined || end === undefined) return 'whole:' + source;
  return `${start}:${source.slice(start, end)}`;
}
export function getExternalLink(value: string): string | null {
  if (
    !/^https?:\/\//i.test(value) ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function canHighlight(text: string, closed: boolean) {
  return closed && fitsStructuredSource(text);
}
export type SyntaxTone =
  | 'comment'
  | 'keyword'
  | 'string'
  | 'number'
  | 'type'
  | 'function'
  | 'variable'
  | 'constant'
  | 'property'
  | 'operator'
  | 'regexp'
  | 'tag'
  | 'attribute';
/** Ordered so specific Monaco token types win (`string.key.json`, `attribute.value`). */
const syntaxTones: [RegExp, SyntaxTone][] = [
  [/(^|\.)comment(\.|$)/, 'comment'],
  [/(^|\.)regexp(\.|$)/, 'regexp'],
  [/(^|\.)key(\.|$)/, 'property'],
  [/(^|\.)attribute\.value(\.|$)/, 'string'],
  [/(^|\.)attribute(\.|$)/, 'attribute'],
  [/(^|\.)(string|char)(\.|$)/, 'string'],
  [/(^|\.)number(\.|$)/, 'number'],
  [/(^|\.)(keyword|metatag|annotation)(\.|$)/, 'keyword'],
  [/(^|\.)tag(\.|$)/, 'tag'],
  [/(^|\.)type(\.|$)/, 'type'],
  [/(^|\.)(function|method)(\.|$)/, 'function'],
  [/(^|\.)(constant|predefined)(\.|$)/, 'constant'],
  [/(^|\.)variable(\.|$)/, 'variable'],
  [/(^|\.)operators?(\.|$)/, 'operator'],
];
/** Maps a Monaco Monarch token type to a highlight tone; identifiers and delimiters stay plain. */
export function getSyntaxTone(tokenType: string): SyntaxTone | undefined {
  return syntaxTones.find(([pattern]) => pattern.test(tokenType))?.[1];
}
