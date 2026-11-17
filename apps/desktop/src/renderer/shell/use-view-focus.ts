import { useLayoutEffect, useRef } from 'react';

/**
 * Where focus goes as views change: each view's panel and where it was last focused, and a focus
 * asked for (`restoreFocus`) that lands once that view shows.
 */
export function useViewFocus(view: string) {
  const panels = useRef<Record<string, HTMLElement | null>>({}),
    focus = useRef<Record<string, HTMLElement | null>>({}),
    requested = useRef<string | null>(null);
  /**
   * Focuses a view where it was last focused, else its editor or first control, skipping anything
   * in `leaving`: a part about to hide, which would drop focus to the page.
   */
  const focusView = (value: string, leaving?: Element | null) => {
    const panel = panels.current[value === 'chat' ? 'chat' : 'project'];
    const usable = (element: HTMLElement | null | undefined): element is HTMLElement =>
      !!element?.isConnected && !!panel?.contains(element) && !leaving?.contains(element);
    const candidates = [
      focus.current[value],
      ...(panel?.querySelectorAll<HTMLElement>('.monaco-editor textarea[role="textbox"]') ?? []),
      ...(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') ?? []),
    ];
    for (const target of candidates) {
      if (!usable(target)) continue;
      target.focus();
      // An inert or hidden candidate refuses focus; try the next.
      if (document.activeElement === target) return;
    }
  };
  useLayoutEffect(() => {
    const value = requested.current;
    requested.current = null;
    if (value === view) focusView(value);
  });
  return {
    /** Each view's panel, by `chat` or `project`. */
    panels,
    /** Where each view was last focused, by its tab value. */
    focus,
    focusView,
    /** Focuses `value` once it is the view showing. */
    restoreFocus: (value: string) => {
      requested.current = value;
    },
  };
}
