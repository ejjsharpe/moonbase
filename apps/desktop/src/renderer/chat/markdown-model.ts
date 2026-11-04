import { marked, type Token, type Tokens } from 'marked';
import { locateFences, type CodeSource } from '../../chat/transcript-source.ts';
export { locateFences } from '../../chat/transcript-source.ts';

export type LocatedToken = Token & { sourceCode?: CodeSource };
export type MarkdownBlock = { token: LocatedToken; signature: string };
export const markdownMetrics = { lex: 0, tokenize: 0, retainedBytes: 0, messages: 0 };
const bytes = (text: string) => new TextEncoder().encode(text).length;
/** A private, per-view bounded cache. Exact source and render inputs, never DTO object identity. */
export class MarkdownCache {
  private messages = new Map<string, { source: string; blocks: MarkdownBlock[]; bytes: number }>();
  private retained = 0;
  readonly stats = { lex: 0, retainedBytes: 0, messages: 0 };
  parse(identity: string, revision: string, source: string): MarkdownBlock[] {
    const key = JSON.stringify([identity, revision, 'gfm-v1']);
    const old = this.messages.get(key);
    if (old?.source === source) {
      this.messages.delete(key);
      this.messages.set(key, old);
      return old.blocks;
    }
    this.stats.lex++;
    markdownMetrics.lex++;
    let tokens: Token[];
    try {
      tokens = marked.lexer(source, { gfm: true });
    } catch {
      tokens = [{ type: 'html', raw: source, text: source, block: true, pre: true }];
    }
    const fences = locateFences(source);
    const normalized = source.replace(/\r\n?/g, '\n');
    let position = 0;
    for (const outer of tokens) {
      const start = normalized.indexOf(outer.raw, position);
      if (start < 0) continue;
      const end = start + outer.raw.length;
      position = end;
      const candidates = fences.filter((fence) => {
        const offset = source.slice(0, fence.start).replace(/\r\n?/g, '\n').length;
        return offset >= start && offset < end;
      });
      marked.walkTokens([outer], (token) => {
        if (token.type !== 'code' || (token as Tokens.Code).codeBlockStyle === 'indented') return;
        const candidate = candidates.shift();
        if (
          candidate &&
          candidate.text.replace(/\r\n?/g, '\n').replace(/\n$/, '') === (token as Tokens.Code).text
        )
          (token as LocatedToken).sourceCode = candidate;
      });
    }
    const blocks = tokens.map((token) => ({ token, signature: JSON.stringify(token) }));
    const size = bytes(source) + bytes(JSON.stringify(blocks));
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
