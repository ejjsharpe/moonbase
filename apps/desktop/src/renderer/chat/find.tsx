import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Button } from '@base-ui/react/button';
import { Input } from '@base-ui/react/input';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { colors, space, type } from '@moonbase/ui/tokens.stylex';
import type { ChatController, TranscriptFindState } from '@moonbase/application/chat';

/** Opens Find for the conversation `element` belongs to, and focuses an already open field. */
export function activateChatFind(
  controller: ChatController,
  element: Element,
  input: RefObject<HTMLInputElement | null>,
) {
  const owner = element.closest<HTMLElement>('[data-chat-find-owner]');
  const selected = controller.getSnapshot().selected;
  const identity = JSON.stringify([controller.backendId, selected]);
  if (!selected || !owner?.isConnected || owner.dataset.chatFindOwner !== identity) return;
  controller.openFind();
  const current = controller.getSnapshot();
  if (
    !current.transcript.find.open ||
    JSON.stringify([controller.backendId, current.selected]) !== identity
  )
    return;
  // A newly opened bar focuses its own field when it mounts.
  input.current?.focus({ preventScroll: true });
}
/** Cmd/Ctrl+F by the layout's letter, or by the physical F key when the layout's isn't Latin. */
function isFindShortcut(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === 'f' : event.code === 'KeyF';
}
/**
 * Chat's own Find keys: Cmd/Ctrl+F opens Find unless a text field has focus, and Escape closes it.
 * Keys something else already handled, keys composing text, and keys from portalled overlays such
 * as the image viewer (React bubbles them through Chat, but they are not in its DOM) are left alone.
 */
