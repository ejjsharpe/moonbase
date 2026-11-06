import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
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
  const previousFocus = useRef(document.activeElement);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [input]);
  const bar = useRef<HTMLElement>(null);
  const close = () => {
    controller.closeFind();
    const previous = previousFocus.current;
    if (!(previous instanceof HTMLElement)) return;
    // A jump to a match can replace the element (the transcript list remounts around it): focus
    // the element now carrying its label.
    let target: HTMLElement | null | undefined = previous;
    const label = previous.getAttribute('aria-label');
    if (!previous.isConnected)
      target = label
        ? bar.current
            ?.closest('[data-chat-find-owner]')
            ?.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`)
        : null;
    target?.focus({ preventScroll: true });
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
