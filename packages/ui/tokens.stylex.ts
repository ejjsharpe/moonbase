import * as stylex from '@stylexjs/stylex';

// Static values also feed Monaco's theme API, which requires literal colors.
export const colors = stylex.defineConsts({
  canvas: '#141415',
  chrome: '#161618',
  surface: '#161618',
  elevated: '#222224',
  hover: '#2b2b2e',
  selected: '#28282b',
  selectedHover: '#303034',
  text: '#e5e5e7',
  secondary: '#b2b2b8',
  muted: '#97979f',
  border: '#29292d',
  controlBorder: '#343438',
  scrollShadow: '#00000026',
  accent: '#ededf0',
  onAccent: '#19191b',
  link: '#ffffff',
  selection: '#3a3a42',
  warningSurface: '#393222',
  warningBorder: '#77613b',
  warningText: '#ffd49b',
  danger: '#ffb4ab',
  backdrop: '#0008',
});

// Read-only code highlighting on `colors.surface`; matches the editor's inherited vs-dark tokens.
export const syntax = stylex.defineConsts({
  comment: '#6a9955',
  keyword: '#569cd6',
  string: '#ce9178',
  number: '#b5cea8',
  type: '#4ec9b0',
  function: '#dcdcaa',
  variable: '#9cdcfe',
  constant: '#4fc1ff',
  operator: '#d4d4d4',
  regexp: '#d16969',
});

export const space = stylex.defineConsts({
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
});

export const type = stylex.defineConsts({
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: 'SFMono-Regular, Menlo, Consolas, monospace',
  caption: 11,
  small: 12,
  body: 13,
  message: 15,
  heading: 16,
});

export const radius = stylex.defineConsts({ control: 6, row: 7, panel: 12, composer: 18 });
export const layout = stylex.defineConsts({ conversation: 640, treeRow: 28 });
export const sidebar = stylex.defineVars({ width: '270px' });
