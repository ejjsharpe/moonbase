import { normalizeApplicationError } from '@moonbase/application/runtime/effect-client';
import {
  decodeApplicationErrorDTO,
  type ApplicationErrorDTOSchema,
} from '@moonbase/contracts/error-schema';
import { isChatCommand } from '@moonbase/contracts/chat-schema';
import {
  decodeConnectionOutput,
  decodeConnectionSnapshot,
  isConnectionCommand,
} from '@moonbase/contracts/connection-schema';
import { cancellation, unwrap as unwrapReply } from '../wire.ts';
import { ApplicationError } from '@moonbase/contracts/workspace';
import type {
  ChatClient,
  ChatSession,
  ChatTranscriptSource,
  ChatTranscriptSelection,
} from '@moonbase/contracts/chat';
import type { ProviderSetupClient } from '@moonbase/contracts/providers';
import { decodeProviderOutput, isProviderCommand } from '@moonbase/contracts/providers-schema';
import type { ConnectionClient } from '@moonbase/contracts/connection';

export const channels = {
  call: 'moonbase-chat:call',
  cancel: 'moonbase-chat:cancel',
  event: 'moonbase-chat:event',
} as const;
export type Reply =
  | { ok: true; value: unknown }
  | { ok: false; error: typeof ApplicationErrorDTOSchema.Type };
export type DesktopChatTarget = {
  id: string;
  label: string;
  mode: 'local' | 'remote';
  context: ChatSession;
};
export type TranscriptCopy = {
  source: ChatTranscriptSource;
  selection?: ChatTranscriptSelection;
  /** Parser-provided original UTF-16 start within the selected part; main revalidates the node. */
  code?: { start: number };
};
export type TranscriptNative = {
  copy(input: TranscriptCopy, signal?: AbortSignal): Promise<void>;
  openLink(url: string, signal?: AbortSignal): Promise<void>;
};

export interface ChatBridge {
  targets?(): Promise<DesktopChatTarget[]>;
  chooseFolder?(): Promise<string | null>;
  confirmQuit?(): Promise<boolean>;
  context(backendId?: string): Promise<ChatSession>;
  call(
    kind: 'chat' | 'connection' | 'watch-chat' | 'watch-connection' | 'providers' | 'transcript',
    operation: string,
    input: unknown,
    id: string,
    backendId?: string,
  ): Promise<Reply>;
  cancel(id: string, backendId?: string): Promise<Reply>;
  events(receive: (id: string, result: Reply, backendId?: string) => void): () => void;
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
export function browserClients(
  bridge: ChatBridge,
  backendId = 'remote',
): {
  chat: ChatClient;
  connection: ConnectionClient;
  providers: ProviderSetupClient;
} {
  const command = async (
    kind: 'chat' | 'connection' | 'providers' | 'transcript',
    operation: string,
    input: unknown,
    options?: { signal?: AbortSignal },
  ) => {
    if (options?.signal?.aborted)
      throw new ApplicationError({ code: 'Cancelled', message: 'Command cancelled' });
    const id = crypto.randomUUID(),
      cancel = () => {
        void bridge
          .cancel(id, backendId)
          .then(cancellation)
          .catch(() => {});
      };
    options?.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const value = unwrap(await bridge.call(kind, operation, input, id, backendId));
      if (kind === 'providers' && isProviderCommand(operation)) return value;
      // Main's ChatClient boundary (Pi runtime) already decoded and bounded chat replies.
      if (kind === 'chat' && isChatCommand(operation)) return value;
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
    const off = bridge.events((eventId, result, eventBackend = 'remote') => {
      if (active && eventId === id && eventBackend === backendId)
        try {
          receive(
            (kind === 'watch-chat'
              ? unwrap(result)
              : decodeConnectionSnapshot(unwrap(result))) as never,
          );
        } catch (e) {
          onError(normalizeApplicationError(e));
        }
    });
    const started = bridge.call(kind, '', input, id, backendId);
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
            cancellation(await bridge.cancel(id, backendId));
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
    providers: {
      command: async (op, input, options) =>
        decodeProviderOutput(op, await command('providers', op, input, options)),
    },
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

/** Capture this backend once; selected UI target changes cannot reroute a pending action. */
export function browserTranscriptActions(bridge: ChatBridge, backendId: string): TranscriptNative {
  const call = async (operation: string, input: unknown, signal?: AbortSignal) => {
    if (signal?.aborted)
      throw new ApplicationError({ code: 'Cancelled', message: 'Action cancelled.' });
    const id = crypto.randomUUID();
    const cancel = () => {
      void bridge
        .cancel(id, backendId)
        .then(cancellation)
        .catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      unwrap(await bridge.call('transcript', operation, input, id, backendId));
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
  return {
    copy: (input, signal) => call('copy', input, signal),
    openLink: (url, signal) => call('open-link', { url }, signal),
  };
}
