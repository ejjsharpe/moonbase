import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  LiveDoc,
  ToolResultEntry,
  type Harness,
  type EntryRecord,
  type LiveState,
  type ToolTaskInput,
} from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';
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
export async function captureTranscript(harness: Harness, target: ChatTarget) {
  return harness.commit(async (tx) => {
    // LiveDoc already exists for every Harness-created conversation; this read changes no fields.
    const live = JSON.parse(
      JSON.stringify(await tx.doc(LiveDoc, cid(target.conversationId))),
    ) as LiveState;
    const boundary = (
      await tx.scanEntries({ conversationId: cid(target.conversationId), order: 'descending' }, 1)
    ).items[0]?.id;
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
function* messageParts(messages: readonly Message[], prefix = ''): Generator<Part> {
  for (const [m, message] of messages.entries()) {
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
            callId: V.preview(message.toolCallId, 256).text,
          }
        : {}),
    };
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : message.content;
    for (const [b, block] of content.entries()) {
      const id = `${prefix}m${m}.b${b}`;
      if (block.type === 'text')
        yield makePart(id, role === 'tool' ? 'result' : 'text', role, block.text, common);
      else if (block.type === 'thinking')
        yield makePart(id, 'thinking', role, block.redacted ? '' : block.thinking, {
          ...common,
          ...(block.redacted ? { availability: 'redacted' as const } : {}),
        });
      else if (block.type === 'toolCall') {
        yield makePart(id, 'arguments', role, JSON.stringify(block.arguments), {
          toolName: getLabel(block.name),
          callId: V.preview(block.id, 256).text,
          state: 'requested',
        });
        if (block.argumentsError)
          yield makePart(id + '.arguments-error', 'notice', role, block.argumentsError, {
            state: 'failed',
            toolName: getLabel(block.name),
          });
      } else if (block.type === 'image') {
        const decoded = Buffer.from(block.data, 'base64');
        const valid = decoded.toString('base64') === block.data;
        const bytes = valid ? decoded : Buffer.alloc(0);
        yield makePart(id, 'image', role, bytes, {
          ...common,
          mimeType: getLabel(block.mimeType, 'application/octet-stream'),
          ...(!valid ? { availability: 'unavailable' as const } : {}),
        });
      } else
        yield makePart(id, 'notice', role, 'Unsupported recorded content.', {
          availability: 'unsupported',
        });
    }
    if (message.role === 'toolResult' && message.nestedCalls !== undefined)
      yield makePart(
        `${prefix}m${m}.nested-calls`,
        'details',
        role,
        JSON.stringify(message.nestedCalls),
        common,
      );
    if (message.role === 'toolResult' && message.details !== undefined) {
      yield makePart(
        `${prefix}m${m}.details`,
        'details',
        role,
        JSON.stringify(message.details),
        common,
      );
      if (
        message.details &&
        typeof message.details === 'object' &&
        !Array.isArray(message.details)
      ) {
        const details = message.details as Record<string, unknown>;
        for (const kind of ['patch', 'diff'] as const)
          if (typeof details[kind] === 'string')
            yield makePart(`${prefix}m${m}.${kind}`, kind, role, details[kind], common);
      }
    }
    if (state === 'failed' && role === 'assistant')
      yield makePart(
        `${prefix}m${m}.failure`,
        'notice',
        role,
        'Model response failed. Provider diagnostics are private.',
        { state },
      );
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
      makePart(
        prefix + 'arguments',
        'executed-arguments',
        'tool',
        JSON.stringify(tool.arguments),
        common,
      ),
    );
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
