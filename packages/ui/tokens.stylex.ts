import * as stylex from "@stylexjs/stylex";

// Static values also feed Monaco's theme API, which requires literal colors.
export const colors = stylex.defineConsts({
  canvas: "#131416",
  chrome: "#18191c",
  surface: "#1b1c20",
  elevated: "#24252b",
  hover: "#303139",
  selected: "#343044",
  selectedHover: "#40394f",
  text: "#ededed",
  secondary: "#b9b8c5",
  muted: "#aaa9b6",
  border: "#303138",
  controlBorder: "#484351",
  accent: "#b7aaf5",
  onAccent: "#191622",
  link: "#c7bdff",
  selection: "#48405f",
  warningSurface: "#393222",
  warningBorder: "#77613b",
  warningText: "#ffd49b",
  danger: "#ffb4ab",
  backdrop: "#0008",
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
  mono: "SFMono-Regular, Menlo, Consolas, monospace",
  caption: 11,
  small: 12,
  body: 13,
  message: 15,
  heading: 16,
});

export const radius = stylex.defineConsts({ control: 5, row: 8, panel: 12, composer: 22 });
export const layout = stylex.defineConsts({ conversation: 740, treeRow: 28 });
export const sidebar = stylex.defineVars({ width: "270px" });
