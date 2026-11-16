import { onMac } from '../shortcuts.ts';

/** `commands` is Go to with `>` already typed. */
export type PickerMode = 'goto' | 'commands' | 'find';
export type PickerRequest = { mode: PickerMode; text: string };

/** The picker's modifier: ⌘ on a Mac, where ⌃P moves up a line in text, and Ctrl elsewhere. */
export const pickerCommand = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  onMac ? event.metaKey : event.ctrlKey;
/** ⌘P is Go to, ⌘⇧P its commands and ⌘⇧F Find; `command` says which modifier counts. */
export function pickerMode(
  event: { key: string; shiftKey: boolean; altKey: boolean },
  command: boolean,
): PickerMode | undefined {
  if (!command || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'p') return event.shiftKey ? 'commands' : 'goto';
  if (key === 'f' && event.shiftKey) return 'find';
}
