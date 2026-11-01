import { ApplicationError, type ApplicationErrorCode } from '@moonbase/application/client';
import type { ChatClient, ChatSession } from '@moonbase/application/chat-client';
import type { ConnectionClient, ConnectionCommand } from '@moonbase/application/connection-client';

export const channels = {
  call: 'moonbase-chat:call',
  cancel: 'moonbase-chat:cancel',
  event: 'moonbase-chat:event',
} as const;
export type Reply =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: ApplicationErrorCode; message: string } };
export interface ChatBridge {
  context(): Promise<ChatSession>;
  call(
    kind: 'chat' | 'connection' | 'watch-chat' | 'watch-connection',
    operation: string,
    input: unknown,
    id: string,
  ): Promise<Reply>;
  cancel(id: string): void;
  events(receive: (id: string, result: Reply) => void): () => void;
}
export const invalid = (): never => {
  throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid chat request.' });
};
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: string[], required = allowed) {
  if (
    Object.keys(value).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    invalid();
}
export function requestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) invalid();
}
export function errorDTO(value: unknown): Reply {
  const e = ApplicationError.fromUnknown(value);
  return { ok: false, error: { code: e.code, message: e.message.slice(0, 512) } };
}
export function unwrap(reply: Reply): unknown {
  if (reply.ok) return reply.value;
  const codes = [
    'InvalidInput',
    'Unavailable',
    'Conflict',
    'Persistence',
    'Uncertain',
    'Cancelled',
    'Unauthorized',
    'Incompatible',
  ];
  if (
    !codes.includes(reply.error?.code) ||
    typeof reply.error.message !== 'string' ||
    reply.error.message.length > 512
  )
    throw new ApplicationError({ code: 'Incompatible', message: 'Malformed desktop error.' });
  throw new ApplicationError(reply.error);
}
export function browserClients(bridge: ChatBridge): {
  chat: ChatClient;
  connection: ConnectionClient;
} {
  const command = async (
    kind: 'chat' | 'connection',
    operation: string,
    input: unknown,
    options?: { signal?: AbortSignal },
  ) => {
    if (options?.signal?.aborted)
      throw new ApplicationError({ code: 'Cancelled', message: 'Command cancelled' });
    const id = crypto.randomUUID(),
      cancel = () => bridge.cancel(id);
    options?.signal?.addEventListener('abort', cancel, { once: true });
    try {
      return unwrap(await bridge.call(kind, operation, input, id));
    } finally {
      options?.signal?.removeEventListener('abort', cancel);
    }
  };
  const watch = (
    kind: 'watch-chat' | 'watch-connection',
    input: unknown,
    receive: (v: never) => void,
    onError: (e: ApplicationError) => void,
  ) => {
    const id = crypto.randomUUID();
    let active = true;
    const off = bridge.events((eventId, result) => {
      if (active && eventId === id)
        try {
          receive(unwrap(result) as never);
        } catch (e) {
          onError(ApplicationError.fromUnknown(e));
        }
    });
    void bridge.call(kind, '', input, id).then(
      (r) => {
        if (active && !r.ok) onError(ApplicationError.fromUnknown(unwrapError(r)));
      },
      (e) => {
        if (active) onError(ApplicationError.fromUnknown(e));
      },
    );
    return () => {
      if (active) {
        active = false;
        off();
        bridge.cancel(id);
      }
    };
  };
  return {
    chat: {
      command: (op, input, options) => command('chat', op, input, options) as never,
      watch: (input, receive, error) => watch('watch-chat', input, receive, error),
    },
    connection: {
      command: (op, input, options) => command('connection', op, input, options) as never,
      watch: (receive, error) => watch('watch-connection', {}, receive, error),
    },
  };
}
function unwrapError(r: Reply) {
  try {
    unwrap(r);
  } catch (e) {
    return e;
  }
  return Error('Invalid reply');
}
export const connectionFields: Record<ConnectionCommand, string[]> = {
  getConnection: [],
  connect: ['profileId'],
  disconnect: ['connectionId'],
};
