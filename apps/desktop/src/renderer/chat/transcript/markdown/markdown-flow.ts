import * as stylex from '@stylexjs/stylex';
import { space } from '@moonbase/ui/tokens.stylex';

export const flowStyles = stylex.create({
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
});
