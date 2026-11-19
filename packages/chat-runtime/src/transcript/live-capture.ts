import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { LiveDoc, type EntryId, type Harness, type LiveState } from '@earendil-works/pi-durable';
import type { ChatTarget, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { Effect } from 'effect';
import { ChatStoreError, type ChatError } from '@moonbase/contracts/chat-errors';
import { callHarness } from '../commands/harness-call.ts';
import { runCheck } from '../commands/safe-error.ts';
import { cid } from '../documents.ts';
import { hashJson } from '../hash-json.ts';

export const captureTranscript = (
  harness: Harness,
  target: ChatTarget,
  {
    cache,
    toolSlots = Infinity,
  }: {
    cache?: { boundary?: EntryId | null; retired?: boolean };
    /** Leading tool slots to read; snapshots read only what their embedded first page shows. */
    toolSlots?: number;
  } = {},
) =>
  callHarness(() =>
    harness.commit(async (tx) => {
      if (cache?.retired) throw new ChatStoreError({ problem: 'live-replaced' });
      // LiveDoc already exists for every Harness-created conversation; this read changes no fields.
      const live = JSON.parse(
        JSON.stringify(await tx.doc(LiveDoc, cid(target.conversationId))),
      ) as LiveState;
      const boundary =
        cache?.boundary !== undefined
          ? (cache.boundary ?? undefined)
          : (
              await tx.scanEntries(
                { conversationId: cid(target.conversationId), order: 'descending' },
                1,
              )
            ).items[0]?.id;
      if (cache) cache.boundary = boundary ?? null;
      const task = live.run ? await tx.task(live.run.taskId) : undefined;
      const latest = (
        await tx.scanTasks(
          {
            conversationId: cid(target.conversationId),
            kind: 'pi.generation',
            order: 'descending',
          },
          1,
        )
      ).items[0];
      // Tool slots are read here so one projection never mixes two control revisions.
      const slots = (live.tools ?? []).slice(0, toolSlots);
      const tools = await Promise.all(
        slots.map((tool) => (tool.entry ? tx.entry(tool.entry) : undefined)),
      );
      const toolTasks = await Promise.all(
        slots.map((tool) => (tool.taskId ? tx.task(tool.taskId) : undefined)),
      );
      return { live, boundary, task, latest, tools, toolTasks };
    }, context),
  );
export type TranscriptCapture = Effect.Success<ReturnType<typeof captureTranscript>>;
/** The live source a capture shows, if a submission is running in it. */
export const getLiveSource = (
  target: ChatTarget,
  capture: TranscriptCapture,
): Effect.Effect<ChatTranscriptSource | undefined, ChatError> =>
  Effect.gen(function* () {
    const { live, boundary, task } = capture;
    const submission = live.run?.inputs[0];
    if (
      !live.run ||
      !submission ||
      !task ||
      task.state.status === 'terminal' ||
      task.state.status === 'completing'
    )
      return undefined;
    if (task.conversationId !== (yield* runCheck(() => cid(target.conversationId))))
      return yield* new ChatStoreError({ problem: 'live-task' });
    const attempt = live.generation?.attempt ?? 0;
    const incarnation = hashJson({
      target,
      boundary: String(boundary ?? ''),
      task: String(task.id),
      attempt,
      phase:
        task.state.checkpoint &&
        typeof task.state.checkpoint === 'object' &&
        !Array.isArray(task.state.checkpoint)
          ? task.state.checkpoint.phase
          : null,
      restarts: task.restarts ?? 0,
      tools: live.tools?.map((tool) => [tool.taskId ?? null, tool.entry ?? null, tool.status]),
      nestedTools: live.nestedTools?.map((tool) => [tool.taskId, tool.status]),
    });
    return {
      kind: 'live' as const,
      target,
      submissionId: String(submission),
      taskId: String(task.id),
      attempt,
      incarnation,
    };
  });
