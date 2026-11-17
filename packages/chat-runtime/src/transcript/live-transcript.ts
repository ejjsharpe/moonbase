import { setImmediate } from 'node:timers/promises';
import type {
  Harness,
  NestedToolSlot,
  ToolSlot,
  ToolTaskCheckpoint,
  ToolTaskInput,
} from '@earendil-works/pi-durable';
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { ChatStoreError, TranscriptChangedError } from '@moonbase/contracts/chat-errors';
import { cid } from '../documents.ts';
import { hashJson } from '../hash-json.ts';
import { previewText } from '../text.ts';
import { getEntryTranscript } from './entry-transcript.ts';
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
export async function getLiveTranscript(
  harness: Harness,
  source: ChatTranscriptSource,
  { signal, capture: captured }: { signal?: AbortSignal; capture?: TranscriptCapture } = {},
): Promise<TranscriptParts> {
  const capture = captured ?? (await captureTranscript(harness, source.target));
  signal?.throwIfAborted();
  const actual = getLiveSource(source.target, capture);
  if (!actual || hashJson(actual) !== hashJson(source))
    throw new TranscriptChangedError({ change: 'view' });
  const message = capture.live.generation?.message as Message | undefined;
  const generation: Part[] = [];
  for (const part of buildMessageParts(message ? [message] : [], 'generation.')) {
    signal?.throwIfAborted();
    part.extra = { ...part.extra, state: part.kind === 'arguments' ? 'requested' : 'running' };
    generation.push(part);
    if (signal && generation.length % partsPerTurn === 0) await setImmediate();
  }
  // Only generation parts can hold thinking; tool and nested parts are built lazily.
  return {
    parts: listLiveParts(harness, source, capture, generation, signal),
    thinking: summarizeThinking(generation),
  };
}
async function* listLiveParts(
  harness: Harness,
  source: ChatTranscriptSource,
  capture: TranscriptCapture,
  generation: Part[],
  signal?: AbortSignal,
): AsyncGenerator<Part> {
  yield* generation;
  const conversationId = cid(source.target.conversationId);
  let built = 0;
  for (const [i, tool] of (capture.live.tools ?? []).entries()) {
    signal?.throwIfAborted();
    // A bounded snapshot capture covers more slots than its first page can reach.
    if (i >= capture.toolTasks.length) throw new Error('Live tool slot was not captured.');
    const task = capture.toolTasks[i];
    if (task && task.conversationId !== conversationId)
      throw new ChatStoreError({ problem: 'live-tool' });
    const prefix = `tool${i}.`;
    const pairing = (task?.kind === 'pi.tool'
      ? await getTaskPairing(harness, task.conversationId, task.input as ToolTaskInput, signal)
      : undefined) ?? { pairing: 'unmatched' as const };
    const call = { toolName: getLabel(tool.name), callId: previewText(tool.callId, 256).text };
    if (
      task?.kind === 'pi.tool' &&
      task.state.checkpoint &&
      typeof task.state.checkpoint === 'object' &&
      !Array.isArray(task.state.checkpoint) &&
      task.state.checkpoint.phase === 'execute'
    )
      yield makePart(
        prefix + 'executed',
        'executed-arguments',
        'tool',
        JSON.stringify(task.state.checkpoint.arguments),
        { ...pairing, ...call, taskId: String(task.id), state: 'running' },
      );
    const taskId = tool.taskId ? { taskId: String(tool.taskId) } : {};
    if (tool.entry) {
      const entry = capture.tools[i];
      if (!entry || entry.conversationId !== conversationId)
        throw new ChatStoreError({ problem: 'tool-result' });
      for (const part of (await getEntryTranscript(harness, entry, signal)).parts)
        yield {
          ...part,
          id: prefix + part.id,
          extra: {
            ...part.extra,
            committed: { entryId: String(entry.id), partId: part.id },
            ...taskId,
          },
        };
    } else
      yield* makeRunningToolParts(prefix, tool, {
        ...pairing,
        ...taskId,
        ...call,
        state: tool.status === 'done' ? 'missing-result' : 'running',
        droppedBytes: tool.droppedBytes ?? 0,
        droppedLines: tool.droppedLines ?? 0,
      });
  }
  for (const tool of capture.live.nestedTools ?? []) {
    signal?.throwIfAborted();
    const prefix = `nested.${tool.taskId}.`;
    const { task, input, result } = await readNestedCall(harness, source.target, tool, signal);
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
    yield makePart(
      prefix + 'arguments',
      'arguments',
      'tool',
      JSON.stringify(input.call.arguments),
      {
        ...common,
        state: 'requested',
      },
    );
    const checkpoint = task.state.checkpoint as ToolTaskCheckpoint | undefined;
    let executed: NestedToolSlot['arguments'] | undefined;
    if (tool.status === 'running' && checkpoint?.phase === 'execute')
      executed = checkpoint.arguments;
    // Terminal tasks drop checkpoints; duration proves this slot's final arguments reached execution.
    else if (tool.status === 'done' && result?.durationMs !== undefined) executed = tool.arguments;
    if (executed !== undefined)
      yield makePart(
        prefix + 'executed',
        'executed-arguments',
        'tool',
        JSON.stringify(executed),
        common,
      );
    if (tool.status !== 'done') {
      yield* makeRunningToolParts(prefix, tool, common);
      continue;
    }
    if (!result) {
      yield makePart(prefix + 'output', 'result', 'tool', '', {
        ...common,
        state: 'missing-result',
        availability: 'unavailable',
      });
      continue;
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
      signal?.throwIfAborted();
      yield { ...part, extra: { ...part.extra, ...retained } };
      if (signal && ++built % partsPerTurn === 0) await setImmediate();
    }
    if (result.structuredOutput === undefined)
      yield makePart(prefix + 'output', 'result', 'tool', '', {
        ...retained,
        availability: 'unavailable',
      });
    if (result.diagnostics.length)
      yield makePart(
        prefix + 'diagnostics',
        'details',
        'tool',
        JSON.stringify(result.diagnostics),
        retained,
      );
  }
}
