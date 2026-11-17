import { ToolResultEntry, type EntryRecord } from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';
import type { ChatTranscriptPart } from '@moonbase/contracts/chat';
import type { FindPartPosition } from '../cursors.ts';
import { previewText } from '../text.ts';
import { getLabel, makeValuePart, type Part, type TranscriptValue } from './transcript-part.ts';

export type TranscriptTextStep = {
  position: FindPartPosition;
  next: FindPartPosition;
  part: TranscriptValue | null;
};
export function* buildMessageParts(messages: readonly Message[], prefix: string): Generator<Part> {
  for (const { part } of getMessageSteps(messages, prefix)) if (part) yield makeValuePart(part);
}
const origin: FindPartPosition = { message: 0, block: 0, auxiliary: 0 };
/**
 * The single display policy for a saved entry, in order. Direct source positions let Find resume
 * without constructing preceding parts.
 */
export function* getEntryTextValues(
  entry: EntryRecord,
  start = origin,
): Generator<TranscriptTextStep> {
  const messages = entry.model ?? [];
  if (start.message === 0) {
    const marker = getEntryMarker(entry, messages);
    if (marker) yield { position: origin, next: { ...origin, message: 1 }, part: marker };
  }
  yield* getMessageSteps(messages, '', start);
  const diagnostics = ToolResultEntry.is(entry) ? (entry.data?.diagnostics ?? []) : [];
  if (diagnostics.length && start.message <= messages.length + 1)
    yield {
      position: { ...origin, message: messages.length + 1 },
      next: { ...origin, message: messages.length + 2 },
      part: {
        id: 'diagnostics',
        kind: 'details',
        role: 'tool',
        value: { json: diagnostics },
        extra: {},
      },
    };
}
function getEntryMarker(
  entry: EntryRecord,
  messages: readonly Message[],
): TranscriptValue | undefined {
  const marker = { id: 'marker', kind: 'notice', role: 'system' } as const;
  if (entry.kind === 'pi.reset' || entry.kind === 'pi.compaction')
    return {
      ...marker,
      value: entry.kind === 'pi.reset' ? 'Context reset.' : 'Context compacted.',
      extra: {},
    };
  // Decided without reading messages, so Find keeps its per-slice work bound.
  if (messages.length) return undefined;
  return {
    ...marker,
    value: 'Unsupported transcript record.',
    extra: { availability: 'unsupported' },
  };
}
function* getMessageSteps(
  messages: readonly Message[],
  prefix = '',
  start: FindPartPosition = { ...origin, message: 1 },
): Generator<TranscriptTextStep> {
  for (let m = Math.max(1, start.message) - 1; m < messages.length; m++) {
    const message = messages[m];
    const at = (block: number, auxiliary = 0) => ({ message: m + 1, block, auxiliary });
    const resume = start.message === m + 1 ? start : at(0);
    const nextMessage = { ...origin, message: m + 2 };
    const role = message.role === 'toolResult' ? 'tool' : message.role;
    let state: ChatTranscriptPart['state'];
    if (message.role === 'assistant') {
      state = 'completed';
      if (message.stopReason === 'error') state = 'failed';
      else if (message.stopReason === 'aborted') state = 'interrupted';
    } else if (message.role === 'toolResult') state = message.isError ? 'failed' : 'completed';
    const common: Partial<ChatTranscriptPart> = {
      ...(state ? { state } : {}),
      ...(message.role === 'toolResult'
        ? {
            toolName: getLabel(message.toolName),
            callId: previewText(message.toolCallId, 256).text,
          }
        : {}),
    };
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : message.content;
    const details =
      message.role === 'toolResult' &&
      message.details &&
      typeof message.details === 'object' &&
      !Array.isArray(message.details)
        ? (message.details as Record<string, unknown>)
        : undefined;
    let lastAuxiliary = -1;
    if (message.role === 'toolResult') {
      if (message.nestedCalls !== undefined) lastAuxiliary = 0;
      if (message.details !== undefined) lastAuxiliary = 1;
      if (typeof details?.patch === 'string') lastAuxiliary = 2;
      if (typeof details?.diff === 'string') lastAuxiliary = 3;
    } else if (state === 'failed' && role === 'assistant') lastAuxiliary = 4;
    for (let b = resume.block; b < content.length; b++) {
      const block = content[b],
        id = `${prefix}m${m}.b${b}`;
      const afterBlock = b + 1 === content.length && lastAuxiliary < 0 ? nextMessage : at(b + 1);
      const auxiliary = b === resume.block ? resume.auxiliary : 0;
      if (auxiliary === 0) {
        let part: TranscriptValue;
        if (block.type === 'text')
          part = {
            id,
            kind: role === 'tool' ? 'result' : 'text',
            role,
            value: block.text,
            extra: common,
          };
        else if (block.type === 'thinking')
          part = {
            id,
            kind: 'thinking',
            role,
            value: block.redacted ? '' : block.thinking,
            extra: { ...common, ...(block.redacted ? { availability: 'redacted' as const } : {}) },
          };
        else if (block.type === 'toolCall')
          part = {
            id,
            kind: 'arguments',
            role,
            value: { json: block.arguments },
            extra: {
              toolName: getLabel(block.name),
              callId: previewText(block.id, 256).text,
              state: 'requested',
            },
          };
        else if (block.type === 'image')
          part = {
            id,
            kind: 'image',
            role,
            value: { image: block.data },
            extra: { ...common, mimeType: getLabel(block.mimeType, 'application/octet-stream') },
          };
        else
          part = {
            id,
            kind: 'notice',
            role,
            value: 'Unsupported recorded content.',
            extra: { availability: 'unsupported' },
          };
        yield {
          position: at(b),
          next: block.type === 'toolCall' && block.argumentsError ? at(b, 1) : afterBlock,
          part,
        };
      }
      if (auxiliary <= 1 && block.type === 'toolCall' && block.argumentsError)
        yield {
          position: at(b, 1),
          next: afterBlock,
          part: {
            id: id + '.arguments-error',
            kind: 'notice',
            role,
            value: block.argumentsError,
            extra: { state: 'failed', toolName: getLabel(block.name) },
          },
        };
    }
    const auxiliary = resume.block === content.length ? resume.auxiliary : 0;
    const emit = (index: number, part: TranscriptValue): TranscriptTextStep => ({
      position: at(content.length, index),
      next: index === lastAuxiliary ? nextMessage : at(content.length, index + 1),
      part,
    });
    if (message.role === 'toolResult' && message.nestedCalls !== undefined && auxiliary <= 0)
      yield emit(0, {
        id: `${prefix}m${m}.nested-calls`,
        kind: 'details',
        role,
        value: { json: message.nestedCalls },
        extra: common,
      });
    if (message.role === 'toolResult' && message.details !== undefined) {
      if (auxiliary <= 1)
        yield emit(1, {
          id: `${prefix}m${m}.details`,
          kind: 'details',
          role,
          value: { json: message.details },
          extra: common,
        });
      if (details) {
        for (const [index, kind] of (['patch', 'diff'] as const).entries()) {
          const value = details[kind];
          if (auxiliary <= index + 2 && typeof value === 'string')
            yield emit(index + 2, {
              id: `${prefix}m${m}.${kind}`,
              kind,
              role,
              value,
              extra: common,
            });
        }
      }
    }
    if (state === 'failed' && role === 'assistant' && auxiliary <= 4)
      yield emit(4, {
        id: `${prefix}m${m}.failure`,
        kind: 'notice',
        role,
        value: 'Model response failed. Provider diagnostics are private.',
        extra: { state },
      });
    if (!content.length && lastAuxiliary < 0) {
      // Interrupted, failed and empty results are labelled rather than silently dropped.
      const empty = state && getEmptyNotice(message.role, state);
      yield {
        position: at(0),
        next: nextMessage,
        part: empty
          ? {
              id: `${prefix}m${m}.empty`,
              kind: 'notice',
              role,
              value: empty,
              extra: { ...common, state },
            }
          : null,
      };
    }
  }
}
function getEmptyNotice(role: Message['role'], state: ChatTranscriptPart['state']) {
  if (role === 'toolResult')
    return state === 'failed' ? 'Tool failed without output.' : 'Tool returned no output.';
  if (state === 'interrupted') return 'Response interrupted before any content.';
  return state === 'completed' ? 'Model returned no content.' : undefined;
}
