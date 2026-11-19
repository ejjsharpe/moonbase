import type {
  NestedToolSlot,
  ToolSlot,
  ToolTaskCheckpoint,
  ToolTaskInput,
} from '@earendil-works/pi-durable';
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { Effect, Stream } from 'effect';
import {
  ChatStoreError,
  TranscriptChangedError,
  type ChatError,
} from '@moonbase/contracts/chat-errors';
import { runCheck } from '../commands/safe-error.ts';
import { cid } from '../documents.ts';
import { hashJson } from '../hash-json.ts';
import { previewText } from '../text.ts';
import { getEntryTranscript, type EntryReader } from './entry-transcript.ts';
import { captureTranscript, getLiveSource, type TranscriptCapture } from './live-capture.ts';
import { buildMessageParts } from './message-values.ts';
import { getNestedOutput, readNestedCall } from './nested-calls.ts';
import { getTaskPairing } from './tool-pairing.ts';
import {
  getLabel,
  makePart,
  partsPerTurn,
  summarizeThinking,
  type Part,
  type TranscriptParts,
} from './transcript-part.ts';

/** Progress a running model-issued or nested call publishes before its result is retained. */
function makeRunningToolParts(
  prefix: string,
  tool: Pick<ToolSlot, 'output' | 'diagnostics' | 'details' | 'droppedBytes' | 'droppedLines'>,
  common: Partial<ChatTranscriptPart>,
): Part[] {
  const evidence = JSON.stringify([tool.droppedBytes ?? 0, tool.droppedLines ?? 0]);
  const parts = [
    makePart(prefix + 'output', 'result', 'tool', tool.output ?? '', common, evidence),
  ];
  if (tool.diagnostics?.length)
    parts.push(
      makePart(prefix + 'diagnostics', 'details', 'tool', JSON.stringify(tool.diagnostics), common),
    );
  if (tool.details !== undefined)
    parts.push(
      makePart(prefix + 'details', 'details', 'tool', JSON.stringify(tool.details), common),
    );
  return parts;
}
export const getLiveTranscript = (
  reader: EntryReader,
  source: ChatTranscriptSource,
  captured?: TranscriptCapture,
): Effect.Effect<TranscriptParts, ChatError> =>
  Effect.gen(function* () {
    const capture = captured ?? (yield* captureTranscript(reader.harness, source.target));
    const actual = yield* getLiveSource(source.target, capture);
    if (!actual || hashJson(actual) !== hashJson(source))
      return yield* new TranscriptChangedError({ change: 'view' });
    const message = capture.live.generation?.message as Message | undefined;
    const generation: Part[] = [];
    for (const part of buildMessageParts(message ? [message] : [], 'generation.')) {
      part.extra = { ...part.extra, state: part.kind === 'arguments' ? 'requested' : 'running' };
      generation.push(part);
      if (generation.length % partsPerTurn === 0) yield* Effect.yieldNow;
    }
    // Only generation parts can hold thinking; tool and nested parts are built lazily.
    return {
      parts: Stream.concat(Stream.fromIterable(generation), listLiveParts(reader, source, capture)),
      thinking: summarizeThinking(generation),
    };
  });
/** Each slot's parts, built only when a reader reaches that slot. */
const listSlotParts = <T>(
  slots: readonly T[],
  build: (slot: T, index: number) => Effect.Effect<Part[], ChatError>,
): Stream.Stream<Part, ChatError> =>
  Stream.fromIterable(slots.entries()).pipe(
    Stream.flatMap(([index, slot]) =>
      Stream.unwrap(Effect.map(build(slot, index), Stream.fromIterable)),
    ),
  );
