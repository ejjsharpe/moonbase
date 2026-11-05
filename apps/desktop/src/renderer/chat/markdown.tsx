import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import * as monaco from 'monaco-editor';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { controls } from '@moonbase/ui/controls';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import {
  markdownMetrics,
  type MarkdownCache,
  canHighlight,
  getExternalLink,
  type MarkdownBlock,
} from './markdown-model.ts';

export { markdownMetrics } from './markdown-model.ts';
type Actions = {
  openLink(url: string): void;
  copyCode?(index: number): void;
};
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
    return (
      <div ref={root}>
        <ParsedBlock
          block={selected.block}
          openLink={selected.openLink}
          copyCode={selected.copyCode}
        />
      </div>
    );
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
const insideLink = createContext(false);
function ExternalLink({
  href = '',
  children,
  openLink,
}: {
  href?: string;
  children: ReactNode;
  openLink(url: string): void;
}) {
  const url = getExternalLink(href);
  return url ? (
    <a
      href={url}
      rel="noopener noreferrer"
      {...stylex.props(styles.link)}
      onClick={(event) => {
        event.preventDefault();
        openLink(url);
      }}
      onAuxClick={(event) => {
        event.preventDefault();
        if (event.button === 1) openLink(url);
      }}>
      {children}
    </a>
  ) : (
    <span>
      {children} {href && <code {...stylex.props(styles.inlineCode)}>{href}</code>}
    </span>
  );
}
function ImageLink({
  src,
  alt,
  openLink,
}: {
  src?: string;
  alt?: string;
  openLink(url: string): void;
}) {
  const nested = useContext(insideLink);
  return nested ? (
    alt || src
  ) : (
    <ExternalLink href={src} openLink={openLink}>
      Image: {alt || src}
    </ExternalLink>
  );
}
function ParsedBlock({ block, openLink, copyCode }: Actions & { block: MarkdownBlock }) {
  const plugins = useMemo(() => {
    // ReactMarkdown consumes our shared cached mdast through unified's public parser hook.
    const useTree: Plugin = function () {
      this.parser = () => block.tree;
    };
    return [useTree];
  }, [block]);
  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => <p {...stylex.props(styles.paragraph)}>{children}</p>,
      h1: ({ children }) => <h1 {...stylex.props(styles.heading)}>{children}</h1>,
      h2: ({ children }) => <h2 {...stylex.props(styles.heading)}>{children}</h2>,
      h3: ({ children }) => <h3 {...stylex.props(styles.heading)}>{children}</h3>,
      h4: ({ children }) => <h4 {...stylex.props(styles.heading)}>{children}</h4>,
      h5: ({ children }) => <h5 {...stylex.props(styles.heading)}>{children}</h5>,
      h6: ({ children }) => <h6 {...stylex.props(styles.heading)}>{children}</h6>,
      code: ({ children }) => <code {...stylex.props(styles.inlineCode)}>{children}</code>,
      pre: ({ node }) => {
        const code = node?.children.find(
          (child) => child.type === 'element' && child.tagName === 'code',
        );
        if (code?.type !== 'element') return null;
        const text = code.children
          .map((child) => (child.type === 'text' ? child.value : ''))
          .join('')
          .replace(/\n$/, '')
          .replace(/\r\n?/g, '\n');
        const classes = code.properties.className;
        const language = Array.isArray(classes)
          ? String(classes.find((name) => String(name).startsWith('language-')) ?? '').slice(9)
          : '';
        const index = code.properties['data-code-index'];
        const closed = code.properties['data-code-closed'];
        return (
          <Code
            text={text}
            language={language}
            closed={index === undefined || closed === true || closed === 'true'}
            copy={typeof index === 'number' && copyCode ? () => copyCode(index) : undefined}
          />
        );
      },
      a: ({ href, children, node }) => {
        const images: { src: string; alt: string }[] = [];
        if (node)
          visit(node, 'element', (child) => {
            if (child.tagName === 'img')
              images.push({
                src: String(child.properties.src ?? ''),
                alt: String(child.properties.alt ?? ''),
              });
          });
        return (
          <>
            <ExternalLink href={href} openLink={openLink}>
              <insideLink.Provider value={true}>{children}</insideLink.Provider>
            </ExternalLink>
            {images.map((image, index) => (
              <span key={index}>
                {' '}
                <ImageLink {...image} openLink={openLink} />
              </span>
            ))}
          </>
        );
      },
      img: ({ src, alt }) => (
        <ImageLink src={typeof src === 'string' ? src : undefined} alt={alt} openLink={openLink} />
      ),
      input: ({ checked }) => (
        <span aria-label={checked ? 'Completed' : 'Incomplete'}>{checked ? '[x] ' : '[ ] '}</span>
      ),
      blockquote: ({ children }) => (
        <blockquote {...stylex.props(styles.quote)}>{children}</blockquote>
      ),
      ul: ({ children }) => <ul {...stylex.props(styles.list)}>{children}</ul>,
      ol: ({ children, start }) => (
        <ol start={start} {...stylex.props(styles.list)}>
          {children}
        </ol>
      ),
      hr: () => <hr {...stylex.props(styles.rule)} />,
      table: ({ children }) => (
        <div role="region" aria-label="Table" tabIndex={0} {...stylex.props(styles.overflow)}>
          <table {...stylex.props(styles.table)}>{children}</table>
        </div>
      ),
      th: ({ children, style }) => (
        <th
          {...stylex.props(
            styles.cell,
            style?.textAlign === 'right' && styles.cellRight,
            style?.textAlign === 'center' && styles.cellCenter,
          )}>
          {children}
        </th>
      ),
      td: ({ children, style }) => (
        <td
          {...stylex.props(
            styles.cell,
            style?.textAlign === 'right' && styles.cellRight,
            style?.textAlign === 'center' && styles.cellCenter,
          )}>
          {children}
        </td>
      ),
    }),
    [openLink, copyCode],
  );
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={(url) => url}>
      {''}
    </ReactMarkdown>
  );
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
