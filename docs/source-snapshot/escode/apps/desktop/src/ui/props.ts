import * as stylex from "@stylexjs/stylex";

// Keep existing DOM hooks for navigation and tests; they carry no CSS rules.
export function uiProps(hook: string, ...styles: stylex.StyleXStyles[]) {
  const props = stylex.props(...styles);
  return { ...props, className: `${hook} ${props.className ?? ""}`.trim() };
}
