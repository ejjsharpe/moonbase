import { LRUCache } from 'lru-cache';
import type { Root } from 'mdast';
import { EXIT, visit } from 'unist-util-visit';
import { parseTranscriptMarkdown } from '../../chat/transcript-source.ts';
export type MarkdownBlock = { tree: Root; signature: string };
type ParsedMessage = { source: string; blocks: MarkdownBlock[] };
export const markdownMetrics = { lex: 0, tokenize: 0, retainedBytes: 0, messages: 0 };
const bytes = (text: string) => new TextEncoder().encode(text).length;
/** A private, per-view bounded cache. Exact source and render inputs, never DTO object identity. */
export class MarkdownCache {
  private messages = new LRUCache<string, ParsedMessage>({
    max: 128,
    maxSize: 2 * 1024 * 1024,
    sizeCalculation: ({ source, blocks }, key) =>
      bytes(key) + bytes(source) + bytes(JSON.stringify(blocks)),
  });
  readonly stats = { lex: 0, retainedBytes: 0, messages: 0 };
  parse(identity: string, revision: string, source: string): MarkdownBlock[] {
    const key = JSON.stringify([identity, revision]);
    const old = this.messages.get(key);
    if (old?.source === source) return old.blocks;
    this.stats.lex++;
    markdownMetrics.lex++;
    const { tree } = parseTranscriptMarkdown(source);
    // Definitions apply document-wide, so only messages without them split into blocks.
    let definitions = false;
    visit(tree, ['definition', 'footnoteDefinition'], () => {
      definitions = true;
      return EXIT;
    });
    const blocks = (
      definitions ? [tree] : tree.children.map((node): Root => ({ type: 'root', children: [node] }))
    ).map((block) => ({
      tree: block,
      signature: JSON.stringify(block, (key, value) => (key === 'position' ? undefined : value)),
    }));
    this.messages.set(key, { source, blocks });
    this.recordRetention();
    return blocks;
  }
  clear() {
    this.messages.clear();
    this.recordRetention();
  }
  private recordRetention() {
    this.stats.retainedBytes = markdownMetrics.retainedBytes = this.messages.calculatedSize;
    this.stats.messages = markdownMetrics.messages = this.messages.size;
  }
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
  return closed && bytes(text) <= 64 * 1024 && text.split(/\r?\n/).length <= 2000;
}
