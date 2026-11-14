import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
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
  type ToolSlot,
  type ToolTaskInput,
  type ToolTaskCheckpoint,
  type EntryId,
} from '@earendil-works/pi-durable';
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';
import { LRUCache } from 'lru-cache';
import {
  chatContentChunkBytes,
  chatLiveTextBytes,
  chatManifestPageSize,
  type ChatTarget,
  type ChatTranscriptSource,
  type ChatTranscriptPart,
  type ChatTranscriptSelection,
  type ChatTranscript,
  type ChatInput,
  type ChatOutput,
} from '@moonbase/contracts/chat';
import { ApplicationError, fail } from '@moonbase/contracts/errors';
import { cid, eid } from './documents.ts';
import { checkCursor, previewText } from './text.ts';
import { decodeTranscriptCursor, type FindPartPosition, type TranscriptCursor } from './cursors.ts';

/** Long reads yield to other work after this many parts. */
const partsPerTurn = 32;
/** Saved entries are immutable, so each Harness shares their built parts up to this budget. */
const entryCacheBytes = 32 * 1024 * 1024;
const partOverheadBytes = 512;
/** History and live snapshots embed only the first manifest page of each transcript. */
const embeddedManifestParts = 4;

const keys = new WeakMap<Harness, Buffer>();
function getKey(harness: Harness) {
  let key = keys.get(harness);
  if (!key) {
    key = randomBytes(32);
    keys.set(harness, key);
  }
  return key;
}
export const hashJson = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const getLabel = (value: string, fallback = 'Tool') =>
  previewText(value, 128).text.replaceAll('\0', '').trim() || fallback;
export class NestedSourceRetired extends ApplicationError {
  constructor() {
    super({ code: 'Conflict', message: 'Nested tool source ended; reload the consistent view.' });
  }
}
export function sealCursor(harness: Harness, value: TranscriptCursor) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  const mac = createHmac('sha256', getKey(harness)).update(body).digest('base64url');
  return checkCursor(body + '.' + mac);
}
export function openCursor(
  harness: Harness,
  encoded: string,
  kind: TranscriptCursor['kind'],
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
    const value = decodeTranscriptCursor(
      JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
    );
    if (value.kind !== kind || value.binding !== binding) throw Error();
    return value;
  } catch {
    return fail('InvalidInput', 'Transcript cursor does not belong to this read.');
  }
}
export async function readEntry(harness: Harness, target: ChatTarget, id: string) {
  const entry = await harness.commit((tx) => tx.entry(eid(id)), context);
  if (!entry || entry.conversationId !== cid(target.conversationId))
    return fail('InvalidInput', 'Entry does not belong to this conversation.');
  return entry;
}
/**
 * Reads the first entry at or past `position` in `direction`; newer scans stop at `upper`.
 * Without a position, an older scan returns the conversation's latest entry.
 */
export async function scanAdjacentEntry(
  harness: Harness,
  target: ChatTarget,
  direction: 'older' | 'newer',
  position?: number,
  upper?: string,
) {
  let range: { minEntryId?: EntryId; maxEntryId?: EntryId } = {};
  if (direction === 'newer')
    range = {
      minEntryId: eid(String(position ?? 1)),
      ...(upper === undefined ? {} : { maxEntryId: eid(upper) }),
    };
  else if (position !== undefined) range = { maxEntryId: eid(String(position)) };
  const page = await harness.commit(
    (tx) =>
      tx.scanEntries(
        {
          conversationId: cid(target.conversationId),
          order: direction === 'older' ? 'descending' : 'ascending',
          ...range,
        },
        1,
      ),
    context,
  );
  return page.items[0];
}
export async function captureTranscript(
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
) {
  return harness.commit(async (tx) => {
    if (cache?.retired)
      fail('Persistence', 'Pi live state was replaced. Reopen this conversation.');
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
    // Tool slots are read here so one projection never mixes two control revisions.
    const slots = (live.tools ?? []).slice(0, toolSlots);
    const tools = await Promise.all(
      slots.map((tool) => (tool.entry ? tx.entry(tool.entry) : undefined)),
    );
    const toolTasks = await Promise.all(
      slots.map((tool) => (tool.taskId ? tx.task(tool.taskId) : undefined)),
    );
    return { live, boundary, task, latest, tools, toolTasks };
  }, context);
}
type TranscriptCapture = Awaited<ReturnType<typeof captureTranscript>>;
export function getLiveSource(
  harness: Harness,
  target: ChatTarget,
  capture: TranscriptCapture,
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
    fail('Persistence', 'Live task authority is invalid.');
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

type Part = {
  id: string;
  kind: ChatTranscriptPart['kind'];
  role: ChatTranscriptPart['role'];
  encoding: ChatTranscriptPart['encoding'];
  /** Encoded once, so content reads slice it and caches measure it without copying. */
  value: Buffer;
  /** Identity bound into every revision of this value, fixed when the part is first built. */
  evidence: string;
  extra: Partial<ChatTranscriptPart>;
  /** Facts derived from `value`, computed on first use and shared by relabelled copies. */
  memo: { revision?: string; preview?: { text: string; truncated: boolean } };
};
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
  return {
    id,
    kind,
    role,
    encoding,
    value: typeof value === 'string' ? Buffer.from(value) : value,
    extra,
    evidence: JSON.stringify([id, kind, role, encoding, evidence]),
    memo: {},
  };
}
const hashPrefix = (part: Part, bytes: number) =>
  createHash('sha256').update(part.evidence).update(part.value.subarray(0, bytes)).digest('hex');
