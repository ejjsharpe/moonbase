import * as stylex from '@stylexjs/stylex';
import type { FindMatch } from './find-matches.ts';
import { MarkedRanges } from './marked-text.tsx';
import { styles } from './picker-styles.ts';

/** The highlighted Find match in its surrounding lines. */
export function MatchPreview({ hit }: { hit: FindMatch | undefined }) {
  return (
    <div aria-label="Preview" role="region" {...stylex.props(styles.preview)}>
      {hit && (
        <>
          <div {...stylex.props(styles.previewHeading)}>
            <span {...stylex.props(styles.label)}>{hit.path.split('/').at(-1)}</span>
            <span {...stylex.props(styles.detail)}>line {hit.match.line}</span>
          </div>
          <div {...stylex.props(styles.previewCode)}>
            {[
              ...hit.match.before.map((text, i, all) => ({
                line: hit.match.line - all.length + i,
                text,
              })),
              { line: hit.match.line, text: hit.match.text },
              ...hit.match.after.map((text, i) => ({ line: hit.match.line + 1 + i, text })),
            ].map((row) => (
              <div
                key={row.line}
                {...stylex.props(
                  styles.previewLine,
                  row.line === hit.match.line && styles.previewMatch,
                )}>
                <span {...stylex.props(styles.lineNumber)}>{row.line}</span>
                <span>
                  {row.line === hit.match.line ? (
                    <MarkedRanges text={row.text} ranges={hit.match.ranges} />
                  ) : (
                    row.text
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
