import { marked, type Token, type Tokens } from 'marked';

export type TranscriptMarkdownToken = Token & { codeBlock?: { index: number; closed: boolean } };

/** Both presentations and native Copy use the same parser-owned block order and value. */
export function parseTranscriptMarkdown(source: string) {
  try {
    const tokens: Token[] = marked.lexer(source, { gfm: true }),
      codeBlocks: Tokens.Code[] = [];
    marked.walkTokens(tokens, (token) => {
      if (token.type !== 'code' || token.codeBlockStyle === 'indented') return;
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw)?.[1];
      const closing = /\n {0,3}(`+|~+)[ \t]*\n*$/.exec(token.raw)?.[1];
      (token as TranscriptMarkdownToken).codeBlock = {
        index: codeBlocks.length,
        closed:
          !!opening && !!closing && opening[0] === closing[0] && closing.length >= opening.length,
      };
      codeBlocks.push(token as Tokens.Code);
    });
    return { tokens, codeBlocks };
  } catch {
    return {
      tokens: [{ type: 'html', raw: source, text: source, block: true, pre: true }] as Token[],
      codeBlocks: [] as Tokens.Code[],
    };
  }
}

/** View-memory keys must fit its byte bound even when both public IDs are maximal. */
export function getTranscriptDisclosureId(
  entryId: string,
  partId: string,
): string | Promise<string> {
  const identity = JSON.stringify([entryId, partId]),
    data = new TextEncoder().encode(identity);
  if (data.length <= 256) return identity;
  return crypto.subtle
    .digest('SHA-256', data)
    .then(
      (digest) =>
        'sha256:' +
        [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    );
}
