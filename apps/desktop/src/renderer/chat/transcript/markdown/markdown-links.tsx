import { useContext, createContext, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import { getExternalLink } from './markdown-model.ts';

/** Inside a link, an image renders as its text rather than a link of its own. */
export const insideLink = createContext(false);
export function ExternalLink({
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
export function ImageLink({
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
const styles = stylex.create({
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
});
