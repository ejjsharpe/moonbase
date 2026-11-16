import * as stylex from '@stylexjs/stylex';

export const treeStyles = stylex.create({
  /** The tree's full scrolled height, in which mounted rows are placed. */
  extent: (height: number) => ({ height, position: 'relative', minWidth: '100%' }),
  row: (top: number) => ({ position: 'absolute', top, width: '100%' }),
  label: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});
