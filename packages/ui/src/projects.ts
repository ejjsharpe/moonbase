import * as stylex from '@stylexjs/stylex';
import { colors, projectHues, type } from './tokens.stylex';

/** Two lowercase letters for a project tile: a hyphenated name's initials, else its start. */
export function projectInitials(name: string) {
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toLowerCase();
}

/** A checkout's folder name, which names its tile. */
export const checkoutName = (checkout: { root: string }) =>
  checkout.root.split('/').at(-1) || checkout.root;

/**
 * Project tiles: sized by the consumer, with initials drawn from `data-initials` so the
 * surrounding control's accessible name stays its own.
 */
export const projectTiles = stylex.create({
  tile: {
    position: 'relative',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: type.mono,
    fontWeight: 700,
    color: colors.onAccent,
    '::before': { content: 'attr(data-initials)' },
  },
  silver: { backgroundColor: projectHues.silver },
  periwinkle: { backgroundColor: projectHues.periwinkle },
  green: { backgroundColor: projectHues.green },
  pink: { backgroundColor: projectHues.pink },
  lavender: { backgroundColor: projectHues.lavender },
  sand: { backgroundColor: projectHues.sand },
});

const hues = [
  projectTiles.silver,
  projectTiles.periwinkle,
  projectTiles.green,
  projectTiles.pink,
  projectTiles.lavender,
  projectTiles.sand,
];

/** Every checkout of one repository, worktrees included, shares a projectId and so a hue. */
export function projectHue(projectId: string) {
  let hash = 0;
  for (const character of projectId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hues[hash % hues.length];
}
