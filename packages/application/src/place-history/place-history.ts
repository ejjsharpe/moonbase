import type { ChatTarget } from '@moonbase/contracts/chat';

/** Where the window was: a chat in Agents (null for a new one), or a project and its file. */
export type Place =
  | { kind: 'chat'; chat: ChatTarget | null }
  | { kind: 'project'; checkoutId: string; path: string | null };

/** The places visited, oldest first, and the one showing. */
export type PlaceHistory = { readonly places: readonly Place[]; readonly index: number };

export const emptyHistory: PlaceHistory = { places: [], index: -1 };
const historyLimit = 50;

export function isSamePlace(a: Place, b: Place) {
  if (a.kind === 'chat')
    return (
      b.kind === 'chat' && (a.chat?.conversationId ?? null) === (b.chat?.conversationId ?? null)
    );
  return b.kind === 'project' && a.checkoutId === b.checkoutId && a.path === b.path;
}

/**
 * Whether a place is only a way in: a new chat, which becomes the chat it starts, or a project with
 * no file showing, which becomes its first file. The next place there takes its slot.
 */
function isWayInto(place: Place, next: Place) {
  if (place.kind === 'chat') return place.chat === null && next.kind === 'chat';
  return place.path === null && next.kind === 'project' && next.checkoutId === place.checkoutId;
}

/** Records a visit; anything forward of the place showing is dropped, as in a browser. */
export function visitPlace(history: PlaceHistory, place: Place): PlaceHistory {
  const current = history.places[history.index];
  if (current && isSamePlace(current, place)) return history;
  const kept = history.places.slice(
    0,
    current && isWayInto(current, place) ? history.index : history.index + 1,
  );
  const places = [...kept, place].slice(-historyLimit);
  return { places, index: places.length - 1 };
}

/**
 * The nearest place back (-1) or forward (1) that can still be shown and isn't the one showing,
 * if any.
 */
export function findStep(
  history: PlaceHistory,
  direction: 1 | -1,
  canShow: (place: Place) => boolean,
): number | undefined {
  const current = history.places[history.index];
  for (
    let index = history.index + direction;
    index >= 0 && index < history.places.length;
    index += direction
  ) {
    const place = history.places[index];
    if (canShow(place) && !(current && isSamePlace(place, current))) return index;
  }
  return undefined;
}

/** Moves to a place back or forward. */
export function stepTo(history: PlaceHistory, index: number): PlaceHistory {
  return { ...history, index };
}

/**
 * Settles a step back or forward once it is done. A place that never showed (a file since deleted,
 * a chat that can't open) leaves the history. The place showing now is then visited, so a place
 * chosen while the step was on its way counts too.
 */
export function settleStep(
  history: PlaceHistory,
  step: { from: number; to: number; reached: boolean },
  showing: Place | null,
): PlaceHistory {
  let settled = history;
  if (!step.reached && history.places[step.to]) {
    const places = history.places.filter((_, index) => index !== step.to);
    const from = step.from > step.to ? step.from - 1 : step.from;
    settled = { places, index: Math.max(0, Math.min(from, places.length - 1)) };
  }
  return showing ? visitPlace(settled, showing) : settled;
}
