import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { layout, space } from '@moonbase/ui/tokens.stylex';

/**
 * The centred reading column rows, a run's line and the transcript's notices share. `row` and
 * `run` mark it as a row's (or a folded run's line), for the list and the reader's place.
 */
export function ReadingColumn({
  row,
  run,
  children,
}: {
  row?: string;
  run?: string;
  children: ReactNode;
}) {
  return (
    <div data-transcript-row={row} data-transcript-run={run} {...stylex.props(styles.row)}>
      <div {...stylex.props(styles.measure)}>{children}</div>
    </div>
  );
}

const styles = stylex.create({
  row: { paddingInline: space.xl, minWidth: 0 },
  measure: { maxWidth: layout.conversation, margin: '0 auto', minWidth: 0 },
});
