import * as stylex from '@stylexjs/stylex';

// Tranquility: moonlight silver and greys; color is reserved for meaning.
// Static values also feed Monaco's theme API, which requires literal colors.
export const colors = stylex.defineConsts({
  canvas: '#14151b',
  chrome: '#0b0c10',
  surface: '#0f1015',
  elevated: '#1c1e26',
  hover: '#20222b',
  selected: '#252833',
  selectedHover: '#2c2f3b',
  text: '#dcdfe8',
  secondary: '#b4b8c6',
  muted: '#8b90a0',
  border: '#23252e',
  controlBorder: '#343744',
  scrollShadow: '#00000033',
  accent: '#dcdfe8',
  onAccent: '#0b0c10',
  link: '#ffffff',
  selection: '#2f3443',
  warningSurface: '#2b2418',
  warningBorder: '#7a5a2a',
  warningText: '#f2b35b',
  danger: '#f28b82',
  backdrop: '#0009',
});

// Project rail tile hues, read with `colors.onAccent`; every checkout of a repository shares one.
export const projectHues = stylex.defineConsts({
  silver: '#c9ced9',
  periwinkle: '#9fb7ff',
  green: '#a7d98b',
  pink: '#e8a0bf',
  lavender: '#c3a6f0',
  sand: '#d9c8a0',
});

// Git status of a file, from the palette above: green is new, sand is edited, danger is gone,
// amber needs resolving and lavender changed type.
export const gitStatus = stylex.defineConsts({
  added: '#a7d98b',
  untracked: '#a7d98b',
  modified: '#d9c8a0',
  deleted: '#f28b82',
  conflicted: '#f2b35b',
  typechange: '#c3a6f0',
});

// Code highlighting for read-only code and Monaco's theme rules alike.
export const syntax = stylex.defineConsts({
  comment: '#878c9e',
  keyword: '#9fb7ff',
  string: '#a7d98b',
  number: '#d9c8a0',
  type: '#c3a6f0',
  function: '#e6e9f0',
  variable: '#c9ced9',
  constant: '#d9c8a0',
  operator: '#b4b8c6',
  regexp: '#e8a0bf',
});

export const space = stylex.defineConsts({
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
});

// BlexMono Nerd Font Mono is bundled by `@moonbase/ui/fonts.css`; the interface is monospaced too.
export const type = stylex.defineConsts({
  ui: '"BlexMono Nerd Font Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace',
  mono: '"BlexMono Nerd Font Mono", "IBM Plex Mono", ui-monospace, Menlo, monospace',
  caption: 11,
  small: 12,
  body: 13,
  message: 15,
  heading: 16,
});

/** Lift for surfaces that float over the canvas, such as a new chat's composer. */
export const shadow = stylex.defineConsts({ raised: '0 18px 44px #00000080' });
export const radius = stylex.defineConsts({ control: 7, row: 7, panel: 10, composer: 10 });
export const layout = stylex.defineConsts({ conversation: 640, treeRow: 28 });
export const sidebar = stylex.defineVars({ width: '270px' });
/** The app rail: its width, its tiles and the space around them. */
export const rail = stylex.defineVars({
  width: '52px',
  gutter: '10px',
  tile: '32px',
  tileRadius: '8px',
  tileText: '11px',
  gap: '8px',
});
/** The height of the row every pane starts with: window controls on the left, tabs and titles. */
export const frame = stylex.defineVars({ header: '40px' });
