/** How `reveal` treats an ignored file while Hide Ignored Files is on, and when it gives up. */
export type RevealOptions = {
  /** 'show' (the default) turns Hide Ignored Files off; 'skip' leaves the file unrevealed. */
  ignored?: 'show' | 'skip';
  /** Checked after each listing and before the tree changes; once false, the reveal stops. */
  current?: () => boolean;
  /** Fails without reporting, for a reveal the user didn't ask for. */
  quiet?: boolean;
};

/** The folders above a path and the path itself, outermost first. */
export const listLevels = (path: string) => {
  const parts = path.split('/');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
};

/** The sidebar's width, kept to the range it can be dragged to. */
export const clampSidebarWidth = (width: number) => Math.max(190, Math.min(380, Math.round(width)));
