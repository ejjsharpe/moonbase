import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import * as monaco from 'monaco-editor';
import type { Token, Tokens } from 'marked';
import { controls } from '@moonbase/ui/controls';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import {
  markdownMetrics,
  type MarkdownCache,
  canHighlight,
  getExternalLink,
  type MarkdownBlock,
  type LocatedToken,
} from './markdown-model.ts';

export { markdownMetrics } from './markdown-model.ts';
type Actions = { openLink(url: string): void; copyCode?(start: number): void };
export const Markdown = memo(function Markdown({
  source,
  identity,
  revision,
  cache,
  ...actions
}: Actions & { source: string; identity: string; revision: string; cache: MarkdownCache }) {
  const blocks = useMemo(
    () => cache.parse(identity, revision, source),
    [cache, identity, revision, source],
  );
  return (
    <div {...stylex.props(styles.prose)}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} {...actions} />
      ))}
    </div>
  );
});
const Block = memo(
  function Block({ block, ...actions }: Actions & { block: MarkdownBlock }) {
    const root = useRef<HTMLDivElement>(null);
    const current = useMemo(
      () => ({ block, openLink: actions.openLink, copyCode: actions.copyCode }),
      [block, actions.openLink, actions.copyCode],
    );
    const [retained, setRetained] = useState(current),
      [pinned, setPinned] = useState(false);
    useEffect(() => {
      const update = () => {
        setPinned(isReadingNodePinned(root.current));
      };
      document.addEventListener('selectionchange', update);
      document.addEventListener('focusin', update);
      document.addEventListener('focusout', update);
      return () => {
        document.removeEventListener('selectionchange', update);
        document.removeEventListener('focusin', update);
        document.removeEventListener('focusout', update);
      };
    }, []);
    if (!pinned && retained !== current) setRetained(current);
    const selected = pinned ? retained : current;
    return <div ref={root}>{renderToken(selected.block.token, selected)}</div>;
  },
  (a, b) =>
    a.block.signature === b.block.signature &&
    a.openLink === b.openLink &&
    a.copyCode === b.copyCode,
);
export function isReadingNodePinned(node: HTMLElement | null) {
  const selection = window.getSelection();
  return (
    !!node &&
    (node.contains(document.activeElement) ||
      (!!selection &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        selection.getRangeAt(0).intersectsNode(node)))
  );
}
function inline(tokens: Token[] | undefined, actions: Actions): ReactNode {
  return tokens?.map((token, index) => <span key={index}>{renderToken(token, actions)}</span>);
}
function decodeEntities(text: string) {
  return text.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, (entity) => {
    const field = document.createElement('textarea');
    // Only entity syntax enters this detached text field; model HTML never enters a parser or the DOM.
    field.innerHTML = entity;
    return field.value;
  });
}
function renderToken(token: Token, actions: Actions): ReactNode {
  const code = (token as LocatedToken).sourceCode;
  const value = token as Token & { text?: string; tokens?: Token[] };
  const content = () => (value.tokens ? inline(value.tokens, actions) : value.text);
  switch (token.type) {
    case 'space':
      return null;
    case 'heading': {
      const heading = token as Tokens.Heading;
      const Tag = `h${Math.min(6, Math.max(1, heading.depth))}` as 'h1';
      return <Tag {...stylex.props(styles.heading)}>{content()}</Tag>;
    }
    case 'paragraph':
      return <p {...stylex.props(styles.paragraph)}>{content()}</p>;
    case 'text':
    case 'escape':
      return value.tokens ? inline(value.tokens, actions) : decodeEntities(value.text ?? '');
    case 'strong':
      return <strong>{content()}</strong>;
    case 'em':
      return <em>{content()}</em>;
    case 'del':
      return <del>{content()}</del>;
    case 'codespan':
      return <code {...stylex.props(styles.inlineCode)}>{value.text}</code>;
    case 'br':
      return <br />;
    case 'hr':
      return <hr {...stylex.props(styles.rule)} />;
    case 'html':
      return <span {...stylex.props(styles.literal)}>{token.raw}</span>;
    case 'link':
    case 'image': {
      const link = token as Tokens.Link;
      const url = getExternalLink(link.href);
      const label = token.type === 'image' ? `Image: ${link.text || link.href}` : content();
      return url ? (
        <a
          href={url}
          rel="noopener noreferrer"
          {...stylex.props(styles.link)}
          onClick={(event) => {
            event.preventDefault();
            actions.openLink(url);
          }}
          onAuxClick={(event) => {
            event.preventDefault();
            if (event.button === 1) actions.openLink(url);
          }}>
          {label}
        </a>
      ) : (
        <span>
          {label}{' '}
          {link.href !== link.text && <code {...stylex.props(styles.inlineCode)}>{link.href}</code>}
        </span>
      );
    }
    case 'blockquote':
      return (
        <blockquote {...stylex.props(styles.quote)}>{inline(value.tokens, actions)}</blockquote>
      );
    case 'list': {
      const list = token as Tokens.List,
        Tag = list.ordered ? 'ol' : 'ul';
      return (
        <Tag
          start={list.ordered ? (list.start as number) : undefined}
          {...stylex.props(styles.list)}>
          {list.items.map((item, index) => (
            <li key={index}>
              {item.task && (
                <span aria-label={item.checked ? 'Completed' : 'Incomplete'}>
                  {item.checked ? '[x] ' : '[ ] '}
                </span>
              )}
              {inline(item.tokens, actions)}
            </li>
          ))}
        </Tag>
      );
    }
    case 'table': {
      const table = token as Tokens.Table;
      return (
        <div role="region" aria-label="Table" tabIndex={0} {...stylex.props(styles.overflow)}>
          <table {...stylex.props(styles.table)}>
            <thead>
              <tr>
                {table.header.map((cell, index) => (
                  <th
                    key={index}
                    {...stylex.props(
                      styles.cell,
                      table.align[index] === 'right' && styles.cellRight,
                      table.align[index] === 'center' && styles.cellCenter,
                    )}>
                    {inline(cell.tokens, actions)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      {...stylex.props(
                        styles.cell,
                        table.align[index] === 'right' && styles.cellRight,
                        table.align[index] === 'center' && styles.cellCenter,
                      )}>
                      {inline(cell.tokens, actions)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'code': {
      const block = token as Tokens.Code;
      return (
        <Code
          text={code?.text ?? block.text}
          language={block.lang?.split(/\s/)[0] ?? ''}
          closed={code?.closed ?? block.codeBlockStyle === 'indented'}
          copy={code && actions.copyCode ? () => actions.copyCode!(code.start) : undefined}
        />
      );
    }
    default:
      return <span {...stylex.props(styles.literal)}>{token.raw}</span>;
  }
}
const languages = new Map<string, Promise<void>>();
function prepareLanguage(language: string) {
  if (!languages.has(language))
    languages.set(
      language,
      monaco.editor.colorize('', language, {}).then(() => {}),
    );
  return languages.get(language)!;
}
function tokenize(text: string, language: string) {
  markdownMetrics.tokenize++;
  return monaco.editor.tokenize(text, language);
}
const Code = memo(function Code({
  text,
  language,
  closed,
  copy,
}: {
  text: string;
  language: string;
  closed: boolean;
  copy?: () => void;
}) {
  const pre = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const known = monaco.languages
    .getLanguages()
    .find(
      (value) =>
        value.id === language ||
        value.aliases?.some((alias) => alias.toLowerCase() === language.toLowerCase()) ||
        value.extensions?.includes(`.${language}`),
    );
  const languageId = known?.id;
  const [ready, setReady] = useState('');
  const supported = !!languageId && canHighlight(text, closed);
  useEffect(() => {
    if (!supported || !languageId) return;
    let active = true,
      loaded = false;
    const apply = () => {
      if (active && loaded && !isReadingNodePinned(pre.current)) setReady(languageId);
    };
    document.addEventListener('selectionchange', apply);
    document.addEventListener('focusout', apply);
    void prepareLanguage(languageId).then(
      () => {
        loaded = true;
        apply();
      },
      () => {},
    );
    return () => {
      active = false;
      document.removeEventListener('selectionchange', apply);
      document.removeEventListener('focusout', apply);
    };
  }, [supported, languageId]);
  const tokens = useMemo(
    () =>
      languageId && ready === languageId && canHighlight(text, closed)
        ? tokenize(text, languageId)
        : undefined,
    [text, languageId, closed, ready],
  );
  const lines = text.split('\n');
  const visible = expanded ? lines : lines.slice(0, 40);
  return (
    <div {...stylex.props(styles.code)}>
      <div {...stylex.props(controls.row, styles.codeHeader)}>
        <span>
          {language || 'Plain text'}
          {!closed && ' · Incomplete'}
        </span>
        {copy && (
          <Button {...stylex.props(controls.button, controls.quietButton)} onClick={copy}>
            Copy code
          </Button>
        )}
      </div>
      <pre ref={pre} tabIndex={0} {...stylex.props(controls.pre, styles.codeText)}>
        <code>
          {tokens
            ? visible.map((line, index) => (
                <span key={index}>
                  {tokens?.[index]?.length
                    ? tokens[index]!.map((token, part) => (
                        <span
                          key={part}
                          {...stylex.props(
                            /comment/.test(token.type) && styles.comment,
                            /keyword/.test(token.type) && styles.keyword,
                          )}>
                          {line.slice(token.offset, tokens![index]![part + 1]?.offset)}
                        </span>
                      ))
                    : line}
                  {index < visible.length - 1 ? '\n' : ''}
                </span>
              ))
            : visible.join('\n')}
        </code>
      </pre>
      {lines.length > 40 && (
        <Button
          {...stylex.props(controls.button, controls.quietButton)}
          onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Fold code' : `Show all ${lines.length} lines`}
        </Button>
      )}
    </div>
  );
});
const styles = stylex.create({
  prose: { fontSize: type.message, lineHeight: 1.7, overflowWrap: 'anywhere', minWidth: 0 },
  literal: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', margin: 0 },
  paragraph: { margin: '8px 0' },
  heading: { fontSize: type.heading, fontWeight: 600, lineHeight: 1.5, margin: '24px 0 8px' },
  inlineCode: {
    fontFamily: type.mono,
    fontSize: type.body,
    backgroundColor: colors.elevated,
    borderRadius: radius.control,
    padding: '1px 4px',
  },
  link: {
    color: colors.link,
    textDecoration: 'underline',
    textUnderlineOffset: 3,
    ':focus-visible': { outline: `2px solid ${colors.accent}` },
  },
  quote: {
    color: colors.secondary,
    margin: '12px 0',
    paddingLeft: space.lg,
    borderLeftWidth: 1,
    borderLeftStyle: 'solid',
    borderLeftColor: colors.controlBorder,
  },
  list: { paddingLeft: space.xl, margin: '8px 0' },
  rule: {
    borderWidth: 0,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    margin: '24px 0',
  },
  overflow: { overflowX: 'auto', maxWidth: '100%', margin: '12px 0' },
  table: {
    borderCollapse: 'collapse',
    fontSize: type.body,
    width: 'max-content',
    minWidth: '100%',
  },
  cellRight: { textAlign: 'right' },
  cellCenter: { textAlign: 'center' },
  cell: {
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
    textAlign: 'left',
    padding: '6px 12px',
  },
  code: {
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    margin: '12px 0',
    minWidth: 0,
    overflow: 'hidden',
  },
  codeHeader: {
    justifyContent: 'space-between',
    padding: '4px 12px',
    fontSize: type.small,
    color: colors.secondary,
  },
  codeText: {
    fontFamily: type.mono,
    fontSize: type.body,
    lineHeight: 1.6,
    padding: space.md,
    margin: 0,
    whiteSpace: 'pre',
    maxHeight: 400,
    overflow: 'auto',
  },
  comment: { color: colors.secondary },
  keyword: { fontWeight: 600 },
});
