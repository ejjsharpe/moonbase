import type { ApplicationError } from '@moonbase/contracts/errors';
import type { WindowAction } from '../ipc/window-rpcs.ts';

/** What the window's document answers a `quit` or `dispose` request with. */
export type QuitAnswer = { id: string; consent: boolean; cleanupError?: ApplicationError };
export type CleanupReport = Extract<WindowAction, { action: 'cleanup-error' }>;

/**
 * Where the window is in its Quit handshake: open (with Quit asked for, waiting for a document to
 * answer it, or not), waiting for its document's answer to `quit` or `dispose`, or closing.
 */
export type WindowPhase =
  | { _tag: 'Open'; quitRequested: boolean }
  | { _tag: 'Quitting'; id: string; stage: 'preserve' | 'dispose' }
  | { _tag: 'Closing' };
export type WindowState = {
  phase: WindowPhase;
  /** Whether the current document watches for actions, so it hears what main sends. */
  ready: boolean;
  /**
   * The latest cleanup failures, as sent: each watch hears of them all again, since one that ended
   * may have missed them, and the document takes each id once.
   */
  reports: readonly CleanupReport[];
  /** Cleanup failures Quit reports, and exits with code 1 for. */
  failures: readonly ApplicationError[];
};
/** What a transition asks of the window, besides its next state. */
export type WindowEffects = {
  send?: readonly WindowAction[];
  show?: boolean;
  /** Quit now: release everything and exit. */
  finish?: boolean;
  log?: string;
};
type Transition = readonly [WindowEffects, WindowState];

const maximumReports = 64;
const maximumFailures = 8;
export const initialWindowState: WindowState = {
  phase: { _tag: 'Open', quitRequested: false },
  ready: false,
  reports: [],
  failures: [],
};
const keepFailure = (failures: readonly ApplicationError[], error: ApplicationError) =>
  failures.length < maximumFailures ? [...failures, error] : failures;
const quitAction = (phase: Extract<WindowPhase, { _tag: 'Quitting' }>): WindowAction => ({
  action: phase.stage === 'preserve' ? 'quit' : 'dispose',
  id: phase.id,
});

/** Quit asked for: the ready document is asked to prepare it, or the next one once it is ready. */
export function requestQuit(state: WindowState, id: string): Transition {
  const { phase } = state;
  if (phase._tag === 'Closing') return [{}, state];
  if (phase._tag === 'Quitting') return [{ show: true }, state];
  if (!state.ready)
    return [{ show: true }, { ...state, phase: { _tag: 'Open', quitRequested: true } }];
  const quitting = { _tag: 'Quitting', id, stage: 'preserve' } as const;
  return [
    { show: true, send: [quitAction(quitting)] },
    { ...state, phase: quitting },
  ];
}
/**
 * The document watches for actions: it is ready for Quit and to hear of cleanup failures. A watch
 * that replaced one whose connection ended may have missed the pending request, so it is asked
 * again; the document takes each request once.
 */
export function markReady(state: WindowState, id: string): Transition {
  const { phase } = state;
  if (phase._tag === 'Closing') return [{}, state];
  const ready = { ...state, ready: true };
  if (phase._tag === 'Quitting') return [{ send: [...state.reports, quitAction(phase)] }, ready];
  if (!phase.quitRequested) return [{ send: state.reports }, ready];
  const [effects, next] = requestQuit(ready, id);
  return [{ ...effects, send: [...state.reports, ...(effects.send ?? [])] }, next];
}

/** The document's answer to the request `answer.id` names; an answer to anything else is ignored. */
export function answerQuit(state: WindowState, answer: QuitAnswer, id: string): Transition {
  const { phase } = state;
  if (phase._tag !== 'Quitting' || answer.id !== phase.id) return [{}, state];
  let failures = state.failures;
  if (answer.cleanupError !== undefined) {
    // Quit stays asked for, so the next ready document is asked again.
    if (phase.stage !== 'dispose')
      return [
        { show: true, log: 'Quit failed: a cleanup failure answers only disposal.' },
        { ...state, phase: { _tag: 'Open', quitRequested: true } },
      ];
    failures = keepFailure(failures, answer.cleanupError);
  }
  if (!answer.consent)
    return phase.stage === 'dispose'
      ? [{ log: 'Invalid disposal answer: disposal cannot return to the live workbench.' }, state]
      : [{ show: true }, { ...state, phase: { _tag: 'Open', quitRequested: false } }];
  // Local agents keep running in the daemon, so Quit asks nothing more of them.
  if (phase.stage === 'preserve') {
    const disposing = { _tag: 'Quitting', id, stage: 'dispose' } as const;
    return [{ send: [quitAction(disposing)] }, { ...state, phase: disposing }];
  }
  return [{ finish: true }, { ...state, failures, phase: { _tag: 'Closing' }, ready: false }];
}

/**
 * Another document replaced the window's: it must prepare its own application before it answers
 * Quit, so a Quit under way is asked of it afresh once it is ready.
 */
export function replaceDocument(state: WindowState): Transition {
  const { phase } = state;
  if (phase._tag === 'Closing') return [{}, state];
  return [
    {},
    {
      ...state,
      ready: false,
      phase: { _tag: 'Open', quitRequested: phase._tag === 'Quitting' || phase.quitRequested },
    },
  ];
}

/** The renderer crashed: whatever Quit was under way is over, and the user is asked what next. */
export function crashDocument(state: WindowState): Transition {
  if (state.phase._tag === 'Closing') return [{}, state];
  return [{}, { ...state, ready: false, phase: { _tag: 'Open', quitRequested: false } }];
}

/** Quit without asking the document, as after a crash. */
export function finishQuit(state: WindowState): Transition {
  if (state.phase._tag === 'Closing') return [{}, state];
  return [{ finish: true }, { ...state, ready: false, phase: { _tag: 'Closing' } }];
}

/** A cleanup failure no request is left to answer with: reported to the document, and by Quit. */
export function reportCleanup(state: WindowState, report: CleanupReport): Transition {
  const reports = [...state.reports, report].slice(-maximumReports);
  const failures = keepFailure(state.failures, report.error);
  return [{ send: state.ready ? [report] : [] }, { ...state, reports, failures }];
}

export const isQuitting = (state: WindowState) => state.phase._tag !== 'Open';
