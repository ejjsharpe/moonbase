import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Code, Root } from 'mdast';
import type { Extension } from 'mdast-util-from-markdown';

declare module 'mdast' {
  interface CodeData {
    codeBlock?: { closed: boolean };
  }
}

// Observe parser fence events; indented literals never produce these events.
const recordFences: Plugin = function () {
  const extensions = this.data('fromMarkdownExtensions') ?? [];
  const extension: Extension = {
    enter: {
      codeFencedFence() {
        const node = this.stack.findLast((node) => node.type === 'code');
        if (node?.type === 'code') {
          node.data ??= {};
          node.data.codeBlock = { closed: !!node.data.codeBlock };
        }
      },
    },
  };
  this.data('fromMarkdownExtensions', [...extensions, extension]);
};
const parser = unified().use(remarkParse).use(remarkGfm).use(recordFences);

/** Rendering and privileged Copy share this exact Markdown interpretation. */
export function parseTranscriptMarkdown(source: string): { tree: Root; codeBlocks: Code[] } {
  try {
    const tree = parser.parse(source),
      codeBlocks: Code[] = [];
    visit(tree, 'code', (node) => {
      const start = node.position?.start.offset;
      if (!node.data?.codeBlock || start === undefined) return;
      node.data.hProperties = {
        'data-code-start': start,
        'data-code-closed': node.data.codeBlock.closed,
      };
      codeBlocks.push(node);
    });
    return { tree, codeBlocks };
  } catch {
    return {
      tree: {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: source }] }],
      },
      codeBlocks: [],
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
