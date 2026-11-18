import * as stylex from '@stylexjs/stylex';
import { type } from '@moonbase/ui/tokens.stylex';

/** Text styles rows and their parts share. */
export const textStyles = stylex.create({
  /** Recorded text as it was written: a user's message, plain parts, a Find excerpt. */
  literal: {
    fontFamily: type.ui,
    fontSize: type.message,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    margin: 0,
  },
  /** Row actions and times stay quiet until the row is hovered or holds focus. */
  revealed: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      [stylex.when.ancestor(':focus-within')]: 1,
    },
  },
});
