import { randomBytes } from 'node:crypto';
import { Cause, Effect, Queue, Stream } from 'effect';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import type { ChatServiceShape } from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/workspace';

/** 32 random bytes in canonical base64url: a token, nonce or connection ID. */
export const nonce = () => randomBytes(32).toString('base64url');
export const host = { hostId: 'socket-host', storeId: 'socket-store' };
export const session = { host, actorId: 'owner' };
export const target = { ...session, conversationId: 'A' };

/** A chat whose run shows the end of `text`, after `entries` long entries that `seed` varies. */
export const snapshotOf = (text: string | null, entries = 0, seed = ''): ChatSnapshot => ({
  conversation: {
    target,
    title: 'A',
    createdAt: '2026-11-11T00:00:00Z',
    cwd: '/controlled',
    model: 'faux',
  },
  entries: Array.from({ length: entries }, (_, index) => ({
    id: `e${index}`,
    role: 'assistant' as const,
    text: `${seed}:${index}:`.padEnd(4000, 'x'),
    truncated: true,
    transcript: {
      source: { kind: 'entry' as const, target, entryId: `e${index}` },
      parts: [],
      nextCursor: null,
      thinking: 'none' as const,
    },
  })),
  olderCursor: null,
  run:
    text === null
      ? null
      : {
          stop: { target, submissionId: 's', taskId: 't' },
          state: 'running',
          text: text.slice(-64),
          truncated: text.length > 64,
        },
  state: text === null ? 'idle' : 'running',
  transcriptBoundary: null,
});

/** A chat service whose watches and commands the test drives. */
export function controlledChat() {
  const watches = new Set<Queue.Queue<ChatSnapshot, ApplicationError | Cause.Done>>(),
    calls: string[] = [];
  let current = snapshotOf('');
  let closes = 0;
  const handlers: Partial<Record<string, (input: never, signal: AbortSignal) => Promise<unknown>>> =
    {};
  const command = (operation: string) => (input: never) =>
    Effect.tryPromise({
      try: async (signal) => {
        calls.push(operation);
        if (operation === 'getChatHost') return { ...session, mode: 'local' };
        const handler = handlers[operation];
        if (handler) return handler(input, signal);
        if (operation === 'getChat') return current;
        if (operation === 'listChats') return { conversations: [], nextCursor: null };
        throw new ApplicationError({ code: 'Unavailable', message: 'Unexpected command.' });
      },
      catch: (error) =>
        ApplicationError.is(error)
          ? error
          : new ApplicationError({ code: 'Unavailable', message: 'Failed.' }),
    });
  const client = new Proxy(
    {
      watch: () =>
        Stream.callback<ChatSnapshot, ApplicationError>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              watches.add(queue);
              Queue.offerUnsafe(queue, current);
            }),
            () =>
              Effect.sync(() => {
                closes++;
                watches.delete(queue);
              }),
          ),
        ),
      watchChatList: () =>
        Stream.concat(
          Stream.make({
            list: { conversations: [], nextCursor: null },
            changed: [],
            dropped: 0,
            reset: false,
          }),
          Stream.never,
        ),
    } as unknown as Partial<ChatServiceShape>,
    { get: (target, name: string) => (name in target ? target[name as never] : command(name)) },
  ) as ChatServiceShape;
  return {
    client,
    calls,
    handlers,
    get closes() {
      return closes;
    },
    get watching() {
      return watches.size;
    },
    publish(snapshot: ChatSnapshot) {
      current = snapshot;
      for (const queue of watches) Queue.offerUnsafe(queue, snapshot);
    },
    /** Ends every open watch with `error`. */
    end(error: ApplicationError) {
      for (const queue of watches) Queue.failCauseUnsafe(queue, Cause.fail(error));
      watches.clear();
    },
  };
}
