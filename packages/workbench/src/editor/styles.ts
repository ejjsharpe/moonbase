import * as stylex from '@stylexjs/stylex';
import { colors, space, type } from '@moonbase/ui/tokens.stylex';

export const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 200,
    height: '100%',
    minWidth: 0,
    overflow: 'hidden',
  },
  tabPanel: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 },
  panel: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  grow: { flex: 1 },
  toolbar: { display: 'flex', gap: space.sm, alignItems: 'center', flexWrap: 'wrap' },
  label: { display: 'flex', flexDirection: 'column', gap: space.xs, marginBottom: space.md },
  empty: { margin: space.xl, maxWidth: 540, color: colors.secondary, fontSize: type.body },
  backdrop: { position: 'fixed', inset: 0, backgroundColor: colors.backdrop, zIndex: 50 },
  popup: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 51,
    overflowY: 'auto',
  },
  dialogActions: { display: 'flex', flexWrap: 'wrap', gap: space.sm, marginTop: space.lg },
  treeLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  path: { overflowWrap: 'anywhere', fontSize: type.small, color: colors.secondary },
  treeExtent: (height: number) => ({ height, position: 'relative', minWidth: '100%' }),
  treeRow: (top: number) => ({ position: 'absolute', top, width: '100%' }),
});
