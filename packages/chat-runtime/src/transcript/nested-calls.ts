import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  NestedCallDoc,
  type Harness,
  type NestedToolExecutionResult,
  type NestedToolSlot,
  type ToolTaskInput,
} from '@earendil-works/pi-durable';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { ChatStoreError, TranscriptChangedError } from '@moonbase/contracts/chat-errors';
import { cid } from '../documents.ts';

/** Whether a read failed because a nested tool's source ended under it; reading again may pass. */
export const isNestedSourceEnded = (error: unknown) =>
  error instanceof TranscriptChangedError && error.change === 'nested-ended';
export async function readNestedCall(
  harness: Harness,
  target: ChatTarget,
  tool: NestedToolSlot,
  signal?: AbortSignal,
) {
  const task = await harness.getTask(tool.taskId, context);
  signal?.throwIfAborted();
  if (
    !task ||
    task.kind !== 'pi.tool' ||
    task.conversationId !== cid(target.conversationId) ||
    task.owner !== tool.parentTaskId
  )
    throw new ChatStoreError({ problem: 'nested-tool' });
  const input = task.input as ToolTaskInput;
  if (
    input.kind !== 'nested' ||
    input.parent !== tool.parentTaskId ||
    input.parentCallId !== tool.parentCallId ||
    input.call.id !== tool.callId ||
    input.call.name !== tool.name ||
    tool.callId !== `${input.parentCallId}/${input.key}`
  )
    throw new ChatStoreError({ problem: 'nested-call' });
  const parent = await harness.getTask(input.parent, context);
  signal?.throwIfAborted();
  if (!parent || parent.kind !== 'pi.tool' || parent.conversationId !== task.conversationId)
    throw new ChatStoreError({ problem: 'nested-parent' });
  const record = await harness.snapshot(NestedCallDoc, input.parent, input.key, context);
  signal?.throwIfAborted();
  if (!record) {
    const currentParent = await harness.getTask(input.parent, context);
    signal?.throwIfAborted();
    if (
      !currentParent ||
      currentParent.kind !== 'pi.tool' ||
      currentParent.conversationId !== task.conversationId
    )
      throw new ChatStoreError({ problem: 'nested-parent' });
    if (currentParent.state.status === 'terminal' || currentParent.state.status === 'completing')
      throw new TranscriptChangedError({ change: 'nested-ended' });
    throw new TranscriptChangedError({ change: 'nested-source' });
  }
  if (record.taskId !== task.id || (record.result && record.result.taskId !== task.id))
    throw new ChatStoreError({ problem: 'nested-result' });
  if (tool.status === 'done' && tool.summary && !record.result)
    throw new TranscriptChangedError({ change: 'nested-result' });
  return { task, input, result: record.result };
}
export function getNestedOutput(
  value: NestedToolExecutionResult['structuredOutput'],
): ToolResultMessage['content'] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  const blocks: unknown[] = Array.isArray(value) ? value : [value];
  const isContent = (block: unknown): block is ToolResultMessage['content'][number] => {
    if (!block || typeof block !== 'object' || !('type' in block)) return false;
    if (block.type === 'text')
      return (
        'text' in block &&
        typeof block.text === 'string' &&
        Object.keys(block).every((key) => ['type', 'text', 'textSignature'].includes(key))
      );
    return (
      block.type === 'image' &&
      'data' in block &&
      typeof block.data === 'string' &&
      'mimeType' in block &&
      typeof block.mimeType === 'string' &&
      Object.keys(block).every((key) => ['type', 'data', 'mimeType'].includes(key))
    );
  };
  return blocks.length > 0 && blocks.every(isContent)
    ? blocks
    : [{ type: 'text', text: JSON.stringify(value) }];
}
