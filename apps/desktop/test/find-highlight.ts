import type { Page } from '@playwright/test';

/** Reads the ranges painted into one Find CSS custom highlight. */
export const readFindHighlight = (page: Page, name: 'find-active' | 'find-match' = 'find-active') =>
  page.evaluate(
    (name) =>
      [...(CSS.highlights.get(name) ?? [])].map((item) => {
        const range = document.createRange();
        range.setStart(item.startContainer, item.startOffset);
        range.setEnd(item.endContainer, item.endOffset);
        const start = range.startContainer.parentElement!;
        const box = range.getBoundingClientRect();
        // The topmost element at the range's center is its text's element only when it is in view.
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          text: range.toString(),
          entry: start.closest<HTMLElement>('[data-transcript-entry]')?.dataset.transcriptEntry,
          part: start.closest<HTMLElement>('[data-transcript-part]')?.dataset.transcriptPart,
          before: range.startContainer.textContent!.slice(
            Math.max(0, range.startOffset - 16),
            range.startOffset,
          ),
          visible: !!hit && start.contains(hit),
        };
      }),
    name,
  );
