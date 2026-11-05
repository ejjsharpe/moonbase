import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Button } from '@base-ui/react/button';
import { Input } from '@base-ui/react/input';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { colors, space, type } from '@moonbase/ui/tokens.stylex';
import type { ChatController, TranscriptFindState } from '@moonbase/application/chat';

export function activateChatFind(controller: ChatController, element: Element) {
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
  owner
    .querySelector<HTMLInputElement>('input[aria-label="Find in conversation"]')
    ?.focus({ preventScroll: true });
}
export function openChatFind(event: KeyboardEvent, controller: ChatController) {
  if (event.key === 'Escape' && controller.getSnapshot().transcript.find.open) {
    event.preventDefault();
    event.stopPropagation();
    controller.closeFind();
    return;
  }
  if (
    event.defaultPrevented ||
    !(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.key.toLowerCase() !== 'f'
  )
    return;
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, [contenteditable="true"]')) return;
  if (!controller.getSnapshot().selected) return;
  event.preventDefault();
  event.stopPropagation();
  activateChatFind(controller, event.currentTarget);
}
export function FindBar({
  controller,
  state,
}: {
  controller: ChatController;
  state: TranscriptFindState;
}) {
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef(document.activeElement);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  const close = () => {
    controller.closeFind();
    if (previousFocus.current instanceof HTMLElement && previousFocus.current.isConnected)
      previousFocus.current.focus({ preventScroll: true });
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
      aria-label="Find in conversation"
      {...stylex.props(styles.bar)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (event.key === 'Enter') {
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
            {state.error ? 'Retry Find' : 'Refresh Find'}
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
