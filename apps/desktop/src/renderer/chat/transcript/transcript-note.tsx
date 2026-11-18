import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';

/** A line of transcript feedback: quiet small text, or a boxed warning. */
export function Note({
  warning = false,
  role,
  label,
  style,
  children,
}: {
  warning?: boolean;
  /** Names the note, for one a reader finds by name. */
  label?: string;
  role?: 'status' | 'alert';
  style?: stylex.StyleXStyles;
  children: ReactNode;
}) {
  return (
    <p
      role={role}
      aria-label={label}
      {...stylex.props(warning ? styles.warning : styles.small, style)}>
      {children}
    </p>
  );
}

const styles = stylex.create({
  small: {
    color: colors.secondary,
    fontSize: type.small,
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
  },
  warning: {
    backgroundColor: colors.warningSurface,
    color: colors.warningText,
    padding: space.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.warningBorder,
    borderRadius: radius.control,
    overflowWrap: 'anywhere',
  },
});