const getRevision = (part: Part) => (part.memo.revision ??= hashPrefix(part, part.value.length));
const isAvailable = (part: Part) => (part.extra.availability ?? 'available') === 'available';
/** Enough leading bytes for a 256-byte preview to know whether it was truncated. */
const previewWindowBytes = 1024;
/**
 * Upgrades a running response's available text parts, in order, to carry their whole text while
 * the page's text stays within `budget` in all; the rest keep their previews.
 */
function giveWholeText(page: ChatTranscriptPart[], parts: Part[], budget: number) {
  let spent = page.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0);
  for (const [index, part] of parts.entries()) {
    const described = page[index]!;
    if (part.kind !== 'text' || part.encoding !== 'utf8' || !isAvailable(part)) continue;
    if (!described.truncated) continue;
    const next = spent - Buffer.byteLength(described.text) + part.value.length;
    if (next > budget) continue;
    page[index] = { ...described, text: part.value.toString('utf8'), truncated: false };
    spent = next;
  }
}
function describePart(part: Part): ChatTranscriptPart {
  const bytes = part.value.length;
  return {
    partId: part.id,
    kind: part.kind,
    role: part.role,
    availability: 'available',
    encoding: part.encoding,
    bytes,
    revision: getRevision(part),
    ...(part.encoding === 'utf8'
      ? (part.memo.preview ??= previewText(
          part.value.subarray(0, previewWindowBytes).toString('utf8'),
          256,
        ))
      : { text: '', truncated: bytes > 0 }),
    ...part.extra,
  };
}
type TranscriptValue = {
  id: string;
  kind: ChatTranscriptPart['kind'];
  role: ChatTranscriptPart['role'];
  value: string | { json: unknown } | { image: string };
  extra: Partial<ChatTranscriptPart>;
};
type TranscriptTextStep = {
  position: FindPartPosition;
  next: FindPartPosition;
  part: TranscriptValue | null;
};
function makeValuePart({ id, kind, role, value, extra }: TranscriptValue): Part {
  if (typeof value === 'string') return makePart(id, kind, role, value, extra);
  if ('json' in value) return makePart(id, kind, role, JSON.stringify(value.json), extra);
  const image = Buffer.from(value.image, 'base64');
  return image.toString('base64') === value.image
    ? makePart(id, kind, role, image, extra)
    : makePart(id, kind, role, Buffer.alloc(0), { ...extra, availability: 'unavailable' });
}
function* buildMessageParts(messages: readonly Message[], prefix: string): Generator<Part> {
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

function summarizeThinking(parts: readonly Part[]): ChatTranscript['thinking'] {
  const thinking = parts.filter((part) => part.kind === 'thinking');
  if (thinking.some(isAvailable)) return 'available';
  return thinking.length ? 'redacted' : 'none';
}
type EntryTranscript = {
  /** Saved entries never move, so a cached transcript can authorize its own reads. */
  conversationId: EntryRecord['conversationId'];
  parts: Part[];
  thinking: ChatTranscript['thinking'];
};
const entryTranscripts = new WeakMap<Harness, LRUCache<string, EntryTranscript>>();
function getEntryCache(harness: Harness) {
  let cache = entryTranscripts.get(harness);
  if (!cache) {
    cache = new LRUCache<string, EntryTranscript>({
      maxSize: entryCacheBytes,
      // Parts are immutable once built, so this size never changes after insertion.
      sizeCalculation: (transcript) =>
        transcript.parts.reduce(
          (size, part) => size + part.value.length + partOverheadBytes,
          partOverheadBytes,
        ),
    });
    entryTranscripts.set(harness, cache);
  }
  return cache;
}
async function getEntryTranscript(
  harness: Harness,
  entry: EntryRecord,
  signal?: AbortSignal,
): Promise<EntryTranscript> {
  const cache = getEntryCache(harness);
  const cached = cache.get(String(entry.id));
  if (cached) return cached;
  signal?.throwIfAborted();
  const pairing = (await getPairing(harness, entry, signal)) ?? { pairing: 'unmatched' as const };
  signal?.throwIfAborted();
  const diagnostics = ToolResultEntry.is(entry) ? (entry.data?.diagnostics ?? []) : [];
  const interrupted = diagnostics.some(
    (item) => item.code === 'aborted' || item.code === 'interrupted',
  );
  const parts: Part[] = [];
  for (const { part } of getEntryTextValues(entry)) {
    if (!part) continue;
    signal?.throwIfAborted();
    const built = makeValuePart(part);
    if (built.role === 'tool')
      built.extra = {
        ...built.extra,
        ...pairing,
        ...(interrupted ? { state: 'interrupted' as const } : {}),
      };
    parts.push(built);
    if (signal && parts.length % partsPerTurn === 0) await setImmediate();
  }
  const transcript = {
    conversationId: entry.conversationId,
    parts,
    thinking: summarizeThinking(parts),
  };
  cache.set(String(entry.id), transcript);
  return transcript;
}
/** Reads a saved entry's transcript, loading the record only when it is not cached. */
async function readSavedTranscript(
  harness: Harness,
  target: ChatTarget,
  entryId: string,
  signal?: AbortSignal,
) {
  const cached = getEntryCache(harness).get(String(eid(entryId)));
  if (!cached)
    return getEntryTranscript(harness, await readEntry(harness, target, entryId), signal);
  if (cached.conversationId !== cid(target.conversationId))
    return fail('InvalidInput', 'Entry does not belong to this conversation.');
  return cached;
}

async function readNestedCall(
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
    return fail('Persistence', 'Nested tool authority is invalid.');
  const input = task.input as ToolTaskInput;
  if (
    input.kind !== 'nested' ||
    input.parent !== tool.parentTaskId ||
    input.parentCallId !== tool.parentCallId ||
    input.call.id !== tool.callId ||
    input.call.name !== tool.name ||
    tool.callId !== `${input.parentCallId}/${input.key}`
  )
    return fail('Persistence', 'Nested tool call identity is invalid.');
  const parent = await harness.getTask(input.parent, context);
  signal?.throwIfAborted();
  if (!parent || parent.kind !== 'pi.tool' || parent.conversationId !== task.conversationId)
    return fail('Persistence', 'Nested tool parent authority is invalid.');
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
      return fail('Persistence', 'Nested tool parent authority is invalid.');
    if (currentParent.state.status === 'terminal' || currentParent.state.status === 'completing')
      throw new NestedSourceRetired();
    return fail('Conflict', 'Nested tool source is unavailable; reload the consistent view.');
  }
  if (record.taskId !== task.id || (record.result && record.result.taskId !== task.id))
    return fail('Persistence', 'Retained nested result identity is invalid.');
  if (tool.status === 'done' && tool.summary && !record.result)
    return fail('Conflict', 'Retained nested result is unavailable; reload the source.');
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
type TranscriptParts = {
  /** Parts in display order; live sources build each one only when a reader reaches it. */
  parts: Iterable<Part> | AsyncIterable<Part>;
  thinking: ChatTranscript['thinking'];
};
async function getLiveTranscript(
  harness: Harness,
  source: ChatTranscriptSource,
  { signal, capture: captured }: { signal?: AbortSignal; capture?: TranscriptCapture } = {},
): Promise<TranscriptParts> {
  const capture = captured ?? (await captureTranscript(harness, source.target));
  signal?.throwIfAborted();
  const actual = getLiveSource(harness, source.target, capture);
  if (!actual || hashJson(actual) !== hashJson(source))
    return fail('Conflict', 'Transcript source changed; reload the consistent view.');
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
      fail('Persistence', 'Live tool authority is invalid.');
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
        return fail('Persistence', 'Recorded tool result is unavailable.');
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
/**
 * A manifest cursor binds the ordered part IDs and kinds before its position, so values may grow
 * and later parts may appear without invalidating it; per-selection revisions cover content.
 */
async function projectManifest(
  harness: Harness,
  source: ChatTranscriptSource,
  transcript: TranscriptParts,
  start: number,
  limit: number,
  revision?: string,
  /** A running response's page carries its text parts whole within this many bytes of text. */
  wholeTextBytes?: number,
): Promise<ChatTranscript> {
  const seen: [string, ChatTranscriptPart['kind']][] = [];
  const page: ChatTranscriptPart[] = [];
  const pageParts: Part[] = [];
  let more = false;
  for await (const part of transcript.parts) {
    if (seen.length === start + limit) {
      more = true;
      break;
    }
    if (seen.length >= start) {
      page.push(describePart(part));
      pageParts.push(part);
    }
    seen.push([part.id, part.kind]);
  }
  if (wholeTextBytes !== undefined) giveWholeText(page, pageParts, wholeTextBytes);
  if (
    revision !== undefined &&
    (seen.length < start || hashJson(seen.slice(0, start)) !== revision)
  )
    fail('Conflict', 'Transcript manifest changed; reload the source.');
  return {
    source,
    parts: page,
    nextCursor: more
      ? sealCursor(harness, {
          kind: 'manifest',
          binding: hashJson(source),
          revision: hashJson(seen),
          position: seen.length,
        })
      : null,
    thinking: transcript.thinking,
  };
}
export async function projectEntryTranscript(
  harness: Harness,
  target: ChatTarget,
  entry: EntryRecord,
  signal?: AbortSignal,
) {
  const source: ChatTranscriptSource = { kind: 'entry', target, entryId: String(entry.id) };
  return projectManifest(
    harness,
    source,
    await getEntryTranscript(harness, entry, signal),
    0,
    embeddedManifestParts,
  );
}
export async function projectLiveTranscript(
  harness: Harness,
  source: ChatTranscriptSource,
  captured: TranscriptCapture,
) {
  return projectManifest(
    harness,
    source,
    await getLiveTranscript(harness, source, { capture: captured }),
    0,
    embeddedManifestParts,
    undefined,
    chatLiveTextBytes,
  );
}
async function findPart(parts: TranscriptParts['parts'], partId: string) {
  for await (const part of parts) if (part.id === partId) return part;
  return undefined;
}
/** Checks that the selection's fixed prefix still matches the part's value. */
function checkSelection(part: Part | undefined, selection: ChatTranscriptSelection): Part {
  if (!part || !isAvailable(part))
    return fail('InvalidInput', 'Transcript part is unavailable or invalid.');
  if (
    selection.bytes > part.value.length ||
    (selection.bytes === part.value.length
      ? getRevision(part)
      : hashPrefix(part, selection.bytes)) !== selection.revision
  )
    return fail('Conflict', 'Transcript prefix changed; reload the selected part.');
  return part;
}
async function readSelectedPart(
  harness: Harness,
  source: ChatTranscriptSource,
  selection: ChatTranscriptSelection,
  signal?: AbortSignal,
) {
  if (source.kind === 'entry') {
    const transcript = await readSavedTranscript(harness, source.target, source.entryId, signal);
    return checkSelection(
      transcript.parts.find((part) => part.id === selection.partId),
      selection,
    );
  }
  const transcript = await getLiveTranscript(harness, source, { signal });
  const part = checkSelection(await findPart(transcript.parts, selection.partId), selection);
  // A live selection is served only while its source is still current.
  const current = await findPart(
    (await getLiveTranscript(harness, source, { signal })).parts,
    selection.partId,
  );
  if (!current || !isAvailable(current))
    fail('Conflict', 'Transcript part disappeared; reload the source.');
  checkSelection(current, selection);
  signal?.throwIfAborted();
  return part;
}
export async function readTranscriptContent(
  harness: Harness,
  input: ChatInput<'getChatTranscriptContent'>,
  signal?: AbortSignal,
): Promise<ChatOutput<'getChatTranscriptContent'>> {
  const { source, selection } = input;
  signal?.throwIfAborted();
  if (!selection) {
    const cursor = input.cursor
      ? openCursor(harness, input.cursor, 'manifest', hashJson(source))
      : undefined;
    const transcript =
      source.kind === 'entry'
        ? await readSavedTranscript(harness, source.target, source.entryId, signal)
        : await getLiveTranscript(harness, source, { signal });
    signal?.throwIfAborted();
    return {
      kind: 'manifest',
      cursor: input.cursor ?? null,
      ...(await projectManifest(
        harness,
        source,
        transcript,
        cursor?.position ?? 0,
        chatManifestPageSize,
        cursor ? (cursor.revision ?? '') : undefined,
      )),
    };
  }
  const binding = hashJson({ source, selection });
  const offset = input.cursor ? openCursor(harness, input.cursor, 'content', binding).position : 0;
  const part = await readSelectedPart(harness, source, selection, signal);
  signal?.throwIfAborted();
  if (offset > selection.bytes) fail('InvalidInput', 'Invalid content position.');
  const bytes = part.value;
  let end = Math.min(offset + chatContentChunkBytes, selection.bytes);
  if (part.encoding === 'utf8') {
    while (end < selection.bytes && (bytes[end] & 0xc0) === 0x80) end--;
    if (
      (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) ||
      (selection.bytes < bytes.length && (bytes[selection.bytes] & 0xc0) === 0x80)
    )
      fail('InvalidInput', 'Content selection splits Unicode.');
  }
  return {
    kind: 'content',
    cursor: input.cursor ?? null,
    source,
    selection,
    offset,
    encoding: part.encoding,
    data: bytes.subarray(offset, end).toString(part.encoding),
    nextCursor:
      end < selection.bytes
        ? sealCursor(harness, { kind: 'content', binding, position: end })
        : null,
  };
}
