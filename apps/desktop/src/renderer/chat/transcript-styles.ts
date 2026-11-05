import * as stylex from '@stylexjs/stylex';
import { colors, layout, radius, space, type } from '@moonbase/ui/tokens.stylex';

/** Pixels a scrolling output grows before it scrolls. */
const outputMaxHeight = 320;

export const transcriptStyles = stylex.create({
  transcript: {
    overflowY: 'auto',
    // Reading anchors sit below the sticky chrome, whose status/notice height changes; native
    // anchoring would hold rows against the scroller top instead, hiding them under the chrome.
    overflowAnchor: 'none',
    flex: 1,
    minHeight: 60,
    paddingBlock: space.sm,
    paddingInline: space.xl,
    minWidth: 0,
  },
  measure: { maxWidth: layout.conversation, margin: '0 auto', minWidth: 0 },
  chrome: { position: 'sticky', top: 0, zIndex: 1, backgroundColor: colors.canvas },
  navigation: { flexWrap: 'wrap', minHeight: 28 },
  feedback: { padding: space.sm, margin: 0 },
  message: { marginBlock: space.xl, marginInline: 0, minWidth: 0 },
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
