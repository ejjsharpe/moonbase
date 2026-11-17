import { BACKGROUND_CONTEXT as context, withCancel } from '@earendil-works/chord/context';
import { LiveDoc, type TaskId } from '@earendil-works/pi-durable';
import { Effect, Exit, Fiber, Option } from 'effect';
import type { ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import { InvalidChatRequestError, type ChatError } from '@moonbase/contracts/chat-errors';
import { RequestReusedError } from '@moonbase/contracts/host-errors';
import { Request, cid, key, sid, tid } from '../documents.ts';
import { decodeStoredRequest } from '../stored-records.ts';
import type { Host } from './chat-host.ts';
import { callHarness } from './harness-call.ts';
import { safeError } from './safe-error.ts';

export function stopChat(
  host: Host,
  d: ChatInput<'stopChat'>,
): Effect.Effect<ChatOutput<'stopChat'>, ChatError> {
  return Effect.gen(function* () {
    yield* host.metadata(d.stop.target, true);
    const captured = yield* callHarness(async () => {
      const binding = JSON.stringify({ operation: 'stopChat', ...d }),
        requestKey = key(d.stop.target.actorId, d.requestId);
      await host.harness.commit(async (tx) => {
        const request = await tx.doc(Request, requestKey, binding);
        decodeStoredRequest(request, d.stop.target.actorId, d.requestId);
        if (request.binding !== binding) throw new RequestReusedError();
      }, context);
      const submission = await host.harness.submission(sid(d.stop.submissionId), context),
        record = await submission?.status(context);
      if (!record || record.conversationId !== cid(d.stop.target.conversationId))
        throw new InvalidChatRequestError({ problem: 'stop-submission' });
      if (d.stop.taskId === null) {
        const result = await host.harness.abortSubmission(
          sid(d.stop.submissionId),
          context,
          cid(d.stop.target.conversationId),
        );
        if (result === 'aborted') return 'stopped';
        return result === 'settled' ? 'terminal' : 'superseded';
      }
      const live = await host.harness.snapshot(LiveDoc, cid(d.stop.target.conversationId), context),
        task = await host.harness.getTask(tid(d.stop.taskId), context);
      if (!task || task.conversationId !== cid(d.stop.target.conversationId))
        throw new InvalidChatRequestError({ problem: 'stop-task' });
      if (task!.state.status === 'terminal') return 'terminal';
      if (
        live?.run?.taskId !== tid(d.stop.taskId) ||
        !live.run.inputs.includes(sid(d.stop.submissionId))
      )
        return 'superseded';
      return null;
    }, true);
    let outcome: ChatOutput<'stopChat'>['outcome'] = captured ?? 'pending';
    if (captured === null) {
      // The deadline owns only this join; the abort request stays with the host through settlement.
      const joined = yield* Effect.interruptible(
        Effect.gen(function* () {
          const abort = yield* host.aborts.run(
            callHarness(() => host.harness.abortTask(tid(d.stop.taskId!), context)),
          );
          yield* Fiber.join(abort);
          const waiter = yield* host.waiters.run(waitForTerminal(host, tid(d.stop.taskId!)));
          return yield* Fiber.join(waiter).pipe(Effect.ensuring(Fiber.interrupt(waiter)));
        }).pipe(Effect.timeoutOption('1 second')),
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
export function waitForTerminal(host: Host, taskId: TaskId) {
  return Effect.callback<void, ChatError>((resume) => {
    const waiter = withCancel(context);
    const cancellation = new DOMException('Chat terminal wait closed.', 'AbortError');
    const settled = host.harness.waitForTask(taskId, waiter.context).then(
      () => Exit.void,
      (error: unknown) => (error === cancellation ? Exit.void : Exit.fail(safeError(error))),
    );
    void settled.then(resume);
    return Effect.sync(() => waiter.cancel(cancellation)).pipe(
      Effect.andThen(Effect.promise(() => settled)),
      Effect.flatMap((exit) => Effect.orDie(exit)),
    );
  });
}
