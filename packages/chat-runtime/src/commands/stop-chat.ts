import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context';
import {
  LiveDoc,
  type ConversationId,
  type SubmissionId,
  type TaskId,
} from '@earendil-works/pi-durable';
import { Effect, Fiber, Option } from 'effect';
import type { ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import { InvalidChatRequestError, type ChatError } from '@moonbase/contracts/chat-errors';
import { RequestReusedError } from '@moonbase/contracts/host-errors';
import { callAbortable } from '../abortable-call.ts';
import { Request, cid, key, sid, tid } from '../documents.ts';
import { decodeStoredRequest } from '../stored-records.ts';
import type { Host } from './chat-host.ts';
import { callHarness } from './harness-call.ts';
import { Refusal, commitChange, mayHaveCommitted } from './commit-boundary.ts';
import { runCheck, safeError, uncertainError } from './safe-error.ts';

/** The Pi IDs a Stop names, checked before anything commits. */
type StopIds = {
  conversationId: ConversationId;
  submissionId: SubmissionId;
  taskId: TaskId | null;
};

/** A Stop's refusal of a target it cannot stop. */
type StopRefusal = 'stop-submission' | 'stop-task';
const refusal = (problem: StopRefusal) =>
  Effect.fail(new Refusal(new InvalidChatRequestError({ problem })));

/**
 * Stops what the Stop's request captured, or says why it is past stopping. A target another chat
 * owns is refused outright, since Pi never moves it; a missing one may be allocated later, so
 * `refuseMissing` records that refusal for every replay.
 */
const captureStop = (
  host: Host,
  ids: StopIds,
  refuseMissing: (problem: StopRefusal) => Effect.Effect<never, ChatError | Refusal>,
) =>
  Effect.gen(function* () {
    const { conversationId, submissionId, taskId } = ids;
    const submission = yield* callHarness(() => host.harness.submission(submissionId, context));
    const record = submission ? yield* callHarness(() => submission.status(context)) : undefined;
    if (!record) return yield* refuseMissing('stop-submission');
    if (record.conversationId !== conversationId) return yield* refusal('stop-submission');
    if (taskId === null) {
      // Pi may have withdrawn the submission whatever it reports, so every failure is uncertain.
      const result = yield* callAbortable(() =>
        host.harness.abortSubmission(submissionId, context, conversationId),
      ).pipe(Effect.mapError(uncertainError));
      if (result === 'aborted') return 'stopped' as const;
      return result === 'settled' ? ('terminal' as const) : ('superseded' as const);
    }
    const live = yield* callHarness(() => host.harness.snapshot(LiveDoc, conversationId, context));
    const task = yield* callHarness(() => host.harness.getTask(taskId, context));
    if (!task) return yield* refuseMissing('stop-task');
    if (task.conversationId !== conversationId) return yield* refusal('stop-task');
    if (task.state.status === 'terminal') return 'terminal' as const;
    if (live?.run?.taskId !== taskId || !live.run.inputs.includes(submissionId))
      return 'superseded' as const;
    return null;
  });

/**
 * Records the Stop's request, then stops what it names. From that commit on, only a conflicting
 * binding, a target another chat owns and a refusal the request recorded stay definite; any other
 * failure is uncertain. A replay of a recorded refusal returns it without looking again.
 */
export function stopChat(
  host: Host,
  d: ChatInput<'stopChat'>,
): Effect.Effect<ChatOutput<'stopChat'>, ChatError> {
  return Effect.gen(function* () {
    const { stop } = d;
    yield* host.metadata(stop.target);
    const ids = yield* runCheck((): StopIds => ({
      conversationId: cid(stop.target.conversationId),
      submissionId: sid(stop.submissionId),
      taskId: stop.taskId === null ? null : tid(stop.taskId),
    }));
    const binding = JSON.stringify({ operation: 'stopChat', ...d }),
      requestKey = key(stop.target.actorId, d.requestId);
    return yield* mayHaveCommitted(
      Effect.gen(function* () {
        /** Binds the request, recording `refused` if it has no refusal yet; returns the recorded one. */
        const bind = (refused: StopRefusal | null) =>
          commitChange(host.harness, async (tx) => {
            const request = await tx.doc(Request, requestKey, binding);
            decodeStoredRequest(request, stop.target.actorId, d.requestId);
            if (request.binding !== binding) throw new Refusal(new RequestReusedError());
            request.refused ??= refused;
            return request.refused;
          });
        const recorded = yield* bind(null);
        if (recorded) return yield* refusal(recorded);
        const captured = yield* captureStop(host, ids, (problem) =>
          Effect.flatMap(bind(problem), (refused) => refusal(refused ?? problem)),
        );
        let outcome: ChatOutput<'stopChat'>['outcome'] = captured ?? 'pending';
        if (captured === null) {
          const taskId = ids.taskId!;
          // The deadline owns only this join; the abort request stays with the host through
          // settlement. Pi may have recorded the abort whatever the abort or the wait after it
          // reports, so either failure is uncertain; one still running at the deadline leaves the
          // Stop pending.
          const joined = yield* Effect.interruptible(
            Effect.gen(function* () {
              const abort = yield* host.aborts.run(
                callHarness(() => host.harness.abortTask(taskId, context)),
              );
              yield* Fiber.join(abort);
              const waiter = yield* host.waiters.run(waitForTerminal(host, taskId));
              return yield* Fiber.join(waiter).pipe(Effect.ensuring(Fiber.interrupt(waiter)));
            }).pipe(Effect.mapError(uncertainError), Effect.timeoutOption('1 second')),
          );
          outcome = Option.isSome(joined) ? 'stopped' : 'pending';
        }
        return { stop, requestId: d.requestId, outcome };
      }),
    );
  });
}
/**
 * Waits for a task to end. Interrupting the wait cancels it and waits for Pi to let go; a failure
 * Pi reports then is a defect of the cleanup, so root disposal still sees it.
 */
export const waitForTerminal = (host: Host, taskId: TaskId): Effect.Effect<void, ChatError> =>
  callAbortable(
    (signal) => host.harness.waitForTask(taskId, withAbortSignal(signal, context)),
    (error) => Effect.die(safeError(error)),
  ).pipe(
    Effect.asVoid,
    Effect.mapError((error) => safeError(error)),
  );
