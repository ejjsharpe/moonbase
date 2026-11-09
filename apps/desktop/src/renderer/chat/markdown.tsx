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
import { Collapsible } from '@base-ui/react/collapsible';
import { Icon } from '../icon.tsx';
import * as stylex from '@stylexjs/stylex';
import * as monaco from 'monaco-editor';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import type { Plugin, Transformer } from 'unified';
import { visit } from 'unist-util-visit';
import { controls } from '@moonbase/ui/controls';
import { colors, radius, space, syntax, type } from '@moonbase/ui/tokens.stylex';
import {
  foldedCodeLines,
  markdownWork,
  type MarkdownCache,
  canHighlight,
  getExternalLink,
  getSyntaxTone,
  type MarkdownBlock,
  type SyntaxTone,
} from './markdown-model.ts';
import { useReadingPin } from './reading-pin.ts';
import { useRememberedExpansion } from './transcript-disclosure.ts';
import { getFindSourceProps } from './part-find.tsx';

/** Pixels a code block grows before scrolling. */
const codeMaxHeight = 400;
type Actions = {
  openLink(url: string): void;
  /** Must keep its identity while the message streams, or every block re-renders. */
  copyCode?(start: number): void;
};
/** Source offsets of the active Find match. */
type FindTarget = { start: number; end: number };
/** The active Find match. Keeps its identity while the match is unchanged. */
const ActiveFindMatch = createContext<FindTarget | null>(null);
export const Markdown = memo(function Markdown({
  source,
  identity,
  revision,
  cache,
  findTarget = null,
  ...actions
}: Actions & {
  source: string;
  identity: string;
  revision: string;
  cache: MarkdownCache;
  /** Must keep its identity while unchanged. */
  findTarget?: FindTarget | null;
}) {
  const blocks = useMemo(
    () => cache.parse(identity, revision, source),
    [cache, identity, revision, source],
  );
  return (
    <ActiveFindMatch.Provider value={findTarget}>
      <div {...stylex.props(styles.prose)}>
        {blocks.map((block) => (
          <Block key={block.key} block={block} {...actions} />
        ))}
      </div>
    </ActiveFindMatch.Provider>
  );
});
const Block = memo(
  function Block({ block, ...actions }: Actions & { block: MarkdownBlock }) {
    const root = useRef<HTMLDivElement>(null);
    const current = useMemo(
      () => ({ block, openLink: actions.openLink, copyCode: actions.copyCode }),
      [block, actions.openLink, actions.copyCode],
    );
    const [retained, setRetained] = useState(current);
    // A reader's focus or selection holds the block they are reading still.
    const pinned = useReadingPin(root) !== 0;
    if (!pinned && retained !== current) setRetained(current);
    const selected = pinned ? retained : current;
    // A split block renders exactly its node's source; Find maps its matches within it.
    const only = selected.block.tree.children.length === 1 ? selected.block.tree.children[0] : null;
    const start = only?.position?.start.offset,
      end = only?.position?.end.offset;
    return (
      <div
        ref={root}
        {...(start !== undefined && end !== undefined ? getFindSourceProps(start, end) : {})}
        {...stylex.props(
          stylex.defaultMarker(),
          only?.type === 'heading' || only?.type === 'thematicBreak'
            ? styles.sectionFlow
            : styles.flow,
        )}>
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
const insideLink = createContext(false);
function ExternalLink({
  href = '',
  children,
  openLink,
  autolink = false,
}: {
  href?: string;
  children: ReactNode;
  openLink(url: string): void;
  /** The visible text already shows the href, so the shown href is not source for Find. */
  autolink?: boolean;
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
      {children}{' '}
      {href && (
        <code data-find-ignore={autolink || undefined} {...stylex.props(styles.inlineCode)}>
          {href}
        </code>
      )}
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
    <ExternalLink href={src} openLink={openLink} autolink={!alt}>
      <span data-find-ignore>Image: </span>
      {alt || src}
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
  const rehypePlugins = useMemo(() => [markFindSources], []);
  const components = useMemo<Components>(
    () => ({
      p: ({ children }) => <p {...stylex.props(stylex.defaultMarker(), styles.flow)}>{children}</p>,
      h1: ({ children }) => (
        <h1 {...stylex.props(stylex.defaultMarker(), styles.sectionFlow, styles.heading)}>
          {children}
        </h1>
      ),
      // GFM labels its footnotes with a visually hidden heading.
      h2: ({ children, node }) =>
        isFootnoteLabel(node) ? (
          <h2 data-find-ignore {...stylex.props(styles.visuallyHidden)}>
            {children}
          </h2>
        ) : (
          <h2 {...stylex.props(stylex.defaultMarker(), styles.sectionFlow, styles.heading)}>
            {children}
          </h2>
        ),
      h3: ({ children }) => (
        <h3 {...stylex.props(stylex.defaultMarker(), styles.sectionFlow, styles.heading)}>
          {children}
        </h3>
      ),
      h4: ({ children }) => (
        <h4 {...stylex.props(stylex.defaultMarker(), styles.sectionFlow, styles.heading)}>
          {children}
        </h4>
      ),
      h5: ({ children }) => (
        <h5 {...stylex.props(stylex.defaultMarker(), styles.sectionFlow, styles.heading)}>
          {children}
        </h5>
      ),
      h6: ({ children }) => (
        <h6 {...stylex.props(stylex.defaultMarker(), styles.sectionFlow, styles.heading)}>
          {children}
        </h6>
      ),
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
        const start = code.properties['data-code-start'];
        const closed = code.properties['data-code-closed'];
        const fold = code.properties['data-code-fold'];
        const position = node?.position;
        return (
          <Code
            text={text}
            language={language}
            closed={start === undefined || closed === true || closed === 'true'}
            copy={typeof start === 'number' && copyCode ? () => copyCode(start) : undefined}
            foldId={typeof start === 'number' ? `code:${start}` : undefined}
            sourceStart={position?.start.offset}
            sourceEnd={position?.end.offset}
            foldStart={typeof fold === 'number' ? fold : undefined}
          />
        );
      },
      a: ({ href, children, node }) => {
        // Footnote links jump within this message; with no safe target they render as plain text.
        if (node?.properties.dataFootnoteBackref !== undefined) return null;
        // The reference renders its number, not its source label.
        if (node?.properties.dataFootnoteRef !== undefined)
          return <span data-find-ignore>{children}</span>;
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
            <ExternalLink href={href} openLink={openLink} autolink={isAutolink(node, href)}>
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
        <blockquote {...stylex.props(stylex.defaultMarker(), styles.flow, styles.quote)}>
          {children}
        </blockquote>
      ),
      ul: ({ children }) => (
        <ul {...stylex.props(stylex.defaultMarker(), styles.flow, styles.list)}>{children}</ul>
      ),
      ol: ({ children, start }) => (
        <ol start={start} {...stylex.props(stylex.defaultMarker(), styles.flow, styles.list)}>
          {children}
        </ol>
      ),
      hr: () => <hr {...stylex.props(stylex.defaultMarker(), styles.sectionFlow, styles.rule)} />,
      section: ({ children, node }) => (
        <section
          {...stylex.props(node?.properties.dataFootnotes !== undefined && styles.footnotes)}>
          {children}
        </section>
      ),
      table: ({ children }) => (
        <div
          role="region"
          aria-label="Table"
          tabIndex={0}
          {...stylex.props(stylex.defaultMarker(), styles.flow, styles.overflow)}>
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
    <ReactMarkdown
      remarkPlugins={plugins}
      rehypePlugins={rehypePlugins}
      components={components}
      urlTransform={(url) => url}>
      {''}
    </ReactMarkdown>
  );
}
type HastElement = NonNullable<ExtraProps['node']>;
/**
 * Marks each element with the source it renders, so Find maps matches within it. Footnote
 * definitions render at the end, out of source order, and keep their own span this way. Elements
 * rendered by our components drop the mark; Code and split blocks mark themselves.
 */
const markFindSources: Plugin<[], Parameters<Transformer>[0]> = () => (tree) => {
  visit(tree, 'element', (node) => {
    const element = node as HastElement,
      start = element.position?.start.offset,
      end = element.position?.end.offset;
    if (start !== undefined && end !== undefined)
      Object.assign(element.properties, getFindSourceProps(start, end));
  });
};
/** A link whose visible text is its href, or an email autolink. */
function isAutolink(node: ExtraProps['node'], href = '') {
  let label = '';
  if (node)
    visit(node, 'text', (text) => {
      label += text.value;
    });
  return label === href || href === 'mailto:' + label;
}
function isFootnoteLabel(node: ExtraProps['node']) {
  const classes = node?.properties.className;
  return Array.isArray(classes) && classes.includes('sr-only');
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
  markdownWork.tokenize++;
  return monaco.editor.tokenize(text, language);
}
const Code = memo(function Code({
  text,
  language,
  closed,
  copy,
  sourceStart,
  sourceEnd,
  foldStart,
  foldId,
}: {
  text: string;
  language: string;
  closed: boolean;
  copy?: () => void;
  /** The block's source offsets, fences included. */
  sourceStart?: number;
  sourceEnd?: number;
  /** Where the folded lines start in the source. */
  foldStart?: number;
  /** Names the block's unfolding in its row's view memory. */
  foldId?: string;
}) {
  const pre = useRef<HTMLPreElement>(null);
  /**
   * Folded code shows its first lines; the rest render only while unfolded. The reader's unfolding
   * is remembered; Find's is not.
   */
  const remembered = useRememberedExpansion(foldId ?? null);
  const lines = text.split('\n');
  const foldable = lines.length > foldedCodeLines;
  const findMatch = useContext(ActiveFindMatch);
  /** Find maps the shown and folded lines as separate source spans. */
  const spans =
    foldable && sourceStart !== undefined && sourceEnd !== undefined && foldStart !== undefined
      ? { start: sourceStart, fold: foldStart, end: sourceEnd }
      : null;
  /** The Find match last checked for unfolding, and whether Find unfolded the code while mounted. */
  const [revealed, setRevealed] = useState({ match: null as FindTarget | null, open: false });
  // A newly active Find match in the folded lines unfolds them once; the reader can fold again.
  // The unfolding is Find's, not the reader's, so it is not remembered, and nothing saves the view
  // while the list is still moving to the match.
  if (findMatch !== revealed.match)
    setRevealed({
      match: findMatch,
      open:
        revealed.open ||
        (!!findMatch && !!spans && findMatch.end > spans.fold && findMatch.start < spans.end),
    });
  const unfolded = remembered.open || revealed.open;
  const setUnfolded = (open: boolean) => {
    if (!open && revealed.open) setRevealed({ ...revealed, open: false });
    remembered.setOpen(open);
  };
  const known = monaco.languages
    .getLanguages()
    .find(
      (value) =>
        value.id === language ||
        value.aliases?.some((alias) => alias.toLowerCase() === language.toLowerCase()) ||
        value.extensions?.includes(`.${language}`),
    );
  const languageId = known?.id;
  const supported = !!languageId && canHighlight(text, closed);
  const [loaded, setLoaded] = useState('');
  const [ready, setReady] = useState('');
  useEffect(() => {
    if (!supported || !languageId) return;
    let active = true;
    void prepareLanguage(languageId).then(
      () => {
        if (active) setLoaded(languageId);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [supported, languageId]);
  // Highlighting replaces the text nodes, so it waits until no reader focus or selection is
  // inside, and stops listening once applied.
  const waiting = supported && ready !== languageId;
  const pinned = useReadingPin(pre, waiting) !== 0;
  if (waiting && languageId && loaded === languageId && !pinned) setReady(languageId);
  const tokens = useMemo(
    () =>
      languageId && ready === languageId && canHighlight(text, closed)
        ? tokenize(text, languageId)
        : undefined,
    [text, languageId, closed, ready],
  );
  const renderLines = (from: number, to: number) => {
    const shown = lines.slice(from, to);
    if (!tokens) return shown.join('\n');
    return shown.map((line, offset) => {
      const index = from + offset,
        lineTokens = tokens[index];
      return (
        <span key={index}>
          {lineTokens?.length
            ? lineTokens.map((token, part) => {
                const tone = getSyntaxTone(token.type);
                return (
                  <span key={part} {...stylex.props(tone && toneStyles[tone])}>
                    {line.slice(token.offset, lineTokens[part + 1]?.offset)}
                  </span>
                );
              })
            : line}
          {offset < shown.length - 1 ? '\n' : ''}
        </span>
      );
    });
  };
  return (
    <Collapsible.Root
      open={unfolded}
      onOpenChange={setUnfolded}
      {...(sourceStart !== undefined && sourceEnd !== undefined
        ? getFindSourceProps(sourceStart, sourceEnd)
        : {})}
      {...stylex.props(stylex.defaultMarker(), styles.flow, styles.code)}>
      <div {...stylex.props(controls.row, styles.codeHeader)}>
        <span data-find-ignore>
          {language || 'Plain text'}
          {!closed && ' · Incomplete'}
        </span>
        {copy && (
          <Button
            aria-label="Copy code"
            title="Copy code"
            {...stylex.props(controls.button, controls.iconButton)}
            onClick={copy}>
            <Icon name="copy" />
          </Button>
        )}
      </div>
      <pre ref={pre} tabIndex={0} {...stylex.props(controls.pre, styles.codeText)}>
        <code>
          {spans ? (
            <span {...getFindSourceProps(spans.start, spans.fold)}>
              {renderLines(0, foldedCodeLines)}
            </span>
          ) : (
            renderLines(0, foldable ? foldedCodeLines : lines.length)
          )}
          {foldable && (
            <Collapsible.Panel
              render={<span />}
              {...(spans && getFindSourceProps(spans.fold, spans.end))}>
              {'\n'}
              {renderLines(foldedCodeLines, lines.length)}
            </Collapsible.Panel>
          )}
        </code>
      </pre>
      {foldable && (
        <Collapsible.Trigger {...stylex.props(controls.button, controls.quietButton)}>
          {unfolded ? 'Fold code' : `Show all ${lines.length} lines`}
        </Collapsible.Trigger>
      )}
    </Collapsible.Root>
  );
});
const styles = stylex.create({
  prose: { fontSize: type.message, lineHeight: 1.7, overflowWrap: 'anywhere', minWidth: 0 },
  /**
   * Blocks are spaced only between each other, at any depth: no space above a message's first
   * block or below its last, so a row's own spacing decides how far it sits from the next.
   */
  flow: {
    marginTop: { default: 0, [stylex.when.siblingBefore(':is(*)')]: space.md },
    marginBottom: 0,
    marginInline: 0,
  },
  /** A heading or rule starts a section, so it sits further from what came before. */
  sectionFlow: {
    marginTop: { default: 0, [stylex.when.siblingBefore(':is(*)')]: space.xl },
    marginBottom: 0,
    marginInline: 0,
  },
  heading: {
    fontSize: type.heading,
    fontWeight: 600,
    lineHeight: 1.5,
  },
  visuallyHidden: {
    position: 'absolute',
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  footnotes: { color: colors.secondary, fontSize: type.small },
  inlineCode: {
    fontFamily: type.mono,
    fontSize: type.body,
    backgroundColor: colors.elevated,
    borderRadius: radius.control,
    paddingInline: space.xs,
  },
  link: {
    color: colors.link,
    textDecoration: 'underline',
    textUnderlineOffset: 3,
    ':focus-visible': { outline: `2px solid ${colors.accent}` },
  },
  quote: {
    color: colors.secondary,
    paddingLeft: space.lg,
    borderLeftWidth: 1,
    borderLeftStyle: 'solid',
    borderLeftColor: colors.controlBorder,
  },
  list: { paddingLeft: space.xl },
  rule: {
    borderWidth: 0,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
  },
  overflow: { overflowX: 'auto', maxWidth: '100%' },
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
    paddingBlock: space.xs,
    paddingInline: space.md,
  },
  code: {
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
    minWidth: 0,
    overflow: 'hidden',
  },
  codeHeader: {
    justifyContent: 'space-between',
    paddingBlock: space.xs,
    paddingInline: space.md,
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
    maxHeight: codeMaxHeight,
    overflow: 'auto',
  },
});
const tones = stylex.create({
  comment: { color: syntax.comment },
  keyword: { color: syntax.keyword },
  string: { color: syntax.string },
  number: { color: syntax.number },
  type: { color: syntax.type },
  function: { color: syntax.function },
  variable: { color: syntax.variable },
  constant: { color: syntax.constant },
  property: { color: syntax.variable },
  operator: { color: syntax.operator },
  regexp: { color: syntax.regexp },
  tag: { color: syntax.keyword },
  attribute: { color: syntax.variable },
});
const toneStyles: Record<SyntaxTone, stylex.StyleXStyles> = tones;
