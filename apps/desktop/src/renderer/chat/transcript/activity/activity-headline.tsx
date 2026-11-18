import type { MouseEvent, ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { spinner } from '@moonbase/ui/spinner';
import { colors, radius, syntax, type } from '@moonbase/ui/tokens.stylex';
import type { ActivityHeadline } from './activity.ts';

/** A step's line: its state's glyph, then its headline, with the full text in its title. */
export function StepLine({
  state,
  headline,
  onClick,
  children,
}: {
  state: string | undefined;
  headline: ActivityHeadline;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  /** The line's opener, if it opens. */
  children?: ReactNode;
}) {
  return (
    <div
      title={describeHeadlineText(headline)}
      data-glyph={(state && stepGlyphs[state]) ?? '·'}
      onClick={onClick}
      {...stylex.props(
        styles.step,
        stepStyles[state ?? 'unknown'],
        state === 'running' && spinner.glyph,
      )}>
      <span {...stylex.props(styles.action)}>{headline.action}</span>
      {headline.detail && (
        <span {...stylex.props(styles.detail)}>{nbsp + headline.detail.slice(0, 300)}</span>
      )}
      {headline.problem && (
        <span {...stylex.props(styles.problem)}>{`${nbsp}· ${headline.problem}`}</span>
      )}
      {children}
    </div>
  );
}

/** Separates a line's parts: a flex line drops ordinary spaces at its items' edges. */
const nbsp = ' ';

/** A step's headline as one line of text, for its opener's accessible name. */
export const describeHeadlineText = (headline: ActivityHeadline) =>
  [headline.action, headline.detail, headline.problem].filter(Boolean).join(' · ');

const stepGlyphs: Record<string, string> = {
  completed: '✓',
  running: '⠹',
  requested: '○',
  failed: '✕',
  interrupted: '✕',
  'missing-result': '?',
};

const styles = stylex.create({
  /** A step's line: at the answer's size and face, only quieter. */
  step: {
    position: 'relative',
    display: 'flex',
    alignItems: 'baseline',
    paddingBlock: 1,
    paddingInline: '8px 36px',
    fontFamily: type.ui,
    fontSize: type.message,
    lineHeight: 1.7,
    color: colors.secondary,
    borderRadius: radius.control,
    cursor: 'pointer',
    backgroundColor: { default: null, ':hover': colors.hover },
    // One line per step; the full text is in its title.
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    '::before': {
      content: 'attr(data-glyph)',
      flexShrink: 0,
      width: '1.6em',
      color: syntax.string,
    },
  },
  /**
   * A step's verb phrase, then what it touched, quieter, then any trouble. What it touched gives
   * way first when the line is short, so the trouble always shows.
   */
  action: { flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  detail: {
    flexShrink: 1000,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: colors.muted,
  },
  problem: { flexShrink: 0, color: colors.danger },
  running: { '::before': { color: colors.accent } },
  failed: { '::before': { color: colors.danger } },
  pending: { '::before': { color: colors.muted } },
});
const stepStyles: Record<string, stylex.StyleXStyles> = {
  running: styles.running,
  failed: styles.failed,
  interrupted: styles.failed,
  'missing-result': styles.failed,
  requested: styles.pending,
  unknown: styles.pending,
};
