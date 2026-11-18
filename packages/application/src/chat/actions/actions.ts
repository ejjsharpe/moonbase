/** What the chat is doing and last told you. */
export type ActionsState = {
  /** How many of each named action are running. */
  counts: Readonly<Record<string, number>>;
  error: string | null;
  notice: string;
  /** Composition fences admissions while it prepares Quit or a switch. */
  admissionsOpen: boolean;
  /** The chat is closing: it admits nothing and reports nothing. */
  closing: boolean;
};

/** The named actions running, in the order they started; none while the chat closes. */
export const listActive = (state: ActionsState) => (state.closing ? [] : Object.keys(state.counts));

/** `counts` with one more (or one fewer) `name` running. */
export function countAction(
  counts: Readonly<Record<string, number>>,
  name: string,
  change: 1 | -1,
): Readonly<Record<string, number>> {
  const count = (counts[name] ?? 0) + change;
  const { [name]: _, ...rest } = counts;
  return count > 0 ? { ...counts, [name]: count } : rest;
}

/** The notice a chat shows before its host is verified. */
export const initialNotice = (remote: boolean) =>
  remote
    ? 'Disconnected. Connect explicitly; reconnect never resends a message.'
    : 'Local chat. Tools run on this computer; a working folder is not a filesystem sandbox.';

/** The notice once refresh has verified the host. */
export const verifiedNotice = (remote: boolean) =>
  remote
    ? 'Verified host. Reconnection reads saved state; it does not send.'
    : 'Local tools use this computer’s permissions. The selected folder is context, not a sandbox.';