export function handleChatFindKeyDown(
  event: KeyboardEvent<HTMLElement>,
  controller: ChatController,
  input: RefObject<HTMLInputElement | null>,
) {
  const target = event.target;
  if (
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    !(target instanceof Element) ||
    !event.currentTarget.contains(target)
  )
    return;
  if (event.key === 'Escape') {
    if (!controller.getSnapshot().transcript.find.open) return;
    event.preventDefault();
    event.stopPropagation();
    controller.closeFind();
    return;
  }
  if (!isFindShortcut(event)) return;
  if (
    target.closest('input, textarea, select') ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
    return;
  if (!controller.getSnapshot().selected) return;
  event.preventDefault();
  event.stopPropagation();
  activateChatFind(controller, event.currentTarget, input);
}
/**
 * Where focus was when Find opened. A jump to a match can replace that element (the transcript list
 * remounts around the match), so it is also described by its row, part and accessible name.
 */
type FocusReturn = {
  element: HTMLElement;
  /** The transcript row and part holding it; null outside them. */
  row: string | null;
  part: string | null;
  /** Inside the transcript list but outside a row (its edges). */
  listed: boolean;
  name: string;
  /** Its position among same-named elements in its row or part. */
  index: number;
};
const getFocusName = (element: Element) =>
  [
    element.tagName,
    element.getAttribute('role'),
    element.getAttribute('aria-label') ?? element.textContent,
  ].join('\n');
function findSameNamed(scope: ParentNode, element: Element, name: string) {
  return [...scope.querySelectorAll<HTMLElement>(element.tagName)].filter(
    (candidate) => getFocusName(candidate) === name,
  );
}
function captureFocusReturn(element: Element | null): FocusReturn | null {
  if (!(element instanceof HTMLElement)) return null;
  const row = element.closest<HTMLElement>('[data-transcript-row]');
  const part = row && element.closest<HTMLElement>('[data-transcript-part]');
  const name = getFocusName(element);
  return {
    element,
    row: row?.dataset.transcriptRow ?? null,
    part: part?.dataset.transcriptPart ?? null,
    listed: !row && !!element.closest('[data-transcript-list]'),
    name,
    index: row ? findSameNamed(part ?? row, element, name).indexOf(element) : 0,
  };
}
/**
 * The element to focus when Find closes: the one focused when it opened, or its replacement in the
 * same row and part. A row that is gone, or an element it no longer has, leaves focus on the
 * transcript rather than on a same-named element in another row.
 */
function findFocusReturn(owner: HTMLElement, origin: FocusReturn): HTMLElement | null {
  const { element, row, part, listed, name, index } = origin;
  if (element.isConnected) return element;
  const list = owner.querySelector<HTMLElement>('[data-transcript-list]');
  if (listed) return list;
  if (row) {
    let scope: HTMLElement | null = owner.querySelector(
      `[data-transcript-row="${CSS.escape(row)}"]`,
    );
    if (scope && part) scope = scope.querySelector(`[data-transcript-part="${CSS.escape(part)}"]`);
    return (scope && findSameNamed(scope, element, name)[index]) || list;
  }
  // Outside the transcript (the composer, the conversation's own controls), by its name.
  const same = findSameNamed(owner, element, name).filter(
    (candidate) => !list?.contains(candidate),
  );
  return same[0] ?? list;
}
export function FindBar({
  controller,
  state,
  input,
}: {
  controller: ChatController;
  state: TranscriptFindState;
  /** Holds the field, so a repeated Find request can focus it. */
  input: RefObject<HTMLInputElement | null>;
}) {
  const [focusReturn] = useState(() => captureFocusReturn(document.activeElement));
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [input]);
  const bar = useRef<HTMLElement>(null);
  const close = () => {
    controller.closeFind();
    const owner = bar.current?.closest<HTMLElement>('[data-chat-find-owner]');
    if (owner && focusReturn) findFocusReturn(owner, focusReturn)?.focus({ preventScroll: true });
  };
  let status = 'Find literal text in this saved conversation.';
  if (state.status === 'searching')
    status = `${state.count.toLocaleString()} matches so far · Searching saved conversation…`;
  if (state.status === 'complete') {
    status = 'No matches in the saved conversation.';
    if (state.count)
      status = `${(state.activeIndex ?? 0) + 1} of ${state.count.toLocaleString()} matches`;
  }
  if (state.error) status = state.error;
  return (
    <section
      ref={bar}
      aria-label="Find in conversation"
      {...stylex.props(styles.bar)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        // Enter on a button presses that button.
        if (event.key === 'Enter' && event.target === input.current) {
          event.preventDefault();
          event.stopPropagation();
          void (event.shiftKey ? controller.previousFindMatch() : controller.nextFindMatch());
        }
      }}>
      <div {...stylex.props(controls.row, styles.row)}>
        <Input
          ref={input}
          aria-label="Find in conversation"
          value={state.query}
          placeholder="Find in conversation"
          {...stylex.props(controls.field, styles.input)}
          onValueChange={(query) => void controller.findTranscript(query)}
        />
        <Button
          {...stylex.props(controls.button, controls.quietButton)}
          disabled={state.activeIndex === null || state.activeIndex === 0}
          onClick={() => void controller.previousFindMatch()}>
          Previous
        </Button>
        <Button
          {...stylex.props(controls.button, controls.quietButton)}
          disabled={state.activeIndex === null || state.activeIndex + 1 >= state.count}
          onClick={() => void controller.nextFindMatch()}>
          Next
        </Button>
        <Button {...stylex.props(controls.button, controls.quietButton)} onClick={close}>
          Close Find
        </Button>
      </div>
      <div {...stylex.props(controls.row, styles.row)}>
        <p role={state.error ? 'alert' : 'status'} {...stylex.props(styles.status)}>
          {status}
        </p>
        {(state.refreshAvailable || state.error) && state.query && (
          <Button
            {...stylex.props(controls.button)}
            onClick={() => void controller.findTranscript(state.query)}>
            {state.error ? 'Retry Find' : 'Refresh results'}
          </Button>
        )}
      </div>
    </section>
  );
}
const styles = stylex.create({
  bar: { padding: space.sm, backgroundColor: colors.surface, color: colors.text },
  row: { flexWrap: 'wrap' },
  input: { flex: 1, minWidth: 120 },
  status: { fontSize: type.small, color: colors.secondary, margin: 0, overflowWrap: 'anywhere' },
});
