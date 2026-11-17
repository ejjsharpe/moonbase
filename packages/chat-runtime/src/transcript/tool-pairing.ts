import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { EntryRecord, Harness, ToolTaskInput } from '@earendil-works/pi-durable';

export async function getPairing(harness: Harness, entry: EntryRecord, signal?: AbortSignal) {
  if (!entry.byTaskId || !entry.model?.some((message) => message.role === 'toolResult'))
    return undefined;
  const task = await harness.getTask(entry.byTaskId, context);
  if (!task || task.kind !== 'pi.tool' || task.conversationId !== entry.conversationId)
    return undefined;
  const input = task.input as ToolTaskInput;
  if (
    input.kind === 'model' &&
    entry.model?.some(
      (message) => message.role === 'toolResult' && message.toolCallId !== input.callId,
    )
  )
    return undefined;
  return getTaskPairing(harness, entry.conversationId, input, signal);
}
export async function getTaskPairing(
  harness: Harness,
  conversationId: EntryRecord['conversationId'],
  input: ToolTaskInput,
  signal?: AbortSignal,
) {
  if (input.kind !== 'model') return undefined;
  signal?.throwIfAborted();
  const assistant = await harness.commit((tx) => tx.entry(input.assistant), context);
  if (!assistant || assistant.conversationId !== conversationId) return undefined;
  // Match the full call ID, never its preview, and never choose between duplicate IDs in one assistant entry.
  const positions: string[] = [];
  assistant.model?.forEach((message, m) => {
    if (message.role === 'assistant')
      message.content.forEach((block, b) => {
        if (block.type === 'toolCall' && block.id === input.callId) positions.push(`m${m}.b${b}`);
      });
  });
  if (positions.length !== 1) return { pairing: 'ambiguous' as const };
  return {
    pairing: 'matched' as const,
    call: { entryId: String(assistant.id), partId: positions[0] },
  };
}
