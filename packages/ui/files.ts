import * as stylex from '@stylexjs/stylex';
import { colors, gitStatus, layout, projectHues, radius, space, type } from './tokens.stylex';

export const filesUI = stylex.create({
  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 6,
    borderColor: 'transparent',
    backgroundColor: { default: 'transparent', ':hover:not(:disabled)': colors.hover },
    color: colors.secondary,
  },
  pressedButton: {
    backgroundColor: { default: colors.selected, ':hover:not(:disabled)': colors.selectedHover },
    color: colors.accent,
  },
  tree: {
    overflow: 'auto',
    flex: '1 1 0',
    minHeight: 80,
    overflowAnchor: 'none',
    outlineOffset: -2,
    ':focus-visible': { outline: `2px solid ${colors.accent}` },
  },
  row: (level: number) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    minHeight: layout.treeRow,
    height: layout.treeRow,
    padding: '3px 6px',
    paddingLeft: 6 + (level - 1) * 16,
    borderRadius: radius.row,
    cursor: 'default',
    fontSize: type.body,
    color: colors.secondary,
    backgroundColor: { default: 'transparent', ':hover': colors.elevated },
  }),
  editing: { height: 'auto' },
  selected: { backgroundColor: { default: colors.selected, ':hover': colors.selectedHover } },
  focused: {
    outline: {
      default: null,
      [stylex.when.ancestor(':focus-visible')]: `1px solid ${colors.accent}`,
    },
    outlineOffset: -1,
  },
  activeLabel: { color: colors.text },
  ignored: { color: colors.muted },
  disclosure: { display: 'inline-flex', width: 16, height: 16, flexShrink: 0 },
  rotated: { transform: 'rotate(90deg)' },
  message: { color: colors.muted, fontSize: type.small },
  // A row's name field: it fits the 28px row, and its error floats over the rows below.
  edit: { position: 'relative', display: 'flex', flex: 1, minWidth: 0 },
  nameField: { flex: 1, minWidth: 0, height: 22, padding: '0 5px', borderRadius: 5 },
  invalidField: { borderColor: colors.danger },
  help: { whiteSpace: 'normal', fontSize: type.small, lineHeight: 1.4 },
  editError: {
    position: 'absolute',
    zIndex: 3,
    top: 'calc(100% + 2px)',
    left: 0,
    right: 0,
    padding: '4px 7px',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    fontSize: type.small,
    lineHeight: 1.4,
    color: colors.text,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.danger,
    borderRadius: radius.control,
  },
  drop: { outline: `2px solid ${colors.accent}`, outlineOffset: -2 },
  // Where dragged tree entries would land: a folder's row and its visible descendants, or the
  // whole tree for the root. It outranks hover and selection while the drag lasts.
  dropRegion: { backgroundColor: { default: colors.selection, ':hover': colors.selection } },
  dropRoot: { backgroundColor: colors.selection },
  // The count shown under the pointer while several entries are dragged; it is drawn off-screen.
  dragImage: {
    position: 'fixed',
    top: -100,
    left: 0,
    padding: '2px 8px',
    borderRadius: radius.control,
    fontFamily: type.ui,
    fontSize: type.small,
    fontWeight: 600,
    color: colors.onAccent,
    backgroundColor: colors.accent,
  },
  dropStatus: {
    position: 'absolute',
    zIndex: 2,
    bottom: 48,
    left: space.md,
    right: space.md,
    maxHeight: '3lh',
    overflow: 'auto',
    overflowWrap: 'anywhere',
  },
  extent: (height: number) => ({ height, position: 'relative' }),
  mounted: (top: number) => ({ position: 'absolute', top, width: '100%' }),
});

const typeMarks: Record<string, { label: string; hue: keyof typeof typeHues }> = {
  ts: { label: 'TS', hue: 'periwinkle' },
  tsx: { label: 'TSX', hue: 'periwinkle' },
  mts: { label: 'TS', hue: 'periwinkle' },
  js: { label: 'JS', hue: 'sand' },
  jsx: { label: 'JSX', hue: 'sand' },
  mjs: { label: 'JS', hue: 'sand' },
  cjs: { label: 'JS', hue: 'sand' },
  json: { label: '{}', hue: 'sand' },
  md: { label: 'MD', hue: 'silver' },
  mdx: { label: 'MDX', hue: 'silver' },
  css: { label: '#', hue: 'pink' },
  scss: { label: '#', hue: 'pink' },
  html: { label: '<>', hue: 'pink' },
  py: { label: 'PY', hue: 'green' },
  rs: { label: 'RS', hue: 'sand' },
  go: { label: 'GO', hue: 'periwinkle' },
  sh: { label: '$', hue: 'green' },
  yml: { label: 'YML', hue: 'lavender' },
  yaml: { label: 'YML', hue: 'lavender' },
  toml: { label: 'TML', hue: 'lavender' },
};
const typeHues = stylex.create({
  silver: { color: projectHues.silver },
  periwinkle: { color: projectHues.periwinkle },
  green: { color: projectHues.green },
  pink: { color: projectHues.pink },
  lavender: { color: projectHues.lavender },
  sand: { color: projectHues.sand },
});
const typeMarkStyle = stylex.create({
  mark: {
    flexShrink: 0,
    minWidth: 18,
    textAlign: 'center',
    fontFamily: type.mono,
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: '-0.02em',
  },
});

/** A short coloured mark for a file's type, such as TS or MD; null for a type it doesn't know. */
export function fileTypeMark(path: string) {
  const extension = path.split('/').at(-1)!.split('.').slice(1).at(-1)?.toLowerCase();
  const mark = extension ? typeMarks[extension] : undefined;
  return mark ? { label: mark.label, style: [typeMarkStyle.mark, typeHues[mark.hue]] } : null;
}

/** A Git status's colour, for a file's name, its letter or a folder's dot. */
export const gitStatusHues = stylex.create({
  added: { color: gitStatus.added },
  untracked: { color: gitStatus.untracked },
  modified: { color: gitStatus.modified },
  deleted: { color: gitStatus.deleted },
  conflicted: { color: gitStatus.conflicted },
  typechange: { color: gitStatus.typechange },
});

/** The trailing marks of a file row: an unsaved dot and a Git status letter or folder dot. */
export const gitStatusUI = stylex.create({
  slot: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    flexShrink: 0,
    minWidth: 12,
    marginLeft: 'auto',
    paddingLeft: 4,
  },
  letter: {
    display: 'inline-block',
    width: 12,
    textAlign: 'center',
    fontFamily: type.mono,
    fontSize: type.caption,
    fontWeight: 600,
  },
  dot: {
    width: 6,
    height: 6,
    marginInline: 3,
    borderRadius: '50%',
    backgroundColor: 'currentColor',
  },
  /** A folder above a conflict: a diamond, so its shape, not only its colour, tells it apart. */
  conflictDot: {
    borderRadius: 1,
    transform: 'rotate(45deg)',
  },
});
