import { setImmediate } from 'node:timers/promises';
import type { Harness } from '@earendil-works/pi-durable';
import {
  maximumChatReplyBytes,
  chatFindPageSize,
  getChatFindExpression,
  type ChatInput,
  type ChatOutput,
} from '@moonbase/contracts/chat';
import {
  getEntryTextValues,
  hashJson,
  openCursor,
  scanAdjacentEntry,
  sealCursor,
} from './transcript.ts';
import {
  maximumFindPathChars,
  maximumFindPathDepth,
  type TranscriptCursor,
} from './private-schema.ts';
import * as V from './validation.ts';

const windowSize = 16 * 1024;
const sliceBytes = 256 * 1024;
/** Work one Find invocation may do before returning a continuation. */
const entriesPerSlice = 32;
const partsPerSlice = 32;
const chunkUnits = 4096;
const tokensPerTurn = 32;
/** One token adds at most three path elements to its node, each a safe integer and a comma. */
const tokenPathChars = 3 * 17;
type Token = { path: number[]; text: string };
const isBefore = (path: number[], seek: number[]) => {
  for (let i = 0; i < Math.min(path.length, seek.length); i++)
    if (path[i] !== seek[i]) return path[i] < seek[i];
  return false;
};
const alignBoundary = (text: string, offset: number) =>
  offset > 0 && /[\udc00-\udfff]/.test(text[offset] ?? '') ? offset - 1 : offset;
const sliceChunk = (text: string, index: number) =>
  text.slice(
    alignBoundary(text, index * chunkUnits),
    alignBoundary(text, Math.min(text.length, (index + 1) * chunkUnits)),
  );

/** JSON.stringify's display format, traversable at token paths without serializing earlier values. */
function* jsonTokens(value: unknown, seek: number[], path: number[] = []): Generator<Token> {
  if (isBefore(path, seek)) return;
  const position = path.every((item, index) => seek[index] === item)
    ? seek[path.length]
    : undefined;
  const emit = function* (text: string, position: number): Generator<Token> {
    const next = [...path, position];
    if (!isBefore(next, seek)) yield { path: next, text };
  };
  if (typeof value === 'string') {
    yield* emit('"', 0);
    const count = Math.ceil(value.length / chunkUnits);
    for (let i = Math.max(0, (position ?? 1) - 1); i < count; i++)
      yield* emit(JSON.stringify(sliceChunk(value, i)).slice(1, -1), i + 1);
    yield* emit('"', count + 1);
  } else if (
    value !== null &&
    typeof value === 'object' &&
    (path.length + 3 > maximumFindPathDepth ||
      JSON.stringify(path).length + tokenPathChars > maximumFindPathChars)
  ) {
    // Deeper token paths could not fit a cursor, so this subtree resumes by serialized chunk.
    const text = JSON.stringify(value);
    const count = Math.ceil(text.length / chunkUnits);
    for (let i = position ?? 0; i < count; i++) yield* emit(sliceChunk(text, i), i);
  } else if (value !== null && typeof value === 'object') {
    const array = Array.isArray(value);
    const keys = array ? undefined : Object.keys(value);
    const length = array ? value.length : keys!.length;
    yield* emit(array ? '[' : '{', 0);
    const start = Math.max(0, Math.floor(((position ?? 1) - 1) / 2));
    for (let i = start; i < length; i++) {
      const key = keys?.[i];
      if (array) yield* emit(i ? ',' : '', 1 + 2 * i);
      else {
        const keyPath = [...path, 1 + 2 * i];
        const punctuation = (text: string, index: number): Token => ({
          path: [...keyPath, index],
          text,
        });
        const comma = punctuation(i ? ',' : '', 0);
        if (!isBefore(comma.path, seek)) yield comma;
        yield* jsonTokens(key, seek, [...keyPath, 1]);
        const colon = punctuation(':', 2);
        if (!isBefore(colon.path, seek)) yield colon;
      }
      yield* jsonTokens(array ? value[i] : (value as Record<string, unknown>)[key!], seek, [
        ...path,
        2 + 2 * i,
      ]);
    }
    yield* emit(array ? ']' : '}', 2 * length + 1);
  } else yield* emit(JSON.stringify(value) ?? 'null', 0);
}

type Position = { path: number[]; offset: number; textOffset: number };
async function readWindow(
  value: string | { json: unknown },
  position: Position,
  limit: number,
  signal?: AbortSignal,
) {
  const tokens =
    typeof value === 'string'
      ? (function* () {
          yield { path: [], text: value };
        })()
      : jsonTokens(value.json, position.path);
  const segments: { token: Token; offset: number; start: number; length: number }[] = [];
  let text = '',
    count = 0,
    done = true;
  for (const token of tokens) {
    signal?.throwIfAborted();
    if (++count % tokensPerTurn === 0) await setImmediate();
    const offset =
      JSON.stringify(token.path) === JSON.stringify(position.path) ? position.offset : 0;
    const end = alignBoundary(
      token.text,
      Math.min(token.text.length, offset + limit - text.length),
    );
    const piece = token.text.slice(offset, end);
    segments.push({ token, offset, start: text.length, length: piece.length });
    text += piece;
    if (text.length >= limit - 1) {
      done = false;
      break;
    }
  }
  return {
    text,
    done,
    at(index: number): Position {
      const segment = segments.findLast((item) => item.start <= index);
      return segment
        ? {
            path: segment.token.path,
            offset: segment.offset + index - segment.start,
            textOffset: position.textOffset + index,
          }
        : position;
    },
  };
}

