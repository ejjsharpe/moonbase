import { useLayoutEffect, useRef } from 'react';
import * as stylex from '@stylexjs/stylex';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import { formatKeys } from './files-tree/file-commands.ts';

/** A shortcut's keys are written the Mac way (`Shift+Meta+P`); they show per platform. */
export type Shortcut = { label: string; keys: string };

/** The editor's main shortcuts. */
export const editorShortcuts: readonly Shortcut[] = [
  { label: 'Go to file', keys: 'Meta+P' },
  { label: 'Commands', keys: 'Shift+Meta+P' },
  { label: 'Find in files', keys: 'Shift+Meta+F' },
];

/** Where the editor would be when no file is open: the few keys worth knowing. */
export function CheatSheet({ shortcuts }: { shortcuts: readonly Shortcut[] }) {
  const sheet = useRef<HTMLElement>(null);
  // Centred in the window rather than the pane: as much room below as the app has above it.
  useLayoutEffect(() => {
    const element = sheet.current;
    if (element)
      element.style.paddingBottom = `${24 + Math.max(0, element.getBoundingClientRect().top)}px`;
  });
  return (
    <section ref={sheet} aria-label="Keyboard shortcuts" {...stylex.props(styles.sheet)}>
      <dl {...stylex.props(styles.list)}>
        {shortcuts.map((shortcut) => (
          <div key={shortcut.label} {...stylex.props(styles.row)}>
            <dt {...stylex.props(styles.label)}>{shortcut.label}</dt>
            <dd {...stylex.props(styles.keys)}>
              <kbd {...stylex.props(styles.kbd)}>{formatKeys(shortcut.keys)}</kbd>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const styles = stylex.create({
  sheet: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    backgroundColor: colors.canvas,
  },
  list: { margin: 0, width: 'min(260px, 100%)', display: 'flex', flexDirection: 'column', gap: 4 },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    minHeight: 30,
  },
  label: { fontSize: type.small, color: colors.secondary },
  keys: { margin: 0, flexShrink: 0 },
  kbd: {
    fontFamily: type.mono,
    fontSize: type.caption,
    color: colors.text,
    padding: '2px 7px',
    borderRadius: radius.row,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
});