function listLiveParts(
  reader: EntryReader,
  source: ChatTranscriptSource,
  capture: TranscriptCapture,
): Stream.Stream<Part, ChatError> {
  const { harness } = reader;
  const toolParts = (tool: ToolSlot, i: number) =>
    Effect.gen(function* () {
      const conversationId = yield* runCheck(() => cid(source.target.conversationId));
      const parts: Part[] = [];
      // A bounded snapshot capture covers more slots than its first page can reach.
      if (i >= capture.toolTasks.length) return yield* new ChatStoreError({ problem: 'failed' });
      const task = capture.toolTasks[i];
      if (task && task.conversationId !== conversationId)
        return yield* new ChatStoreError({ problem: 'live-tool' });
      const prefix = `tool${i}.`;
      const pairing = (task?.kind === 'pi.tool'
        ? yield* getTaskPairing(harness, task.conversationId, task.input as ToolTaskInput)
        : undefined) ?? { pairing: 'unmatched' as const };
      const call = { toolName: getLabel(tool.name), callId: previewText(tool.callId, 256).text };
      if (
        task?.kind === 'pi.tool' &&
        task.state.checkpoint &&
        typeof task.state.checkpoint === 'object' &&
        !Array.isArray(task.state.checkpoint) &&
        task.state.checkpoint.phase === 'execute'
      )
        parts.push(
          makePart(
            prefix + 'executed',
            'executed-arguments',
            'tool',
            JSON.stringify(task.state.checkpoint.arguments),
            { ...pairing, ...call, taskId: String(task.id), state: 'running' },
          ),
        );
      const taskId = tool.taskId ? { taskId: String(tool.taskId) } : {};
      if (tool.entry) {
        const entry = capture.tools[i];
        if (!entry || entry.conversationId !== conversationId)
          return yield* new ChatStoreError({ problem: 'tool-result' });
        for (const part of (yield* getEntryTranscript(reader, entry)).parts)
          parts.push({
            ...part,
            id: prefix + part.id,
            extra: {
              ...part.extra,
              committed: { entryId: String(entry.id), partId: part.id },
              ...taskId,
            },
          });
      } else
        parts.push(
          ...makeRunningToolParts(prefix, tool, {
            ...pairing,
            ...taskId,
            ...call,
            state: tool.status === 'done' ? 'missing-result' : 'running',
            droppedBytes: tool.droppedBytes ?? 0,
            droppedLines: tool.droppedLines ?? 0,
          }),
        );
      return parts;
    });
  let built = 0;
  const nestedParts = (tool: NestedToolSlot) =>
    Effect.gen(function* () {
      const parts: Part[] = [];
      const prefix = `nested.${tool.taskId}.`;
      const { task, input, result } = yield* readNestedCall(harness, source.target, tool);
      let state: ChatTranscriptPart['state'] = 'running';
      if (tool.status === 'done') {
        state = 'missing-result';
        if (tool.summary) state = tool.summary.isError ? 'failed' : 'completed';
      }
      const common = {
        toolName: getLabel(tool.name),
        callId: previewText(tool.callId, 256).text,
        taskId: String(tool.taskId),
        parentTaskId: String(tool.parentTaskId),
        state,
        droppedBytes: tool.droppedBytes ?? 0,
        droppedLines: tool.droppedLines ?? 0,
      };
      parts.push(
        makePart(prefix + 'arguments', 'arguments', 'tool', JSON.stringify(input.call.arguments), {
          ...common,
          state: 'requested',
        }),
      );
      const checkpoint = task.state.checkpoint as ToolTaskCheckpoint | undefined;
      let executed: NestedToolSlot['arguments'] | undefined;
      if (tool.status === 'running' && checkpoint?.phase === 'execute')
        executed = checkpoint.arguments;
      // Terminal tasks drop checkpoints; duration proves this slot's final arguments reached execution.
      else if (tool.status === 'done' && result?.durationMs !== undefined)
        executed = tool.arguments;
      if (executed !== undefined)
        parts.push(
          makePart(
            prefix + 'executed',
            'executed-arguments',
            'tool',
            JSON.stringify(executed),
            common,
          ),
        );
      if (tool.status !== 'done') {
        parts.push(...makeRunningToolParts(prefix, tool, common));
        return parts;
      }
      if (!result) {
        parts.push(
          makePart(prefix + 'output', 'result', 'tool', '', {
            ...common,
            state: 'missing-result',
            availability: 'unavailable',
          }),
        );
        return parts;
      }
      const retained: Partial<ChatTranscriptPart> = {
        ...common,
        droppedBytes: undefined,
        droppedLines: undefined,
        state: result.isError ? 'failed' : 'completed',
      };
      if (result.diagnostics.some((item) => item.code === 'aborted' || item.code === 'interrupted'))
        retained.state = 'interrupted';
      const output: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: tool.callId,
        toolName: tool.name,
        content: getNestedOutput(result.structuredOutput),
        isError: result.isError,
        ...(result.details === undefined ? {} : { details: result.details }),
        timestamp: 0,
      };
      for (const part of buildMessageParts([output], prefix)) {
        parts.push({ ...part, extra: { ...part.extra, ...retained } });
        if (++built % partsPerTurn === 0) yield* Effect.yieldNow;
      }
      if (result.structuredOutput === undefined)
        parts.push(
          makePart(prefix + 'output', 'result', 'tool', '', {
            ...retained,
            availability: 'unavailable',
          }),
        );
      if (result.diagnostics.length)
        parts.push(
          makePart(
            prefix + 'diagnostics',
            'details',
            'tool',
            JSON.stringify(result.diagnostics),
            retained,
          ),
        );
      return parts;
    });
  return Stream.concat(
    listSlotParts(capture.live.tools ?? [], toolParts),
    listSlotParts(capture.live.nestedTools ?? [], nestedParts),
  );
}
