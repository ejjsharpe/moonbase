import { parseTranscriptMarkdown } from '../../chat/transcript-source.ts';
import type { Root } from 'mdast';
export type MarkdownBlock = { tree: Root; signature: string };
export const markdownMetrics = { lex: 0, tokenize: 0, retainedBytes: 0, messages: 0 };
const bytes = (text: string) => new TextEncoder().encode(text).length;
/** A private, per-view bounded cache. Exact source and render inputs, never DTO object identity. */
export class MarkdownCache {
  private messages = new Map<string, { source: string; blocks: MarkdownBlock[]; bytes: number }>();
  private retained = 0;
  readonly stats = { lex: 0, retainedBytes: 0, messages: 0 };
  parse(identity: string, revision: string, source: string): MarkdownBlock[] {
    const key = JSON.stringify([identity, revision, 'remark-gfm-v2']);
    const old = this.messages.get(key);
    if (old?.source === source) {
      this.messages.delete(key);
      this.messages.set(key, old);
      return old.blocks;
    }
    this.stats.lex++;
    markdownMetrics.lex++;
    const { tree } = parseTranscriptMarkdown(source);
    const definitions = tree.children.filter(
      (node) => node.type === 'definition' || node.type === 'footnoteDefinition',
    );
    const blocks = tree.children
      .filter((node) => node.type !== 'definition' && node.type !== 'footnoteDefinition')
      .map((node) => {
        const block: Root = { type: 'root', children: [node, ...definitions] };
        return {
          tree: block,
          signature: JSON.stringify(block, (key, value) =>
            key === 'position' ? undefined : value,
          ),
        };
      });
    const size = bytes(key) + bytes(source) + bytes(JSON.stringify(blocks));
    if (old) {
      this.messages.delete(key);
      this.retained -= old.bytes;
    }
    if (size <= 2 * 1024 * 1024) {
      this.messages.set(key, { source, blocks, bytes: size });
      this.retained += size;
    }
    while (this.messages.size > 128 || this.retained > 2 * 1024 * 1024) {
      const first = this.messages.keys().next().value!;
      this.retained -= this.messages.get(first)!.bytes;
      this.messages.delete(first);
    }
    this.stats.retainedBytes = this.retained;
    this.stats.messages = this.messages.size;
    markdownMetrics.retainedBytes = this.retained;
    markdownMetrics.messages = this.messages.size;
    return blocks;
  }
  clear() {
    this.messages.clear();
    this.retained = 0;
    this.stats.retainedBytes = 0;
    this.stats.messages = 0;
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