/** Saved entries only. Every invocation is reauthorized by Host before opening a continuation. */
export async function findTranscript(
  harness: Harness,
  input: ChatInput<'findChatTranscript'>,
  signal?: AbortSignal,
): Promise<ChatOutput<'findChatTranscript'>> {
  const { target, query } = input;
  const binding = hashJson({ operation: 'findChatTranscript', target, query });
  const cursor = input.cursor ? openCursor(harness, input.cursor, 'find', binding) : undefined;
  const upper = cursor
    ? (cursor.upper ?? null)
    : String((await scanAdjacentEntry(harness, target, 'older'))?.id ?? '') || null;
  signal?.throwIfAborted();
  const start: TranscriptCursor = {
    kind: 'find',
    binding,
    position: 1,
    ...(upper ? { upper } : {}),
    part: { message: 0, block: 0, auxiliary: 0 },
    path: [],
    offset: 0,
    textOffset: 0,
    entries: 0,
    bytes: 0,
  };
  let next = cursor ?? start;
  const startCursor = sealCursor(harness, start);
  const matches: ChatOutput<'findChatTranscript'>['matches'] = [];
  const expression = getChatFindExpression(query);
  let rows = 0,
    examined = 0,
    parts = 0;
  const reply = (complete: boolean) =>
    V.sized({
      target,
      query,
      cursor: input.cursor ?? null,
      startCursor,
      upperEntryId: upper,
      matches,
      progress: { entries: next.entries ?? 0, bytes: next.bytes ?? 0 },
      nextCursor: complete ? null : sealCursor(harness, next),
    });
  while (
    upper &&
    next.position <= Number(upper) &&
    rows < entriesPerSlice &&
    examined < sliceBytes &&
    parts < partsPerSlice
  ) {
    signal?.throwIfAborted();
    const entry = await scanAdjacentEntry(harness, target, 'newer', next.position, upper);
    signal?.throwIfAborted();
    if (!entry) return reply(true);
    rows++;
    next = { ...next, position: Number(entry.id), entries: (next.entries ?? 0) + 1 };
    let finished = true;
    for (const step of getEntryTextValues(entry, next.part)) {
      signal?.throwIfAborted();
      if (parts++ >= partsPerSlice || examined >= sliceBytes) {
        next = { ...next, part: step.position };
        finished = false;
        break;
      }
      const part = step.part;
      if (
        !part ||
        (part.extra.availability && part.extra.availability !== 'available') ||
        (typeof part.value !== 'string' && 'image' in part.value)
      ) {
        next = { ...next, part: step.next, path: [], offset: 0, textOffset: 0 };
        continue;
      }
      const value = part.value as string | { json: unknown };
      if (typeof value === 'string' && !value.isWellFormed()) {
        next = { ...next, part: step.next, path: [], offset: 0, textOffset: 0 };
        continue;
      }
      const position = {
        path: [...(next.path ?? [])],
        offset: next.offset ?? 0,
        textOffset: next.textOffset ?? 0,
      };
      const scanLength = Math.min(
        windowSize,
        Math.floor((sliceBytes - examined) / 4) - query.length,
      );
      if (scanLength < 1) {
        next = { ...next, part: step.position };
        finished = false;
        break;
      }
      const window = await readWindow(value, position, scanLength + query.length + 256, signal);
      const text = window.text;
      let consumed =
        window.done && text.length <= scanLength
          ? text.length
          : alignBoundary(text, Math.min(scanLength, text.length));
      let envelopeFull = false;
      expression.lastIndex = 0;
      for (
        let match = expression.exec(text);
        match && match.index < consumed;
        match = expression.exec(text)
      ) {
        const end = match.index + match[0].length;
        consumed = Math.max(consumed, end);
        const snippetStart = alignBoundary(text, Math.max(0, match.index - 80));
        const snippetEnd = alignBoundary(text, Math.min(text.length, end + 80));
        const candidate: ChatOutput<'findChatTranscript'>['matches'][number] = {
          source: { kind: 'entry', target, entryId: String(entry.id) },
          partId: part.id,
          start: position.textOffset + match.index,
          end: position.textOffset + end,
          snippet: {
            start: position.textOffset + snippetStart,
            text: text.slice(snippetStart, snippetEnd),
          },
        };
        const envelopeBytes =
          Buffer.byteLength(
            JSON.stringify({
              target,
              query,
              cursor: input.cursor ?? null,
              startCursor,
              upperEntryId: upper,
              matches: [...matches, candidate],
            }),
          ) + 4096;
        if (envelopeBytes >= maximumChatReplyBytes - 256) {
          if (!matches.length && match.index === 0)
            V.fail('InvalidInput', 'Find match exceeds its delivery limit.');
          consumed = match.index;
          envelopeFull = true;
          break;
        }
        matches.push(candidate);
        if (matches.length === chatFindPageSize) {
          consumed = end;
          break;
        }
      }
      const bytes = Buffer.byteLength(text.slice(0, consumed));
      examined += bytes;
      next = {
        ...next,
        ...window.at(consumed),
        bytes: (next.bytes ?? 0) + bytes,
        part: step.position,
      };
      if (window.done && consumed === text.length)
        next = { ...next, part: step.next, path: [], offset: 0, textOffset: 0 };
      else finished = false;
      if (envelopeFull || matches.length === chatFindPageSize) return reply(false);
      if (!finished) break;
      await setImmediate();
    }
    if (finished)
      next = {
        ...next,
        position: Number(entry.id) + 1,
        part: { message: 0, block: 0, auxiliary: 0 },
        path: [],
        offset: 0,
        textOffset: 0,
      };
    else break;
  }
  signal?.throwIfAborted();
  return reply(!upper || next.position > Number(upper));
}
