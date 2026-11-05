import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  LiveDoc,
  NestedCallDoc,
  type NestedToolSlot,
  type NestedToolExecutionResult,
  ToolResultEntry,
  type Harness,
  type EntryRecord,
  type LiveState,
  type ToolTaskInput,
  type ToolTaskCheckpoint,
  type EntryId,
} from '@earendil-works/pi-durable';
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';
import {
  chatContentChunkBytes,
  chatManifestPageSize,
  type ChatTarget,
  type ChatTranscriptSource,
  type ChatTranscriptPart,
  type ChatTranscriptSelection,
  type ChatTranscript,
  type ChatInput,
  type ChatOutput,
} from '@moonbase/contracts/chat';
import { ApplicationError } from '@moonbase/contracts/errors';
import { cid, eid } from './documents.ts';
import * as V from './validation.ts';
import * as S from './private-schema.ts';

const keys = new WeakMap<Harness, Buffer>();
function getKey(harness: Harness) {
  let key = keys.get(harness);
  if (!key) {
    key = randomBytes(32);
    keys.set(harness, key);
  }
  return key;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const bind = (value: unknown) => hash(JSON.stringify(value));
const getLabel = (value: string, fallback = 'Tool') =>
  V.preview(value, 128).text.replaceAll('\0', '').trim() || fallback;
export class NestedSourceRetired extends ApplicationError {
  constructor() {
    super({ code: 'Conflict', message: 'Nested tool source ended; reload the consistent view.' });
  }
}
export function sealCursor(harness: Harness, value: S.TranscriptCursor) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  const mac = createHmac('sha256', getKey(harness)).update(body).digest('base64url');
  return V.cursor(body + '.' + mac);
}
export function openCursor(
  harness: Harness,
  encoded: string,
  kind: S.TranscriptCursor['kind'],
  binding: string,
) {
  try {
    const [body, mac, extra] = encoded.split('.');
    const expected = createHmac('sha256', getKey(harness)).update(body).digest();
    const actual = Buffer.from(mac, 'base64url');
    if (
      extra !== undefined ||
      actual.toString('base64url') !== mac ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw Error();
    const value = S.transcriptCursor(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    if (value.kind !== kind || value.binding !== binding) throw Error();
    return value;
  } catch {
    return V.fail('InvalidInput', 'Transcript cursor does not belong to this read.');
  }
}
export const bindTranscriptRead = bind;
export const checkRead = (signal?: AbortSignal) => signal?.throwIfAborted();
export async function readEntry(harness: Harness, target: ChatTarget, id: string) {
  const entry = await harness.commit((tx) => tx.entry(eid(id)), context);
  if (!entry || entry.conversationId !== cid(target.conversationId))
    return V.fail('InvalidInput', 'Entry does not belong to this conversation.');
  return entry;
}
export async function captureTranscript(
  harness: Harness,
  target: ChatTarget,
  cache?: { boundary?: EntryId | null; retired?: boolean },
) {
  return harness.commit(async (tx) => {
    if (cache?.retired)
      V.fail('Persistence', 'Pi live state was replaced. Reopen this conversation.');
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
        { conversationId: cid(target.conversationId), kind: 'pi.generation', order: 'descending' },
        1,
      )
    ).items[0];
    const tools = await Promise.all(
      (live.tools ?? []).slice(0, 8).map((tool) => (tool.entry ? tx.entry(tool.entry) : undefined)),
    );
    const toolTasks = await Promise.all(
      (live.tools ?? [])
        .slice(0, 8)
        .map((tool) => (tool.taskId ? tx.task(tool.taskId) : undefined)),
    );
    return { live, boundary, task, latest, tools, toolTasks };
  }, context);
}
export function getLiveSource(
  harness: Harness,
  target: ChatTarget,
  capture: Awaited<ReturnType<typeof captureTranscript>>,
): ChatTranscriptSource | undefined {
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
  if (task.conversationId !== cid(target.conversationId))
    V.fail('Persistence', 'Live task authority is invalid.');
  const attempt = live.generation?.attempt ?? 0;
  const incarnation = createHmac('sha256', getKey(harness))
    .update(
      JSON.stringify({
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
      }),
    )
    .digest('hex');
  return {
    kind: 'live',
    target,
    submissionId: String(submission),
    taskId: String(task.id),
    attempt,
    incarnation,
  };
}

