import * as stylex from '@stylexjs/stylex';
import { colors, space } from '@moonbase/ui/tokens.stylex';

export const styles = stylex.create({
  shell: {
    height: '100%',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: colors.canvas,
    color: colors.text,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    padding: space.sm,
    flexWrap: 'wrap',
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
    backgroundColor: colors.chrome,
  },
  title: { flex: 1, minWidth: 80 },
  tabs: {
    padding: '6px 12px',
    height: 'auto',
    minHeight: 40,
    flexShrink: 0,
    WebkitAppRegion: 'no-drag',
  },
  panel: { flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  empty: { padding: space.lg, maxWidth: 740 },
});
