import { Duration, Effect, Schedule, Stream } from 'effect';
import { isUnavailable } from '@moonbase/contracts/error-groups';
import type { WindowAction } from '../../ipc/window-rpcs.ts';
import type { WindowFailure } from '../../ipc/ipc-errors.ts';
import type { DesktopIpc } from './desktop-ipc.ts';
import { callEffect, watchStream, type Refusal } from './ipc-failures.ts';

/** Each re-watch of the window's actions waits longer, up to a few seconds. */
const windowActionsRetry = Schedule.exponential('50 millis').pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(5))),
  ),
);
const refused: Refusal = 'desktop-request';

type QuitAnswer = { consent: boolean; cleanupError?: WindowFailure };

/**
 * The window's own procedures for one document: main's requests of it, and its answers to Quit
 * and disposal. The renderer's root runs them.
 */
export function makeWindowActions() {
  /** Each Quit or disposal request this document took, with its answer once it has one. */
  const quitAnswers = new Map<string, QuitAnswer | undefined>();
  /** The cleanup failures this document heard of: main tells each watch of them all. */
  const heardFailures = new Set<string>();
  /** Sends an answer, again while main can't be reached: the document may already be gone. */
  const sendQuitAnswer = (id: string, answer: QuitAnswer) =>
    callEffect('answerQuit', { id, ...answer }, refused).pipe(
      Effect.retry({ schedule: windowActionsRetry, times: 8, while: isUnavailable }),
    );
  return {
    /**
     * Main's requests of this document, each taken once, until interrupted. Watching says the
     * document is ready, so a watch its connection ends watches again, and main asks again what
     * is pending: a request already answered gets its answer again, which may have been lost.
     */
    watch: (receive: (action: WindowAction) => void) => {
      const take = (action: WindowAction): Effect.Effect<void, never, DesktopIpc> => {
        if (action.action === 'cleanup-error') {
          if (heardFailures.has(action.id)) return Effect.void;
          heardFailures.add(action.id);
          return Effect.sync(() => receive(action));
        }
        if (!quitAnswers.has(action.id)) {
          quitAnswers.set(action.id, undefined);
          return Effect.sync(() => receive(action));
        }
        const answer = quitAnswers.get(action.id);
        return answer
          ? Effect.asVoid(Effect.forkDetach(Effect.ignore(sendQuitAnswer(action.id, answer))))
          : Effect.void;
      };
      return watchStream('watchWindowActions', undefined, refused).pipe(
        Stream.retry(windowActionsRetry),
        Stream.runForEach(take),
        Effect.ignore,
      );
    },
    /** Answers a `quit` or `dispose` request; main ignores an answer to any other. */
    answerQuit: (id: string, consent: boolean, cleanupError?: WindowFailure) => {
      const answer = { consent, ...(cleanupError ? { cleanupError } : {}) };
      quitAnswers.set(id, answer);
      return sendQuitAnswer(id, answer);
    },
  };
}
export type WindowActions = ReturnType<typeof makeWindowActions>;
