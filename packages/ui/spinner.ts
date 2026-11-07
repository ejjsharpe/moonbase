import * as stylex from '@stylexjs/stylex';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const turn = stylex.keyframes({
  '0%': { content: `"${frames[0]}"` },
  '10%': { content: `"${frames[1]}"` },
  '20%': { content: `"${frames[2]}"` },
  '30%': { content: `"${frames[3]}"` },
  '40%': { content: `"${frames[4]}"` },
  '50%': { content: `"${frames[5]}"` },
  '60%': { content: `"${frames[6]}"` },
  '70%': { content: `"${frames[7]}"` },
  '80%': { content: `"${frames[8]}"` },
  '90%': { content: `"${frames[9]}"` },
});

/**
 * A braille spinner drawn in `::before`, for something running: it overrides any other `content`
 * there and holds one frame when motion is reduced.
 */
export const spinner = stylex.create({
  glyph: {
    '::before': {
      content: `"${frames[2]}"`,
      animationName: { default: turn, '@media (prefers-reduced-motion: reduce)': 'none' },
      animationDuration: '0.8s',
      animationTimingFunction: 'steps(1, end)',
      animationIterationCount: 'infinite',
    },
  },
});
