import * as stylex from '@stylexjs/stylex';
import { overlays } from '@moonbase/ui/overlays';
import { workbench } from '@moonbase/ui/workbench';
import type { FocusOrigin } from '../focus-return.ts';

/** The Ctrl+Tab switcher's open tabs, most recent first, the one it is on, and where it began. */
export type RecentTabs = { paths: string[]; index: number; origin: FocusOrigin };

/**
 * Moves the Ctrl+Tab switcher one tab on, or `back`, opening it on the open tabs from the active
 * one through the most recently used. Null when no tab is open.
 */
export function cycleRecentTabs(
  recent: RecentTabs | null,
  {
    active,
    recentFiles,
    openFiles,
    back,
    origin,
  }: {
    active: string;
    /** The checkout's recently used files, most recent first. */
    recentFiles: readonly string[];
    openFiles: readonly string[];
    back: boolean;
    origin: FocusOrigin;
  },
): RecentTabs | null {
  const paths =
    recent?.paths ??
    [...new Set([active, ...recentFiles, ...openFiles])].filter((path) => openFiles.includes(path));
  if (!paths.length) return null;
  return {
    paths,
    index: ((recent?.index ?? 0) + (back ? paths.length - 1 : 1)) % paths.length,
    origin: recent?.origin ?? origin,
  };
}

/** The Ctrl+Tab switcher's list, open while Control is held. */
export function RecentTabsList({ recent }: { recent: RecentTabs }) {
  return (
    <div role="listbox" aria-label="Recent tabs" {...stylex.props(overlays.recent)}>
      {recent.paths.map((path, index) => (
        <div
          key={path}
          role="option"
          aria-selected={recent.index === index}
          {...stylex.props(
            overlays.recentOption,
            recent.index === index && workbench.fileSelected,
          )}>
          {path}
        </div>
      ))}
    </div>
  );
}
