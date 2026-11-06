import * as stylex from '@stylexjs/stylex';
import { colors, layout, radius, space, type } from '@moonbase/ui/tokens.stylex';

/** Pixels a scrolling output grows before it scrolls. */
const outputMaxHeight = 320;

export const transcriptStyles = stylex.create({
  /** The toolbar, then the list filling the rest of the column. */
  transcript: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 60,
    minWidth: 0,
  },
  viewport: { position: 'relative', display: 'flex', flex: 1, minHeight: 0, minWidth: 0 },
  list: { flex: 1, minHeight: 0, minWidth: 0, outline: 'none' },
  /** A centred reading column; rows, the toolbar and the list edges share it. */
  row: { paddingInline: space.xl, minWidth: 0 },
  measure: { maxWidth: layout.conversation, margin: '0 auto', minWidth: 0 },
  edge: { paddingBlock: space.sm },
  navigation: { flexWrap: 'wrap', minHeight: 28 },
  jump: {
    position: 'absolute',
    bottom: space.lg,
    left: '50%',
    transform: 'translateX(-50%)',
    boxShadow: '0 2px 8px rgb(0 0 0 / 0.25)',
  },
  feedback: { padding: space.sm, margin: 0 },
  /** Rows are spaced by the list's gap; a row has no outer margin. */
  message: { margin: 0, minWidth: 0 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    fontSize: type.small,
    color: colors.secondary,
    flexWrap: 'wrap',
  },
  literal: {
    fontFamily: type.sans,
    fontSize: type.message,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    marginBlock: space.sm,
    marginInline: 0,
  },
  output: {
    fontFamily: type.mono,
    fontSize: type.body,
    lineHeight: 1.6,
    maxHeight: outputMaxHeight,
    overflow: 'auto',
    whiteSpace: 'pre',
    marginBlock: space.sm,
    marginInline: 0,
    padding: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
  },
  match: { backgroundColor: colors.selection, color: colors.text, fontWeight: 700 },
  findable: {
    '::highlight(find-match)': { backgroundColor: colors.selection, color: colors.text },
    '::highlight(find-active)': { backgroundColor: colors.accent, color: colors.onAccent },
  },
  disclosure: { minWidth: 0 },
  activity: { minWidth: 0, marginBlock: space.sm, marginInline: 0 },
  activityToggle: { textAlign: 'left', whiteSpace: 'normal' },
  activitySummary: { marginTop: 0, marginBottom: space.sm, paddingInline: space.sm },
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
