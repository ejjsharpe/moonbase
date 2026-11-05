import type { TranscriptViewAnchor } from '@moonbase/application/chat';

/**
 * Transcript scroll ownership. `following` keeps the end visible. `restoring` waits for a supplied
 * anchor's window and part before applying it. `navigating` keeps the captured anchor while an
 * explicit window move settles. `revealing` leaves position to Find until a scroll records one, and
 * reader input there captures the actual position. `reading` re-applies the recorded anchor after
 * content or chrome size changes.
 */
export type TranscriptScroll = {
  mode: 'following' | 'restoring' | 'navigating' | 'revealing' | 'reading';
  anchor: TranscriptViewAnchor | null;
  /** Upward reader intent admits automatic earlier loading near the top. */
  upward: boolean;
  retry: 'earlier' | 'later' | 'latest';
  /** Fences a superseded navigation's settlement. */
  revision: number;
  /** The extra oldest row is shown at the 128-row boundary. */
  earlierRow: boolean;
  /** Focus/selection pins of the live row and of the oldest row id. */
  pins: { live: boolean; oldest: string | null };
};

/**
 * Viewport facts sampled with an event: pixels from the start/end, latest window, a noncollapsed
 * selection, whether earlier history exists with nothing loading and no row focused, and whether
 * the newest window holds 128 rows with live output.
 */
export type TranscriptViewport = {
  top: number;
  bottom: number;
  atLatest: boolean;
  selected: boolean;
  earlier: boolean;
  boundary: boolean;
};

type Viewport = TranscriptViewport;
export type TranscriptScrollEvent =
  /** Application view memory or around-entry navigation supplied an anchor. */
  | { type: 'supplied'; anchor: TranscriptViewAnchor }
  /** Find moved its window around a match and owns its reveal. */
  | { type: 'reveal' }
  | { type: 'input'; device: 'wheel' | 'key' | 'pointer'; upward: boolean; viewport: Viewport }
  /** `held`: the recorded anchor (or its fallback) is at its offset, as after programmatic scrolls. */
  | { type: 'scrolled'; held: boolean; viewport: Viewport }
  | { type: 'captured'; position: TranscriptViewAnchor | undefined }
  | { type: 'resized'; viewport: Viewport }
  | { type: 'navigate'; direction: 'earlier' | 'later'; viewport: Viewport }
  | { type: 'navigated'; revision: number; saved: TranscriptViewAnchor | null; viewport: Viewport }
  /** A supplied anchor was applied, at its row/part or nearby. */
  | { type: 'applied' }
  | { type: 'latest' }
  | { type: 'pinned'; live: boolean; oldest: string | null };

export type TranscriptScrollInstruction = {
  scroll?: 'end' | 'anchor';
  /** Measure the first visible entry/part and report it as `captured`. */
  capture?: true;
  /** View memory to write. */
  save?: TranscriptViewAnchor | null;
  cancelReveal?: true;
  navigate?: 'earlier' | 'later' | 'row' | 'latest';
};

const endDistance = 40,
  topDistance = 120;

export function createTranscriptScroll(anchor: TranscriptViewAnchor | null): TranscriptScroll {
  return {
    mode: anchor ? 'restoring' : 'following',
    anchor,
    upward: false,
    retry: 'earlier',
    revision: 0,
    earlierRow: false,
    pins: { live: false, oldest: null },
  };
}

export function transitionTranscriptScroll(
  state: TranscriptScroll,
  event: TranscriptScrollEvent,
): { state: TranscriptScroll; instruction: TranscriptScrollInstruction } {
  const stay = (instruction: TranscriptScrollInstruction = {}) => ({ state, instruction });
  const next = (
    change: Partial<TranscriptScroll>,
    instruction: TranscriptScrollInstruction = {},
  ) => ({ state: { ...state, ...change }, instruction });
  const end = ({ atLatest, selected }: TranscriptViewport) =>
    atLatest && !selected ? stay({ scroll: 'end' }) : stay();
  switch (event.type) {
    case 'supplied':
      if (state.mode === 'navigating' || sameAnchor(state.anchor, event.anchor)) return stay();
      return next({ mode: 'restoring', anchor: event.anchor }, { scroll: 'anchor' });
    case 'reveal':
      return next({ mode: 'revealing', anchor: null, revision: state.revision + 1 });
    case 'input': {
      const keep =
        state.mode === 'navigating' ||
        (state.mode === 'following' && !event.upward && event.device !== 'pointer');
      const result = next(
        { upward: event.upward, mode: keep ? state.mode : 'reading' },
        {
          cancelReveal: true,
          ...((state.mode === 'restoring' || state.mode === 'revealing') && { capture: true }),
        },
      );
      return event.device === 'wheel' && event.upward && state.mode !== 'navigating'
        ? loadEarlier(result, event.viewport)
        : result;
    }
    case 'scrolled': {
      if (event.held || state.mode === 'restoring') return stay();
      if (state.mode === 'navigating') return stay({ capture: true });
      const { viewport } = event;
      if (viewport.atLatest && !viewport.selected && viewport.bottom < endDistance)
        return next({ mode: 'following' }, { capture: true });
      const result = next(
        { mode: state.mode === 'revealing' ? 'revealing' : 'reading' },
        { capture: true },
      );
      return state.upward ? loadEarlier(result, viewport) : result;
    }
    case 'captured': {
      if (state.mode === 'restoring' || !event.position) return stay();
      // Following still tracks the reading anchor that input leaving it will keep.
      return next(
        { anchor: event.position },
        { save: state.mode === 'following' ? null : event.position },
      );
    }
    case 'resized':
      if (state.mode === 'following') return end(event.viewport);
      return state.anchor ? stay({ scroll: 'anchor' }) : stay();
    case 'navigate': {
      const row = event.direction === 'earlier' && event.viewport.boundary && !state.earlierRow;
      return next(
        {
          mode: 'navigating',
          upward: false,
          revision: state.revision + 1,
          retry: row ? state.retry : event.direction,
          earlierRow: state.earlierRow || row,
        },
        { capture: true, navigate: row ? 'row' : event.direction },
      );
    }
    case 'navigated':
      if (event.revision !== state.revision) return stay();
      if (state.mode === 'following') return end(event.viewport);
      return next(
        { mode: 'reading', anchor: event.saved?.partId ? event.saved : state.anchor },
        { scroll: 'anchor', capture: true },
      );
    case 'applied':
      return state.mode === 'restoring' ? next({ mode: 'reading' }) : stay();
    case 'latest':
      return next(
        {
          mode: 'following',
          anchor: null,
          upward: false,
          retry: 'latest',
          revision: state.revision + 1,
          earlierRow: false,
          pins: { live: false, oldest: null },
        },
        { navigate: 'latest' },
      );
    case 'pinned':
      if (state.pins.live === event.live && state.pins.oldest === event.oldest) return stay();
      return next({ pins: { live: event.live, oldest: event.oldest } });
  }
}

/** Automatic earlier loading near a loadable top, after the reader's upward intent. */
function loadEarlier(result: ReturnType<typeof transitionTranscriptScroll>, viewport: Viewport) {
  if (viewport.top >= topDistance || !viewport.earlier || viewport.selected) return result;
  const navigation = transitionTranscriptScroll(result.state, {
    type: 'navigate',
    direction: 'earlier',
    viewport,
  });
  return { ...navigation, instruction: { ...result.instruction, ...navigation.instruction } };
}

const sameAnchor = (a: TranscriptViewAnchor | null, b: TranscriptViewAnchor | null) =>
  JSON.stringify(a) === JSON.stringify(b);
