import { createHash } from 'node:crypto';
import { Effect, Exit, Scope, Stream, SubscriptionRef } from 'effect';
import { TranscriptChangedError } from '@moonbase/contracts/chat-errors';
import type {
  ChatEntry,
  ChatInput,
  ChatOutput,
  ChatSnapshot,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import {
  defaultTranscriptLimits,
  TranscriptViewMemory,
  type TranscriptLimits,
  type TranscriptState,
} from '@moonbase/application/chat';
import {
  makeTranscript,
  type ChatPort,
  type Transcript,
  type TranscriptRead,
} from '@moonbase/application/chat';

export { scaledTranscriptLimits } from './transcript-limits-fixture.ts';
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
export const selection = (value: ChatTranscriptPart) => ({
  partId: value.partId,
  bytes: value.bytes,
  revision: value.revision,
});
/** Yields to timers and I/O once, for polling on state. */
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Polls `check` until it holds. */
export async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await tick();
  if (!check()) throw Error('The condition never held.');
}
export type ContentReply = Extract<ChatOutput<'getChatTranscriptContent'>, { kind: 'content' }>;
type Handler = (
  input: never,
  signal: AbortSignal | undefined,
  fallback: () => unknown,
) => Promise<unknown>;

/**
 * A chat host of `count` entries, each with one text part: its served snapshot holds the newest
 * 32, and its reads (history, Find, manifests and content) answer from the entries unless a test
 * sets a handler. It is trusted, like a boundary that already decoded and bounded replies.
 */
export function transcriptFixture(count = 640) {
  const context = { host: { hostId: 'host', storeId: 'store' }, actorId: 'actor' };
  const target = { ...context, conversationId: 'conversation' };
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
    conversation: {
      target,
      title: 'Conversation',
      cwd: '/remote',
      model: 'fake',
      createdAt: '2026-01-01T00:00:00Z',
    },
    state: 'idle',
    run: null,
    entries: entries.slice(-32).reverse(),
    olderCursor: count > 32 ? String(count - 32) : null,
    transcriptBoundary: entries.at(-1)?.id ?? null,
  };
  const calls: { operation: string; input: unknown; signal?: AbortSignal }[] = [];
  const handlers = new Map<string, Handler>();
  function fallback(operation: string, input: unknown): unknown {
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
      if (!found) throw new TranscriptChangedError({ change: 'view' });
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
        throw new TranscriptChangedError({ change: 'prefix' });
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
    throw Error(operation);
  }
  const command = async (operation: string, input: unknown, signal?: AbortSignal) => {
    calls.push({ operation, input: structuredClone(input), signal });
    return structuredClone(
      await (handlers.get(operation)?.(input as never, signal, () => fallback(operation, input)) ??
        fallback(operation, input)),
    ) as never;
  };
  // Interrupting a port read aborts its signal without waiting for the handler.
  const port = new Proxy({} as ChatPort, {
    get: (_port, operation: string) => (input: unknown) =>
      Effect.tryPromise({
        try: (signal) => command(operation, input, signal),
        catch: (error) => error as never,
      }),
  });
  // The content read a whole-source stream reads through.
  const read: TranscriptRead<unknown> = (input) => port.getChatTranscriptContent(input);
  return {
    target,
    read,
    port,
    entries,
    calls,
    handlers,
    sources,
    /** The snapshot `getChat` serves. */
    get snapshot() {
      return snapshot;
    },
    set snapshot(value: ChatSnapshot) {
      snapshot = structuredClone(value);
    },
  };
}

type Promised<T> = {
  [K in keyof T]: T[K] extends Effect.Effect<infer A, infer _E, never>
    ? () => Promise<A>
    : T[K] extends (...args: infer P) => Effect.Effect<infer A, infer _E, never>
      ? (...args: P) => Promise<A>
      : never;
};

/**
 * One open chat's transcript over `transcriptFixture`, as the selection opens it: in its own scope,
 * given the served snapshot, then restoring the remembered view. `state` is what it publishes now;
 * `publications` counts its changes as a subscriber sees them.
 */
export async function transcriptHarness(
  t: { after: (close: () => Promise<void>) => void },
  count = 640,
  options: { local?: boolean; limits?: Partial<TranscriptLimits> } = {},
) {
  const fixture = transcriptFixture(count);
  const limits = { ...defaultTranscriptLimits, ...options.limits };
  const memory = new TranscriptViewMemory();
  let model!: Transcript,
    scope!: Scope.Closeable,
    publications = 0;
  const harness = {
    ...fixture,
    fixture,
    limits,
    memory,
    /** The snapshot `getChat` serves, and the next opening accepts. */
    get snapshot() {
      return fixture.snapshot;
    },
    set snapshot(value: ChatSnapshot) {
      fixture.snapshot = value;
    },
    get state(): TranscriptState {
      return SubscriptionRef.getUnsafe(model.state);
    },
    /** The snapshot published with the state. */
    get published() {
      return SubscriptionRef.getUnsafe(model.state).snapshot;
    },
    get publications() {
      return publications;
    },
    transcript: new Proxy({} as Promised<Transcript>, {
      get: (_transcript, key: keyof Transcript) => {
        const value = model[key] as unknown;
        return Effect.isEffect(value)
          ? () => Effect.runPromise(value as Effect.Effect<unknown, unknown>)
          : (...args: unknown[]) =>
              Effect.runPromise((value as (...args: unknown[]) => Effect.Effect<unknown>)(...args));
      },
    }),
    /** Serves `value` and delivers it, as a watch does. */
    async publish(value: ChatSnapshot) {
      fixture.snapshot = value;
      await Effect.runPromise(model.acceptSnapshot(structuredClone(value)));
    },
    /** Closes the transcript's scope, as closing the chat does. */
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    /** Closes the transcript and opens the chat again, without restoring its view yet. */
    async reopen() {
      await harness.close();
      await open();
    },
  };
  async function open() {
    scope = Scope.makeUnsafe();
    model = await Effect.runPromise(
      Scope.provide(scope)(
        Effect.gen(function* () {
          const transcript = yield* makeTranscript({
            chat: fixture.port,
            target: structuredClone(fixture.target),
            backend: 'backend',
            memory,
            local: options.local ?? true,
            limits,
          });
          yield* SubscriptionRef.changes(transcript.state).pipe(
            Stream.drop(1),
            Stream.runForEach(() => Effect.sync(() => publications++)),
            Effect.forkScoped({ startImmediately: true }),
          );
          return transcript;
        }),
      ),
    );
    await Effect.runPromise(model.acceptSnapshot(structuredClone(fixture.snapshot)));
  }
  await open();
  await harness.transcript.restoreView();
  t.after(() => harness.close());
  return harness;
}
export type TranscriptHarness = Awaited<ReturnType<typeof transcriptHarness>>;
