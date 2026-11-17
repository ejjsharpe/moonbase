import { useEffect, useEffectEvent, type RefObject } from 'react';
import { pickerCommand, pickerMode } from '@moonbase/workbench';

/** From the user agent, as Monaco's keymap is; Electron says Macintosh on Apple silicon too. */
export const mac = navigator.userAgent.includes('Macintosh');
/** Back and forward through places, as in VS Code: ⌃- and ⌃⇧- on macOS, Alt+← and Alt+→ elsewhere. */
export const backShortcut = mac ? '⌃-' : 'Alt+←',
  forwardShortcut = mac ? '⌃⇧-' : 'Alt+→';
/** Hides and shows the main sidebar, as in most editors; ⌃⌘S, the macOS sidebar key, works too. */
export const sidebarShortcut = mac ? '⌘B' : 'Ctrl+B';

function readHistoryStep(event: KeyboardEvent): 1 | -1 | undefined {
  if (mac) {
    if (event.code !== 'Minus' || !event.ctrlKey || event.metaKey || event.altKey) return undefined;
    return event.shiftKey ? 1 : -1;
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  if (event.key === 'ArrowLeft') return -1;
  return event.key === 'ArrowRight' ? 1 : undefined;
}
/**
 * The letter a shortcut key types, lowercased: its character, so ⌘B follows the layout (on Dvorak
 * the key that types B, not the one where QWERTY has it). A key that types no Latin letter, on a
 * non-Latin layout or with ⌥ held on macOS, falls back to its physical key.
 */
function shortcutLetter(event: KeyboardEvent) {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : undefined;
}
/** The shell last focused, which takes keys pressed on the page itself when several share it. */
let pageKeysOwner: HTMLElement | null = null;
/** Records the shell focus moved into, as the one that takes keys pressed on the page. */
export const ownPageKeys = (shell: HTMLElement) => {
  pageKeysOwner = shell;
};
/**
 * Whether a shell takes keys pressed on the page itself: the one last focused, else the first one
 * showing, and none while a modal dialog has marked it aria-hidden.
 */
function ownsPageKeys(element: HTMLElement | null) {
  if (!element?.checkVisibility() || element.closest('[aria-hidden="true"]')) return false;
  const owner =
    pageKeysOwner?.isConnected && pageKeysOwner.checkVisibility()
      ? pageKeysOwner
      : [...document.querySelectorAll<HTMLElement>('[data-moonbase-shell]')].find((shell) =>
          shell.checkVisibility(),
        );
  return owner === element;
}
const onPage = (target: EventTarget | null) =>
  target === document.body || target === document.documentElement;

/**
 * The window's keys for one shell (`root`): the sidebar and rail keys wherever focus is, back and
 * forward (keys and the mouse's side buttons) in this shell or on the page it owns, and its other
 * keys (`keyDown`, `keyUp`) when they are pressed on the page itself.
 */
export function useShellKeys({
  root,
  toggleSidebar,
  toggleRail,
  step,
  keyDown,
  keyUp,
}: {
  root: RefObject<HTMLElement | null>;
  toggleSidebar(): void;
  toggleRail(): void;
  step(direction: 1 | -1): void;
  keyDown(event: KeyboardEvent): void;
  keyUp(event: KeyboardEvent): void;
}) {
  // The sidebar and rail keys work wherever focus is, even on the page itself. They are caught
  // before anything else sees them: ⌃⌘S would otherwise reach the editor's Save.
  const windowKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.getModifierState('AltGraph') ||
      (event.target as Element | null)?.closest?.('[role="dialog"], [role="alertdialog"]')
    )
      return;
    const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const letter = shortcutLetter(event);
    let toggle: (() => void) | undefined;
    if (letter === 'b' && command && !event.altKey && !event.shiftKey) toggle = toggleSidebar;
    else if (
      letter === 's' &&
      event.ctrlKey &&
      (mac ? event.metaKey && !event.shiftKey : event.altKey && !event.metaKey)
    )
      // ⌃⌘S also toggles the sidebar; the rail adds ⌥ on macOS and Shift elsewhere.
      toggle = (mac ? event.altKey : event.shiftKey) ? toggleRail : toggleSidebar;
    else {
      // Back and forward belong to the shell the key was pressed in, or that owns the page's.
      const direction = readHistoryStep(event);
      const target = event.target;
      const inShell =
        target instanceof Node &&
        !!root.current?.contains(target) &&
        !root.current.closest('[aria-hidden="true"]');
      if (direction && (inShell || (onPage(target) && ownsPageKeys(root.current))))
        toggle = () => step(direction);
    }
    if (!toggle) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) toggle();
  });
  // The mouse's own back and forward buttons.
  const mouseUp = useEffectEvent((event: MouseEvent) => {
    if (event.button !== 3 && event.button !== 4) return;
    const shell = root.current;
    if (!(event.target instanceof Node) || !shell?.contains(event.target)) return;
    if (shell.closest('[aria-hidden="true"]')) return;
    event.preventDefault();
    step(event.button === 3 ? -1 : 1);
  });
  // Focus falls to the page itself when a focused control unmounts or turns inert; the shell's
  // keys still work there, in one shell: the one last focused, else the first one showing. A modal
  // dialog marks the shell aria-hidden while it is open, and then owns the keys.
  const pageKey = useEffectEvent((event: KeyboardEvent) => {
    if (!onPage(event.target) || !ownsPageKeys(root.current)) return;
    if (event.type === 'keydown') keyDown(event);
    else keyUp(event);
  });
  useEffect(() => {
    const down = (event: KeyboardEvent) => windowKeyDown(event);
    const up = (event: MouseEvent) => mouseUp(event);
    const page = (event: KeyboardEvent) => pageKey(event);
    window.addEventListener('keydown', down, true);
    window.addEventListener('mouseup', up);
    window.addEventListener('keydown', page);
    window.addEventListener('keyup', page);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('keydown', page);
      window.removeEventListener('keyup', page);
    };
  }, []);
}

/** What a window key asks of the shell, when pressed inside it or on the page it owns. */
export type ShellCommand =
  | { kind: 'settings' }
  | { kind: 'new-chat' }
  | { kind: 'picker'; mode: NonNullable<ReturnType<typeof pickerMode>> }
  | { kind: 'dock' };

/**
 * The shell's command for a key, if any: ⌘, opens Settings, ⌘N starts a new chat, the picker keys
 * open the picker and, while a project shows, ⌘J shows or hides its chats.
 */
export function readShellCommand(
  event: Pick<
    KeyboardEvent,
    'metaKey' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'key' | 'code' | 'target'
  >,
  { chat, picker, project }: { chat: boolean; picker: boolean; project: boolean },
): ShellCommand | undefined {
  const target = event.target as HTMLElement;
  const plain = event.metaKey && !event.altKey && !event.shiftKey;
  if (plain && event.key === ',') return { kind: 'settings' };
  if (
    chat &&
    plain &&
    event.key.toLowerCase() === 'n' &&
    !target.closest('[role="dialog"], [role="alertdialog"]')
  )
    return { kind: 'new-chat' };
  // ⌘ on a Mac, where Control+P is "previous line" in text fields; Ctrl elsewhere.
  const mode = pickerMode(event as KeyboardEvent, pickerCommand(event as KeyboardEvent));
  if (
    picker &&
    mode &&
    !target.closest('[role="dialog"]:not([data-picker]), [role="alertdialog"], [role="menu"]')
  )
    return { kind: 'picker', mode };
  if (project && chat && plain && event.key.toLowerCase() === 'j') return { kind: 'dock' };
  return undefined;
}
