import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context';
import { LiveDoc, type TaskId } from '@earendil-works/pi-durable';
import { Effect, Fiber, Option } from 'effect';
import type { ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import { InvalidChatRequestError, type ChatError } from '@moonbase/contracts/chat-errors';
import { RequestReusedError } from '@moonbase/contracts/host-errors';
import { callAbortable } from '../abortable-call.ts';
import { Request, cid, key, sid, tid } from '../documents.ts';
import { decodeStoredRequest } from '../stored-records.ts';
import type { Host } from './chat-host.ts';
import { callHarness } from './harness-call.ts';
import { runCheck, safeError, uncertainError } from './safe-error.ts';

/** Records the Stop's request, then stops what it captured, or says why it is past stopping. */
const captureStop = (host: Host, d: ChatInput<'stopChat'>) =>
  Effect.gen(function* () {
    const { stop } = d;
    const binding = JSON.stringify({ operation: 'stopChat', ...d }),
      requestKey = key(stop.target.actorId, d.requestId);
    yield* callHarness(
      () =>
        host.harness.commit(async (tx) => {
          const request = await tx.doc(Request, requestKey, binding);
          decodeStoredRequest(request, stop.target.actorId, d.requestId);
          if (request.binding !== binding) throw new RequestReusedError();
        }, context),
      true,
    );
    const submission = yield* callHarness(
      () => host.harness.submission(sid(stop.submissionId), context),
      true,
    );
    const record = submission
      ? yield* callHarness(() => submission.status(context), true)
      : undefined;
    const conversationId = yield* runCheck(() => cid(stop.target.conversationId), true);
    if (!record || record.conversationId !== conversationId)
      return yield* new InvalidChatRequestError({ problem: 'stop-submission' });
    if (stop.taskId === null) {
      const result = yield* callHarness(
        () => host.harness.abortSubmission(sid(stop.submissionId), context, conversationId),
        true,
      );
      if (result === 'aborted') return 'stopped' as const;
      return result === 'settled' ? ('terminal' as const) : ('superseded' as const);
    }
    const taskId = yield* runCheck(() => tid(stop.taskId!), true);
    const live = yield* callHarness(
      () => host.harness.snapshot(LiveDoc, conversationId, context),
      true,
    );
    const task = yield* callHarness(() => host.harness.getTask(taskId, context), true);
    if (!task || task.conversationId !== conversationId)
      return yield* new InvalidChatRequestError({ problem: 'stop-task' });
    if (task.state.status === 'terminal') return 'terminal' as const;
    if (live?.run?.taskId !== taskId || !live.run.inputs.includes(sid(stop.submissionId)))
      return 'superseded' as const;
    return null;
  });

export function stopChat(
  host: Host,
  d: ChatInput<'stopChat'>,
): Effect.Effect<ChatOutput<'stopChat'>, ChatError> {
  return Effect.gen(function* () {
    yield* host.metadata(d.stop.target, true);
    const captured = yield* captureStop(host, d);
    let outcome: ChatOutput<'stopChat'>['outcome'] = captured ?? 'pending';
    if (captured === null) {
      const taskId = tid(d.stop.taskId!);
      // The deadline owns only this join; the abort request stays with the host through settlement.
      // Pi may have recorded the abort whatever the abort or the wait after it reports, so either
      // failure is uncertain; one still running at the deadline leaves the Stop pending.
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
    return { stop: d.stop, requestId: d.requestId, outcome };
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
