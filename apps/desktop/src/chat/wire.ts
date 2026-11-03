import { normalizeApplicationError } from '@moonbase/application/runtime/effect-client';
import {
  decodeApplicationErrorDTO,
  type ApplicationErrorDTOSchema,
} from '@moonbase/contracts/error-schema';
import { decodeChatOutput, isChatCommand } from '@moonbase/contracts/chat-schema';
import {
  decodeConnectionOutput,
  decodeConnectionSnapshot,
  isConnectionCommand,
} from '@moonbase/contracts/connection-schema';
import { cancellation, unwrap as unwrapReply } from '../wire.ts';
import { ApplicationError } from '@moonbase/contracts/workspace';
import type { ChatClient, ChatSession } from '@moonbase/contracts/chat';
import type { ConnectionClient } from '@moonbase/contracts/connection';

export const channels = {
  call: 'moonbase-chat:call',
  cancel: 'moonbase-chat:cancel',
  event: 'moonbase-chat:event',
} as const;
export type Reply =
  | { ok: true; value: unknown }
  | { ok: false; error: typeof ApplicationErrorDTOSchema.Type };
export interface ChatBridge {
  context(): Promise<ChatSession>;
  call(
    kind: 'chat' | 'connection' | 'watch-chat' | 'watch-connection',
    operation: string,
    input: unknown,
    id: string,
  ): Promise<Reply>;
  cancel(id: string): Promise<Reply>;
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
export function errorDTO(value: unknown): Extract<Reply, { ok: false }> {
  const e = normalizeApplicationError(value);
  return { ok: false, error: { code: e.code, message: e.message.slice(0, 512) } };
}
export function unwrap(reply: Reply): unknown {
  if (!reply.ok) {
    const dto = decodeApplicationErrorDTO(reply.error);
    if (dto.message.length > 512)
      throw new ApplicationError({ code: 'Incompatible', message: 'Malformed desktop error.' });
  }
  return unwrapReply(reply);
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
      cancel = () => {
        void bridge
          .cancel(id)
          .then(cancellation)
          .catch(() => {});
      };
    options?.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const value = unwrap(await bridge.call(kind, operation, input, id));
      if (kind === 'chat' && isChatCommand(operation)) return decodeChatOutput(operation, value);
      if (kind === 'connection' && isConnectionCommand(operation))
        return decodeConnectionOutput(operation, value);
      return invalid();
    } catch (error) {
      throw normalizeApplicationError(error);
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
          receive(
            (kind === 'watch-chat'
              ? decodeChatOutput('getChat', unwrap(result))
              : decodeConnectionSnapshot(unwrap(result))) as never,
          );
        } catch (e) {
          onError(normalizeApplicationError(e));
        }
    });
    const started = bridge.call(kind, '', input, id);
    void started.then(
      (r) => {
        if (active && !r.ok) onError(normalizeApplicationError(unwrapError(r)));
      },
      (e) => {
        if (active) onError(normalizeApplicationError(e));
      },
    );
    let completion: Promise<void> | undefined;
    return () => {
      active = false;
      completion ??= started.then(
        async () => {
          try {
            cancellation(await bridge.cancel(id));
          } finally {
            off();
          }
        },
        (error) => {
          off();
          throw normalizeApplicationError(error);
        },
      );
      return completion;
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
