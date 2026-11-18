import { useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import type { Plugin, Transformer } from 'unified';
import { visit } from 'unist-util-visit';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import type { MarkdownBlock } from './markdown-model.ts';
import type { MarkdownActions } from './markdown-context.ts';
import { ExternalLink, ImageLink, insideLink } from './markdown-links.tsx';
import { Code } from './markdown-code.tsx';
import { flowStyles } from './markdown-flow.ts';
import { getFindSourceProps } from '../part/find-ranges.ts';

/** A block's Markdown tree as elements, with our own links, code blocks and tables. */
export function ParsedBlock({
  block,
  openLink,
  copyCode,
}: MarkdownActions & { block: MarkdownBlock }) {
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
      p: ({ children }) => (
        <p {...stylex.props(stylex.defaultMarker(), flowStyles.flow)}>{children}</p>
      ),
      h1: ({ children }) => (
        <h1 {...stylex.props(stylex.defaultMarker(), flowStyles.sectionFlow, styles.heading)}>
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
          <h2 {...stylex.props(stylex.defaultMarker(), flowStyles.sectionFlow, styles.heading)}>
            {children}
          </h2>
        ),
      h3: ({ children }) => (
        <h3 {...stylex.props(stylex.defaultMarker(), flowStyles.sectionFlow, styles.heading)}>
          {children}
        </h3>
      ),
      h4: ({ children }) => (
        <h4 {...stylex.props(stylex.defaultMarker(), flowStyles.sectionFlow, styles.heading)}>
          {children}
        </h4>
      ),
      h5: ({ children }) => (
        <h5 {...stylex.props(stylex.defaultMarker(), flowStyles.sectionFlow, styles.heading)}>
          {children}
        </h5>
      ),
      h6: ({ children }) => (
        <h6 {...stylex.props(stylex.defaultMarker(), flowStyles.sectionFlow, styles.heading)}>
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
            copyStart={typeof start === 'number' && copyCode ? start : undefined}
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
        <blockquote {...stylex.props(stylex.defaultMarker(), flowStyles.flow, styles.quote)}>
          {children}
        </blockquote>
      ),
      ul: ({ children }) => (
        <ul {...stylex.props(stylex.defaultMarker(), flowStyles.flow, styles.list)}>{children}</ul>
      ),
      ol: ({ children, start }) => (
        <ol start={start} {...stylex.props(stylex.defaultMarker(), flowStyles.flow, styles.list)}>
          {children}
        </ol>
      ),
      hr: () => (
        <hr {...stylex.props(stylex.defaultMarker(), flowStyles.sectionFlow, styles.rule)} />
      ),
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
          {...stylex.props(stylex.defaultMarker(), flowStyles.flow, styles.overflow)}>
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
const styles = stylex.create({
  heading: { fontSize: type.heading, fontWeight: 600, lineHeight: 1.5 },
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
});
