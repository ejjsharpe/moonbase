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
  userActions: { justifyContent: 'flex-end' },
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
  disclosure: { minWidth: 0, paddingInline: 10 },
  /** An opened step's recorded parts: a quiet label that folds, with copy on the right. */
  partHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    minWidth: 0,
    paddingInline: '14px 6px',
  },
  partToggle: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'flex-start',
    gap: 6,
    color: colors.muted,
    fontSize: type.caption,
    textAlign: 'left',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  partLabel: {
    flex: 1,
    minWidth: 0,
    paddingBlock: 4,
    color: colors.muted,
    fontSize: type.caption,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  partChevron: {
    display: 'inline-flex',
    flexShrink: 0,
    transform: {
      default: 'rotate(-90deg)',
      [stylex.when.ancestor('[data-panel-open]')]: 'none',
    },
  },
  /** Tool work reads as quiet lines of steps; consecutive activity rows join into one list. */
  activity: {
    position: 'relative',
    // Contains its content's margins, so joined rows have no seam when a step opens.
    display: 'flow-root',
    minWidth: 0,
    marginBlock: space.sm,
    marginInline: 0,
    paddingBlock: 2,
    borderWidth: 0,
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
  /** A call's output row draws no line while closed; open, it shows the output under the call. */
  activityOutput: { paddingTop: 0 },
  /** The step list's opener: always shown, pointing right, and down once its parts are open. */
  activityToggle: {
    position: 'absolute',
    top: 2,
    right: 4,
    width: 24,
    height: 24,
    padding: 4,
    color: colors.muted,
    transform: { default: 'rotate(-90deg)', ':is([data-panel-open])': 'none' },
  },

  activitySteps: {
    listStyle: 'none',
    margin: 0,
    padding: '1px 0',
    // Steps read at the answer's size and face, only quieter.
    fontFamily: type.ui,
    fontSize: type.message,
    lineHeight: 1.7,
    color: colors.secondary,
  },
  activityStep: {
    position: 'relative',
    paddingInline: '8px 36px',
    borderRadius: radius.control,
    cursor: 'pointer',
    backgroundColor: { default: null, ':hover': colors.hover },
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
  activityTool: { color: colors.secondary },
  activityDetail: { color: colors.muted },
  activityProblem: { color: colors.danger },
  /**
   * A folded run reads as the heading of the answer under it: the answer's text sits as far below
   * the rule as the "Worked for" text sits above it, not a full gap between list items.
   */
  activityGroup: { marginBottom: -24 },
  /** Open, the first step's letters start 16px below the rule… */
  activityGroupOpen: { marginBottom: 5 },
  /** …and the answer sits as far below the last step. */
  activityGroupSteps: { marginBottom: -35 },
  /** A folded run of tool rows: "Worked for 1m 29s", a chevron, the time, and a rule under it. */
  activityFold: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    paddingTop: 2,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
  },
  activityFoldButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    paddingInline: 4,
    fontFamily: type.ui,
    fontSize: type.message,
    lineHeight: 1.7,
    color: { default: colors.muted, ':hover': colors.text },
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
  },
  /** Points right while folded, down once open. */
  activityFoldChevron: {
    display: 'inline-flex',
    transform: { default: 'rotate(-90deg)', ':is([aria-expanded=true] *)': 'none' },
  },
  activityFoldTime: {
    marginLeft: 'auto',
    paddingInline: 4,
    color: colors.muted,
    fontSize: type.caption,
    fontVariantNumeric: 'tabular-nums',
  },
  /**
   * An opened step's recorded parts, indented under it behind a rule, so it is plain where the step
   * ends and the next closed step begins. A call's output row continues the same rule.
   */
  activityPanel: {
    marginInline: '20px 8px',
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftStyle: 'solid',
    borderLeftColor: colors.border,
    // Its last block's own bottom margin would push the next line further than a closed step's.
    marginBottom: -4,
    ':empty': { display: 'none' },
  },
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
