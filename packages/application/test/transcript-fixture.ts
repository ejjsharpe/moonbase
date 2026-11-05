import { createHash } from 'node:crypto';
import { ApplicationError } from '@moonbase/contracts/errors';
import type {
  ChatClient,
  ChatEntry,
  ChatInput,
  ChatOutput,
  ChatSnapshot,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import type { ChatDependencies } from '@moonbase/application/chat';
import { chatCapabilities } from './chat-capabilities.ts';
import { modelRoot } from './chat-model-fixture.ts';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const part = (partId: string, text: string): ChatTranscriptPart => ({
  partId,
  bytes: Buffer.byteLength(text),
  revision: digest(text),
  role: 'assistant',
  kind: 'text',
  availability: 'available',
  encoding: 'utf8',
  text: text.slice(0, 64),
  truncated: text.length > 64,
});
export function transcriptFixture(count = 640, local = true) {
  const base = chatCapabilities();
  const target = base.target;
  const sources = new Map<string, { source: ChatTranscriptSource; data: string[] }>();
  const entries: ChatEntry[] = Array.from({ length: count }, (_, index) => {
    const id = `e${index}`,
      source: ChatTranscriptSource = { kind: 'entry', target, entryId: id },
      data = ['same text'];
    sources.set(JSON.stringify(source), { source, data });
    return {
      id,
      role: 'assistant',
      text: 'same text',
      truncated: false,
      transcript: { source, parts: [part('m0.b0', data[0])], nextCursor: null, thinking: 'none' },
    };
  });
  let snapshot: ChatSnapshot = {
    ...base.snapshot,
    entries: entries.slice(-32).reverse(),
    olderCursor: count > 32 ? String(count - 32) : null,
    transcriptBoundary: entries.at(-1)?.id ?? null,
  };
  let receive = (_value: ChatSnapshot) => {},
    onError = (_error: ApplicationError) => {};
  const calls: { operation: string; input: unknown; signal?: AbortSignal }[] = [];
  const handlers = new Map<
    string,
    (input: never, signal: AbortSignal | undefined, fallback: () => unknown) => Promise<unknown>
  >();
  let watchCloses = 0;
  function fallback(operation: string, input: unknown): unknown {
    if (operation === 'getChatHost')
      return {
        ...base.dependencies.context,
        features: ['transcript-v1', 'chat-stream-v1', 'transcript-find-v1'],
        ...(local ? { mode: 'local' } : { cwd: '/controlled', model: 'controlled' }),
      };
    if (operation === 'listChats')
      return { conversations: [snapshot.conversation], nextCursor: null };
    if (operation === 'getChat') return structuredClone(snapshot);
    if (operation === 'findChatTranscript') {
      const request = input as ChatInput<'findChatTranscript'>;
      const position = request.cursor
        ? (JSON.parse(request.cursor) as {
            upper: number;
            index: number;
            part: number;
            offset: number;
            bytes: number;
          })
        : { upper: entries.length, index: 0, part: 0, offset: 0, bytes: 0 };
      const startCursor = JSON.stringify({
        upper: position.upper,
        index: 0,
        part: 0,
        offset: 0,
        bytes: 0,
      });
      const matches: ChatOutput<'findChatTranscript'>['matches'] = [];
      const expression = new RegExp(request.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      let rows = 0;
      while (position.index < position.upper && rows++ < 32 && matches.length < 32) {
        const entry = entries[position.index],
          source = entry.transcript!.source;
        const data = sources.get(JSON.stringify(source))!.data;
        for (; position.part < data.length; position.part++, position.offset = 0) {
          expression.lastIndex = position.offset;
          let found: RegExpExecArray | null;
          while ((found = expression.exec(data[position.part]))) {
            const start = found.index,
              end = start + found[0].length;
            matches.push({
              source: source as never,
              partId: `m0.b${position.part}`,
              start,
              end,
              snippet: {
                start: Math.max(0, start - 30),
                text: data[position.part].slice(Math.max(0, start - 30), end + 30),
              },
            });
            position.offset = end;
            if (matches.length === 32) break;
          }
          if (matches.length === 32) break;
        }
        if (matches.length === 32) break;
        position.index++;
        position.part = 0;
        position.offset = 0;
      }
      position.bytes++;
      return {
        target: request.target,
        query: request.query,
        cursor: request.cursor ?? null,
        startCursor,
        upperEntryId: entries[position.upper - 1]?.id ?? null,
        matches,
        progress: { entries: position.index, bytes: position.bytes },
        nextCursor: position.index < position.upper ? JSON.stringify(position) : null,
      };
    }
    if (operation === 'getChatHistoryAround') {
      const request = input as ChatInput<'getChatHistoryAround'>;
      const index = entries.findIndex((entry) => entry.id === request.entryId);
      const range = request.cursor
        ? (JSON.parse(request.cursor) as { lo: number; hi: number; upper: number })
        : {
            lo: Math.max(0, index - 15),
            hi: Math.min(entries.length, index + 17),
            upper: entries.length,
          };
      const { lo, hi, upper } = range;
      return {
        ...request,
        cursor: request.cursor ?? null,
        upperEntryId: entries[upper - 1].id,
        entries: entries.slice(lo, hi).reverse(),
        olderCursor: lo ? JSON.stringify({ lo: Math.max(0, lo - 32), hi: lo, upper }) : null,
        newerCursor:
          hi < upper ? JSON.stringify({ lo: hi, hi: Math.min(upper, hi + 32), upper }) : null,
      };
    }
    if (operation === 'getChatTranscriptContent') {
      const request = input as ChatInput<'getChatTranscriptContent'>;
      const found = sources.get(JSON.stringify(request.source));
      if (!found) throw new ApplicationError({ code: 'Conflict', message: 'source changed' });
      if (!request.selection) {
        const offset = Number(request.cursor ?? 0),
          parts = found.data.map((text, index) => part(`m0.b${index}`, text));
        return {
          kind: 'manifest',
          source: request.source,
          cursor: request.cursor ?? null,
          parts: parts.slice(offset, offset + 32),
          nextCursor: offset + 32 < parts.length ? String(offset + 32) : null,
          thinking: 'none',
        };
      }
      const data = Buffer.from(found.data[Number(request.selection.partId.split('b')[1])]);
      const prefix = data.subarray(0, request.selection.bytes);
      if (
        prefix.length !== request.selection.bytes ||
        digest(prefix.toString()) !== request.selection.revision
      )
        throw new ApplicationError({ code: 'Conflict', message: 'prefix changed' });
      const offset = Number(request.cursor ?? 0),
        end = Math.min(request.selection.bytes, offset + 32768);
      return {
        kind: 'content',
        source: request.source,
        selection: request.selection,
        cursor: request.cursor ?? null,
        offset,
        data: data.subarray(offset, end).toString(),
        encoding: 'utf8',
        nextCursor: end < request.selection.bytes ? String(end) : null,
      };
    }
    if (operation === 'stopChat') return { ...(input as object), outcome: 'stopped' };
    if (operation === 'getChatSend') return null;
    throw Error(operation);
  }
  // Trusted ChatClient: it stands in for a boundary that already decoded and bounded replies.
  const chat: ChatClient = {
    async command(operation, input, options) {
      calls.push({ operation, input: structuredClone(input), signal: options?.signal });
      return structuredClone(
        await (handlers.get(operation)?.(input as never, options?.signal, () =>
          fallback(operation, input),
        ) ?? fallback(operation, input)),
      ) as never;
    },
    watch(_input, callback, error) {
      receive = callback;
      onError = error;
      return async () => {
        watchCloses++;
      };
    },
  };
  const dependencies = {
    ...base.dependencies,
    chat,
    mode: local ? ('local' as const) : ('remote' as const),
  };
  return {
    ...base,
    chat,
    dependencies,
    entries,
    calls,
    handlers,
    sources,
    get snapshot() {
      return snapshot;
    },
    publish(value: ChatSnapshot) {
      snapshot = structuredClone(value);
      receive(structuredClone(value));
    },
    fail(error: ApplicationError) {
      onError(error);
    },
    get watchCloses() {
      return watchCloses;
    },
  };
}
export async function transcriptController(
  t: { after: (close: () => Promise<void>) => void },
  count = 640,
  local = true,
  options: Pick<ChatDependencies, 'transcriptCloseGraceMs' | 'transcriptWatchRetryMs'> = {},
) {
  const fixture = transcriptFixture(count, local),
    root = modelRoot();
  t.after(() => root.close());
  const controller = await root.make({ ...fixture.dependencies, ...options });
  await controller.start();
  if (!local) await controller.connect();
  await controller.select(fixture.target);
  return { ...fixture, fixture, controller, root };
}
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export type ContentReply = Extract<ChatOutput<'getChatTranscriptContent'>, { kind: 'content' }>;
