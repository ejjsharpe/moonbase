import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Context } from 'effect';
import { useAtomValue } from '@effect/atom-react';
import { Button } from '@base-ui/react/button';
import { Input } from '@base-ui/react/input';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { colors, space, type } from '@moonbase/ui/tokens.stylex';
import { ChatSelection } from '@moonbase/application/chat';
import type { ChatShared } from './chat-context.ts';

/** The chat Find belongs to (its backend and target, as `data-chat-find-owner` names it). */
export type ChatFindOwner = { owner: string; selected: boolean; open: boolean };

/**
 * Opens Find for the conversation `element` belongs to. A newly opened bar focuses its own field
 * when it mounts; an open one is focused here.
 */
export function activateChatFind(
  chat: ChatShared,
  find: ChatFindOwner,
  element: Element,
  input: RefObject<HTMLInputElement | null>,
) {
  const owner = element.closest<HTMLElement>('[data-chat-find-owner]');
  if (!find.selected || !owner?.isConnected || owner.dataset.chatFindOwner !== find.owner) return;
  if (find.open) input.current?.focus({ preventScroll: true });
  else void chat.act(Context.get(chat.services, ChatSelection).openFind);
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
  chat: ChatShared,
  find: ChatFindOwner,
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
    if (!find.open) return;
    event.preventDefault();
    event.stopPropagation();
    void chat.act(Context.get(chat.services, ChatSelection).closeFind);
    return;
  }
  if (!isFindShortcut(event)) return;
  if (
    target.closest('input, textarea, select') ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
    return;
  if (!find.selected) return;
  event.preventDefault();
  event.stopPropagation();
  activateChatFind(chat, find, event.currentTarget, input);
}
export function FindBar({
  chat,
  input,
}: {
  chat: ChatShared;
  /** Holds the field, so a repeated Find request can focus it. */
  input: RefObject<HTMLInputElement | null>;
}) {
  const state = useAtomValue(chat.atoms.find);
  const selection = Context.get(chat.services, ChatSelection);
  const act = chat.act;
  /** Focus returns here when Find closes, or to the transcript once a jump unmounted its row. */
  const [focusReturn] = useState(() => document.activeElement);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [input]);
  const bar = useRef<HTMLElement>(null);
  const close = () => {
    void act(selection.closeFind);
    const target =
      focusReturn instanceof HTMLElement && focusReturn.isConnected
        ? focusReturn
        : bar.current
            ?.closest('[data-chat-find-owner]')
            ?.querySelector<HTMLElement>('[data-transcript-list]');
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
          void act(event.shiftKey ? selection.previousFindMatch : selection.nextFindMatch);
        }
      }}>
      <div {...stylex.props(controls.row, styles.row)}>
        <Input
          ref={input}
          aria-label="Find in conversation"
          value={state.query}
          placeholder="Find in conversation"
          {...stylex.props(controls.field, styles.input)}
          onValueChange={(query) => void act(selection.findTranscript(query))}
        />
        <Button
          {...stylex.props(controls.button, controls.quietButton)}
          disabled={state.activeIndex === null || state.activeIndex === 0}
          onClick={() => void act(selection.previousFindMatch)}>
          Previous
        </Button>
        <Button
          {...stylex.props(controls.button, controls.quietButton)}
          disabled={state.activeIndex === null || state.activeIndex + 1 >= state.count}
          onClick={() => void act(selection.nextFindMatch)}>
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
            onClick={() => void act(selection.findTranscript(state.query))}>
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