type Part = { descriptor: ChatTranscriptPart; value: string | Buffer; evidence?: string };
function makePart(
  id: string,
  kind: ChatTranscriptPart['kind'],
  role: ChatTranscriptPart['role'],
  value: string | Buffer,
  extra: Partial<ChatTranscriptPart> = {},
  evidence = '',
): Part {
  if (typeof value === 'string' && !value.isWellFormed()) {
    value = '';
    extra = { ...extra, availability: 'unavailable' };
  }
  const encoding = typeof value === 'string' ? 'utf8' : 'base64';
  const bytes = Buffer.byteLength(value);
  evidence = JSON.stringify([id, kind, role, encoding, evidence]);
  return {
    value,
    evidence,
    descriptor: {
      partId: id,
      kind,
      role,
      availability: 'available',
      encoding,
      bytes,
      revision: hash(Buffer.concat([Buffer.from(evidence), Buffer.from(value)])),
      ...(typeof value === 'string' ? V.preview(value, 256) : { text: '', truncated: bytes > 0 }),
      ...extra,
    },
  };
}
export type TranscriptValue = {
  id: string;
  kind: ChatTranscriptPart['kind'];
  role: ChatTranscriptPart['role'];
  value: string | { json: unknown } | { image: string };
  extra: Partial<ChatTranscriptPart>;
};
const makeValue = (
  id: string,
  kind: ChatTranscriptPart['kind'],
  role: ChatTranscriptPart['role'],
  value: TranscriptValue['value'],
  extra: Partial<ChatTranscriptPart> = {},
): TranscriptValue => ({ id, kind, role, value, extra });
type TranscriptTextStep = {
  position: S.FindPartPosition;
  next: S.FindPartPosition;
  part: TranscriptValue | null;
};
const getTextPosition = (message: number, block = 0, auxiliary = 0): S.FindPartPosition => ({
  message,
  block,
  auxiliary,
});
const makeTextStep = (
  position: S.FindPartPosition,
  next: S.FindPartPosition,
  part: TranscriptValue | null,
): TranscriptTextStep => ({ position, next, part });
function* messageParts(messages: readonly Message[], prefix = ''): Generator<Part> {
  for (const { part } of messageSteps(messages, prefix)) {
    if (!part) continue;
    let value: string | Buffer;
    const extra = { ...part.extra };
    if (typeof part.value === 'string') value = part.value;
    else if ('json' in part.value) value = JSON.stringify(part.value.json);
    else {
      value = Buffer.from(part.value.image, 'base64');
      if (value.toString('base64') !== part.value.image) {
        value = Buffer.alloc(0);
        extra.availability = 'unavailable';
      }
    }
    yield makePart(part.id, part.kind, part.role, value, extra);
  }
}
/** Direct source positions share the display policy without constructing preceding parts. */
export function* getEntryTextValues(
  entry: EntryRecord,
  start = getTextPosition(0),
): Generator<TranscriptTextStep> {
  if (start.message === 0 && (entry.kind === 'pi.reset' || entry.kind === 'pi.compaction'))
    yield makeTextStep(
      getTextPosition(0),
      getTextPosition(1),
      makeValue(
        'marker',
        'notice',
        'system',
        entry.kind === 'pi.reset' ? 'Context reset.' : 'Context compacted.',
      ),
    );
  const messages = entry.model ?? [];
  yield* messageSteps(messages, '', start);
  const diagnostics = ToolResultEntry.is(entry) ? (entry.data?.diagnostics ?? []) : [];
  if (diagnostics.length && start.message <= messages.length + 1)
    yield makeTextStep(
      getTextPosition(messages.length + 1),
      getTextPosition(messages.length + 2),
      makeValue('diagnostics', 'details', 'tool', { json: diagnostics }),
    );
}
function* messageSteps(
  messages: readonly Message[],
  prefix = '',
  start = getTextPosition(1),
): Generator<TranscriptTextStep> {
  for (let m = Math.max(1, start.message) - 1; m < messages.length; m++) {
    const message = messages[m];
    const at = start.message === m + 1 ? start : getTextPosition(m + 1);
    const nextMessage = getTextPosition(m + 2);
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
        ? { toolName: getLabel(message.toolName), callId: V.preview(message.toolCallId, 256).text }
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
    for (let b = at.block; b < content.length; b++) {
      const block = content[b],
        id = `${prefix}m${m}.b${b}`;
      const position = getTextPosition(m + 1, b);
      const afterBlock =
        b + 1 === content.length && lastAuxiliary < 0 ? nextMessage : getTextPosition(m + 1, b + 1);
      const auxiliary = b === at.block ? at.auxiliary : 0;
      if (auxiliary === 0) {
        let part: TranscriptValue;
        if (block.type === 'text')
          part = makeValue(id, role === 'tool' ? 'result' : 'text', role, block.text, common);
        else if (block.type === 'thinking')
          part = makeValue(id, 'thinking', role, block.redacted ? '' : block.thinking, {
            ...common,
            ...(block.redacted ? { availability: 'redacted' as const } : {}),
          });
        else if (block.type === 'toolCall')
          part = makeValue(
            id,
            'arguments',
            role,
            { json: block.arguments },
            {
              toolName: getLabel(block.name),
              callId: V.preview(block.id, 256).text,
              state: 'requested',
            },
          );
        else if (block.type === 'image')
          part = makeValue(
            id,
            'image',
            role,
            { image: block.data },
            {
              ...common,
              mimeType: getLabel(block.mimeType, 'application/octet-stream'),
            },
          );
        else
          part = makeValue(id, 'notice', role, 'Unsupported recorded content.', {
            availability: 'unsupported',
          });
        yield makeTextStep(
          position,
          block.type === 'toolCall' && block.argumentsError
            ? getTextPosition(m + 1, b, 1)
            : afterBlock,
          part,
        );
      }
      if (auxiliary <= 1 && block.type === 'toolCall' && block.argumentsError)
        yield makeTextStep(
          getTextPosition(m + 1, b, 1),
          afterBlock,
          makeValue(id + '.arguments-error', 'notice', role, block.argumentsError, {
            state: 'failed',
            toolName: getLabel(block.name),
          }),
        );
    }
    const auxiliary = at.block === content.length ? at.auxiliary : 0;
    const emit = (index: number, part: TranscriptValue) =>
      makeTextStep(
        getTextPosition(m + 1, content.length, index),
        index === lastAuxiliary ? nextMessage : getTextPosition(m + 1, content.length, index + 1),
        part,
      );
    if (message.role === 'toolResult' && message.nestedCalls !== undefined && auxiliary <= 0)
      yield emit(
        0,
        makeValue(
          `${prefix}m${m}.nested-calls`,
          'details',
          role,
          { json: message.nestedCalls },
          common,
        ),
      );
    if (message.role === 'toolResult' && message.details !== undefined) {
      if (auxiliary <= 1)
        yield emit(
          1,
          makeValue(`${prefix}m${m}.details`, 'details', role, { json: message.details }, common),
        );
      if (details) {
        for (const [index, kind] of (['patch', 'diff'] as const).entries())
          if (auxiliary <= index + 2 && typeof details[kind] === 'string')
            yield emit(
              index + 2,
              makeValue(`${prefix}m${m}.${kind}`, kind, role, details[kind], common),
            );
      }
    }
    if (state === 'failed' && role === 'assistant' && auxiliary <= 4)
      yield emit(
        4,
        makeValue(
          `${prefix}m${m}.failure`,
          'notice',
          role,
          'Model response failed. Provider diagnostics are private.',
          { state },
        ),
      );
    if (!content.length && lastAuxiliary < 0)
      yield makeTextStep(getTextPosition(m + 1), nextMessage, null);
  }
}
async function getPairing(harness: Harness, entry: EntryRecord, signal?: AbortSignal) {
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
async function getTaskPairing(
  harness: Harness,
  conversationId: EntryRecord['conversationId'],
  input: ToolTaskInput,
  signal?: AbortSignal,
) {
  if (input.kind !== 'model') return undefined;
  checkRead(signal);
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
export async function getEntryParts(
  harness: Harness,
  entry: EntryRecord,
  signal?: AbortSignal,
): Promise<Part[]> {
  checkRead(signal);
  const pairing = await getPairing(harness, entry, signal);
  checkRead(signal);
  const parts: Part[] = [];
  for (const part of messageParts(entry.model ?? [])) {
    checkRead(signal);
    parts.push(part);
    if (signal && parts.length % 32 === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!parts.length && entry.kind !== 'pi.reset' && entry.kind !== 'pi.compaction')
    parts.push(
      makePart('marker', 'notice', 'system', 'Unsupported transcript record.', {
        availability: 'unsupported',
      }),
    );
  const diagnostics = ToolResultEntry.is(entry) ? (entry.data?.diagnostics ?? []) : [];
  if (diagnostics.length)
    parts.push(makePart('diagnostics', 'details', 'tool', JSON.stringify(diagnostics)));
  if (entry.kind === 'pi.reset' || entry.kind === 'pi.compaction')
    parts.unshift(
      makePart(
        'marker',
        'notice',
        'system',
        entry.kind === 'pi.reset' ? 'Context reset.' : 'Context compacted.',
      ),
    );
  for (const part of parts)
    if (part.descriptor.role === 'tool') {
      part.descriptor = {
        ...part.descriptor,
        ...(pairing ?? { pairing: 'unmatched' as const }),
        ...(diagnostics.some((item) => item.code === 'aborted' || item.code === 'interrupted')
          ? { state: 'interrupted' as const }
          : {}),
      };
    }
  return parts;
}
async function readNestedCall(
  harness: Harness,
  target: ChatTarget,
  tool: NestedToolSlot,
  signal?: AbortSignal,
) {
  const task = await harness.getTask(tool.taskId, context);
  checkRead(signal);
  if (
    !task ||
    task.kind !== 'pi.tool' ||
    task.conversationId !== cid(target.conversationId) ||
    task.owner !== tool.parentTaskId
  )
    return V.fail('Persistence', 'Nested tool authority is invalid.');
  const input = task.input as ToolTaskInput;
  if (
    input.kind !== 'nested' ||
    input.parent !== tool.parentTaskId ||
    input.parentCallId !== tool.parentCallId ||
    input.call.id !== tool.callId ||
    input.call.name !== tool.name ||
    tool.callId !== `${input.parentCallId}/${input.key}`
  )
    return V.fail('Persistence', 'Nested tool call identity is invalid.');
  const parent = await harness.getTask(input.parent, context);
  checkRead(signal);
  if (!parent || parent.kind !== 'pi.tool' || parent.conversationId !== task.conversationId)
    return V.fail('Persistence', 'Nested tool parent authority is invalid.');
  const record = await harness.snapshot(NestedCallDoc, input.parent, input.key, context);
  checkRead(signal);
  if (!record) {
    const currentParent = await harness.getTask(input.parent, context);
    checkRead(signal);
    if (
      !currentParent ||
      currentParent.kind !== 'pi.tool' ||
      currentParent.conversationId !== task.conversationId
    )
      return V.fail('Persistence', 'Nested tool parent authority is invalid.');
    if (currentParent.state.status === 'terminal' || currentParent.state.status === 'completing')
      throw new NestedSourceRetired();
    return V.fail('Conflict', 'Nested tool source is unavailable; reload the consistent view.');
  }
  if (record.taskId !== task.id || (record.result && record.result.taskId !== task.id))
    return V.fail('Persistence', 'Retained nested result identity is invalid.');
  if (tool.status === 'done' && tool.summary && !record.result)
    return V.fail('Conflict', 'Retained nested result is unavailable; reload the source.');
  return { task, input, result: record.result };
}
function getNestedOutput(
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
async function getLiveParts(
  harness: Harness,
  source: ChatTranscriptSource,
  signal?: AbortSignal,
  captured?: Awaited<ReturnType<typeof captureTranscript>>,
): Promise<Part[]> {
  const capture = captured ?? (await captureTranscript(harness, source.target));
  checkRead(signal);
  const actual = getLiveSource(harness, source.target, capture);
  if (!actual || bind(actual) !== bind(source))
    return V.fail('Conflict', 'Transcript source changed; reload the consistent view.');
  const parts: Part[] = [];
  for (const part of messageParts(
    capture.live.generation?.message ? [capture.live.generation.message as Message] : [],
    'generation.',
  )) {
    checkRead(signal);
    part.descriptor.state = part.descriptor.kind === 'arguments' ? 'requested' : 'running';
    parts.push(part);
    if (signal && parts.length % 32 === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
  }
  for (const [i, tool] of (capture.live.tools ?? []).entries()) {
    checkRead(signal);
    let task = capture.toolTasks[i];
    const taskId = tool.taskId;
    if (i >= 8 && taskId) task = await harness.commit((tx) => tx.task(taskId), context);
    if (task && task.conversationId !== cid(source.target.conversationId))
      V.fail('Persistence', 'Live tool authority is invalid.');
    const prefix = `tool${i}.`;
    const pairing =
      task?.kind === 'pi.tool'
        ? await getTaskPairing(harness, task.conversationId, task.input as ToolTaskInput, signal)
        : undefined;
    if (
      task?.kind === 'pi.tool' &&
      task.state.checkpoint &&
      typeof task.state.checkpoint === 'object' &&
      !Array.isArray(task.state.checkpoint) &&
      task.state.checkpoint.phase === 'execute'
    ) {
      parts.push(
        makePart(
          prefix + 'executed',
          'executed-arguments',
          'tool',
          JSON.stringify(task.state.checkpoint.arguments),
          {
            ...(pairing ?? { pairing: 'unmatched' as const }),
            toolName: getLabel(tool.name),
            callId: V.preview(tool.callId, 256).text,
            taskId: String(task.id),
            state: 'running',
          },
        ),
      );
    }
    if (tool.entry) {
      const entry =
        capture.tools[i] ?? (await readEntry(harness, source.target, String(tool.entry)));
      if (!entry || entry.conversationId !== cid(source.target.conversationId))
        return V.fail('Persistence', 'Recorded tool result is unavailable.');
      parts.push(
        ...(await getEntryParts(harness, entry, signal)).map((part) => ({
          ...part,
          descriptor: {
            ...part.descriptor,
            partId: prefix + part.descriptor.partId,
            committed: { entryId: String(entry.id), partId: part.descriptor.partId },
            ...(tool.taskId ? { taskId: String(tool.taskId) } : {}),
          },
        })),
      );
    } else {
      const evidence = JSON.stringify([tool.droppedBytes ?? 0, tool.droppedLines ?? 0]);
      const common = {
        ...(pairing ?? { pairing: 'unmatched' as const }),
        ...(tool.taskId ? { taskId: String(tool.taskId) } : {}),
        toolName: getLabel(tool.name),
        callId: V.preview(tool.callId, 256).text,
        state: tool.status === 'done' ? ('missing-result' as const) : ('running' as const),
        droppedBytes: tool.droppedBytes ?? 0,
        droppedLines: tool.droppedLines ?? 0,
      };
      parts.push(
        makePart(prefix + 'output', 'result', 'tool', tool.output ?? '', common, evidence),
      );
      if (tool.diagnostics?.length)
        parts.push(
          makePart(
            prefix + 'diagnostics',
            'details',
            'tool',
            JSON.stringify(tool.diagnostics),
            common,
          ),
        );
      if (tool.details !== undefined)
        parts.push(
          makePart(prefix + 'details', 'details', 'tool', JSON.stringify(tool.details), common),
        );
    }
  }
  for (const tool of capture.live.nestedTools ?? []) {
    checkRead(signal);
    const prefix = `nested.${tool.taskId}.`;
    const { task, input, result } = await readNestedCall(harness, source.target, tool, signal);
    let state: ChatTranscriptPart['state'] = 'running';
    if (tool.status === 'done') {
      state = 'missing-result';
      if (tool.summary) state = tool.summary.isError ? 'failed' : 'completed';
    }
    const common = {
      toolName: getLabel(tool.name),
      callId: V.preview(tool.callId, 256).text,
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
    else if (tool.status === 'done' && result?.durationMs !== undefined) executed = tool.arguments;
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
    if (tool.status === 'done') {
      if (!result) {
        parts.push(
          makePart(prefix + 'output', 'result', 'tool', '', {
            ...common,
            state: 'missing-result',
            availability: 'unavailable',
          }),
        );
        continue;
      }
      const retained: Partial<ChatTranscriptPart> = {
        ...common,
        droppedBytes: undefined,
        droppedLines: undefined,
        state: result.isError ? ('failed' as const) : ('completed' as const),
      };
      if (result.diagnostics.some((item) => item.code === 'aborted' || item.code === 'interrupted'))
        retained.state = 'interrupted';
      for (const part of messageParts(
        [
          {
            role: 'toolResult',
            toolCallId: tool.callId,
            toolName: tool.name,
            content: getNestedOutput(result.structuredOutput),
            isError: result.isError,
            ...(result.details === undefined ? {} : { details: result.details }),
            timestamp: 0,
          },
        ],
        prefix,
      )) {
        checkRead(signal);
        parts.push({ ...part, descriptor: { ...part.descriptor, ...retained } });
        if (signal && parts.length % 32 === 0)
          await new Promise<void>((resolve) => setImmediate(resolve));
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
      continue;
    }
    parts.push(
      makePart(
        prefix + 'output',
        'result',
        'tool',
        tool.output ?? '',
        common,
        JSON.stringify([tool.droppedBytes ?? 0, tool.droppedLines ?? 0]),
      ),
    );
    if (tool.diagnostics?.length)
      parts.push(
        makePart(
          prefix + 'diagnostics',
          'details',
          'tool',
          JSON.stringify(tool.diagnostics),
          common,
        ),
      );
    if (tool.details !== undefined)
      parts.push(
        makePart(prefix + 'details', 'details', 'tool', JSON.stringify(tool.details), common),
      );
  }
  return parts;
}
export function projectManifest(
  harness: Harness,
  source: ChatTranscriptSource,
  parts: Part[],
  start = 0,
  limit = chatManifestPageSize,
): ChatTranscript {
  const page = parts.slice(start, start + limit).map((part) => part.descriptor);
  const position = start + page.length;
  let thinking: ChatTranscript['thinking'] = source.kind === 'live' ? 'pending' : 'none';
  if (parts.some((part) => part.descriptor.kind === 'thinking')) thinking = 'redacted';
  if (
    parts.some(
      (part) => part.descriptor.kind === 'thinking' && part.descriptor.availability === 'available',
    )
  )
    thinking = 'available';
  return {
    source,
    parts: page,
    nextCursor:
      position < parts.length
        ? sealCursor(harness, {
            kind: 'manifest',
            binding: bind(source),
            revision: bind(parts.map((part) => part.descriptor)),
            position,
          })
        : null,
    thinking,
  };
}
export async function projectEntryTranscript(
  harness: Harness,
  target: ChatTarget,
  entry: EntryRecord,
  signal?: AbortSignal,
) {
  const source: ChatTranscriptSource = { kind: 'entry', target, entryId: String(entry.id) };
  return projectManifest(harness, source, await getEntryParts(harness, entry, signal), 0, 4);
}
export async function projectLiveTranscript(
  harness: Harness,
  source: ChatTranscriptSource,
  captured: Awaited<ReturnType<typeof captureTranscript>>,
) {
  return projectManifest(
    harness,
    source,
    await getLiveParts(harness, source, undefined, captured),
    0,
    4,
  );
}
function selectPart(parts: Part[], selection: ChatTranscriptSelection) {
  const part = parts.find((part) => part.descriptor.partId === selection.partId);
  if (!part || part.descriptor.availability !== 'available')
    return V.fail('InvalidInput', 'Transcript part is unavailable or invalid.');
  const bytes = Buffer.from(part.value);
  if (
    selection.bytes > bytes.length ||
    hash(Buffer.concat([Buffer.from(part.evidence ?? ''), bytes.subarray(0, selection.bytes)])) !==
      selection.revision
  )
    return V.fail('Conflict', 'Transcript prefix changed; reload the selected part.');
  return { part, bytes };
}
export async function readTranscriptContent(
  harness: Harness,
  input: ChatInput<'getChatTranscriptContent'>,
  signal?: AbortSignal,
): Promise<ChatOutput<'getChatTranscriptContent'>> {
  const { source, selection } = input;
  checkRead(signal);
  const parts =
    source.kind === 'entry'
      ? await getEntryParts(
          harness,
          await readEntry(harness, source.target, source.entryId),
          signal,
        )
      : await getLiveParts(harness, source, signal);
  checkRead(signal);
  if (!selection) {
    if (source.kind === 'live') {
      const current = await getLiveParts(harness, source, signal);
      if (
        bind(current.map((part) => part.descriptor)) !== bind(parts.map((part) => part.descriptor))
      )
        V.fail('Conflict', 'Transcript manifest changed; reload the source.');
      checkRead(signal);
    }
    const cursor = input.cursor
      ? openCursor(harness, input.cursor, 'manifest', bind(source))
      : undefined;
    if (cursor && cursor.revision !== bind(parts.map((part) => part.descriptor)))
      V.fail('Conflict', 'Transcript manifest changed; reload the source.');
    const start = cursor?.position ?? 0;
    if (start > parts.length) V.fail('InvalidInput', 'Invalid manifest position.');
    return {
      kind: 'manifest',
      cursor: input.cursor ?? null,
      ...projectManifest(harness, source, parts, start),
    };
  }
  const { part, bytes } = selectPart(parts, selection);
  if (source.kind === 'live') {
    const current = await getLiveParts(harness, source, signal);
    if (
      !current.some(
        (part) =>
          part.descriptor.partId === selection.partId &&
          part.descriptor.availability === 'available',
      )
    )
      V.fail('Conflict', 'Transcript part disappeared; reload the source.');
    selectPart(current, selection);
    checkRead(signal);
  }
  const binding = bind({ source, selection });
  const offset = input.cursor ? openCursor(harness, input.cursor, 'content', binding).position : 0;
  if (offset > selection.bytes) V.fail('InvalidInput', 'Invalid content position.');
  let end = Math.min(offset + chatContentChunkBytes, selection.bytes);
  if (part.descriptor.encoding === 'utf8') {
    while (end < selection.bytes && (bytes[end] & 0xc0) === 0x80) end--;
    if (
      (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) ||
      (selection.bytes < bytes.length && (bytes[selection.bytes] & 0xc0) === 0x80)
    )
      V.fail('InvalidInput', 'Content selection splits Unicode.');
  }
  return {
    kind: 'content',
    cursor: input.cursor ?? null,
    source,
    selection,
    offset,
    encoding: part.descriptor.encoding,
    data: bytes
      .subarray(offset, end)
      .toString(part.descriptor.encoding === 'utf8' ? 'utf8' : 'base64'),
    nextCursor:
      end < selection.bytes
        ? sealCursor(harness, { kind: 'content', binding, position: end })
        : null,
  };
}
