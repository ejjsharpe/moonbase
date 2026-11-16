/** A shortcut's keys are written the Mac way (`Shift+Meta+P`); they show per platform. */
export type Shortcut = { label: string; keys: string };

/**
 * Whether this is a Mac, where `Meta` is ⌘; elsewhere it is Ctrl. Read from the user agent, as Monaco's
 * keymap is (Chromium says Macintosh on Apple silicon too).
 */
export const onMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh');
const keyGlyphs: Record<string, string> = onMac
  ? {
      Meta: '⌘',
      Control: '⌃',
      Alt: '⌥',
      Shift: '⇧',
      Backspace: '⌫',
      Enter: '⏎',
      ArrowLeft: '←',
      ArrowRight: '→',
    }
  : {
      Meta: 'Ctrl+',
      Control: 'Ctrl+',
      Alt: 'Alt+',
      Shift: 'Shift+',
      Backspace: 'Backspace',
      Enter: 'Enter',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
    };
/** A command's keys as `aria-keyshortcuts` names them on this platform. */
export const ariaKeys = (keys: string) => (onMac ? keys : keys.replace('Meta', 'Control'));
/** Shows a command's keys the platform's way: ⇧⌥⌘C on a Mac, Shift+Alt+Ctrl+C elsewhere. */
export function formatKeys(keys: string) {
  return keys
    .split('+')
    .map((key) => keyGlyphs[key] ?? key)
    .join('');
}
/**
 * Whether a press is ⌘ (Ctrl off a Mac) and `letter` alone: the typed character, or the physical
 * key on a layout whose character isn't Latin.
 */
export const isCommandKey = (
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  letter: string,
) =>
  (onMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
  !event.altKey &&
  !event.shiftKey &&
  (event.key.toLowerCase() === letter ||
    (!/^[a-z]$/i.test(event.key) && event.code === `Key${letter.toUpperCase()}`));
/** The command keys (see `FileCommand.keys`) a press in the tree matches, or null. */
export function shortcutCommand(event: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState(key: string): boolean;
}) {
  // Off a Mac, Ctrl+Alt is also AltGr, which types characters such as ć.
  if (event.getModifierState('AltGraph')) return null;
  const command = onMac ? event.metaKey : event.ctrlKey;
  if (event.key === 'F2' && !command && !event.altKey && !event.shiftKey) return 'F2';
  if (command && !event.altKey && !event.shiftKey && event.key === 'Backspace')
    return 'Meta+Backspace';
  if (isCommandKey(event, 'c')) return 'Meta+C';
  if (isCommandKey(event, 'x')) return 'Meta+X';
  if (command && event.altKey && event.code === 'KeyC')
    return event.shiftKey ? 'Shift+Alt+Meta+C' : 'Alt+Meta+C';
  if (command && event.altKey && !event.shiftKey && event.code === 'KeyR') return 'Alt+Meta+R';
  return null;
}
