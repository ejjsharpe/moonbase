import * as stylex from '@stylexjs/stylex';
import { colors, layout, radius, space, syntax, type } from '@moonbase/ui/tokens.stylex';

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
  rowGap: (gap: number) => ({ paddingTop: gap }),
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
    minHeight: 28,
    fontSize: type.small,
    color: colors.secondary,
    flexWrap: 'wrap',
  },
  /** Only roles other than you and the agent are named, such as a standalone tool entry. */
  role: { fontFamily: type.mono, fontWeight: 700, color: colors.text },
  /** Your messages sit on the right in bubbles; the agent's replies keep the full width. */
  userMessage: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
  bubble: {
    maxWidth: '82%',
    minWidth: 0,
    padding: '2px 14px',
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: '14px 14px 4px 14px',
  },
  messageActions: { display: 'flex', alignItems: 'center', gap: 2, height: 28, flexShrink: 0 },
  userLine: {
    alignSelf: 'stretch',
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'flex-end',
    gap: space.xs,
    minWidth: 0,
  },
  messageTime: { paddingInline: 6, color: colors.muted, fontSize: type.caption },
  /** Row actions stay quiet until the row is hovered or holds focus. */
  revealed: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      [stylex.when.ancestor(':focus-within')]: 1,
    },
  },
  literal: {
    fontFamily: type.ui,
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
  /** Folded tool work reads as one card of steps; consecutive activity rows join into one. */
  activity: {
    position: 'relative',
    minWidth: 0,
    marginBlock: space.sm,
    marginInline: 0,
    paddingBlock: 6,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: radius.panel,
  },
  activityJoinPrevious: {
    marginTop: 0,
    paddingTop: 0,
    borderTopWidth: 0,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
  },
  activityJoinNext: {
    marginBottom: 0,
    paddingBottom: 0,
    borderBottomWidth: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  activityToggle: {
    position: 'absolute',
    top: 2,
    right: 4,
    width: 24,
    height: 24,
    padding: 4,
    color: colors.muted,
    transform: { default: null, ':is([data-panel-open])': 'rotate(180deg)' },
    opacity: {
      default: 0,
      ':focus-visible': 1,
      [stylex.when.ancestor(':hover')]: 1,
    },
  },
  activitySteps: {
    listStyle: 'none',
    margin: 0,
    padding: '1px 0',
    fontFamily: type.mono,
    fontSize: type.small,
    lineHeight: 1.75,
    color: colors.secondary,
  },
  activityStep: {
    paddingInline: '14px 36px',
    // One line per step; the full text is in its title.
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    '::before': {
      content: 'attr(data-glyph)',
      display: 'inline-block',
      width: '1.6em',
      color: syntax.string,
    },
  },
  activityTool: { color: syntax.keyword },
  stepRunning: { '::before': { color: colors.accent } },
  stepFailed: { '::before': { color: colors.danger } },
  stepPending: { '::before': { color: colors.muted } },
  /** A call's output, indented under it. */
  stepOutput: { paddingLeft: 30, color: colors.muted, '::before': { color: colors.muted } },
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
