import { normalizeApplicationError } from '@moonbase/effect';
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
import { cancellation, errorDTO, unwrap as unwrapReply } from './wire.ts';
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
};
export type TranscriptCopy = {
  source: ChatTranscriptSource;
  selection?: ChatTranscriptSelection;
  /** Parser-provided original UTF-16 start within the selected part; main revalidates the node. */
  code?: { start: number };
};
/** Stored images larger than this are never read or previewed. */
export const maximumTranscriptImageBytes = 4 * 1024 * 1024;
/** Main binds an issued image URL to this exact backend, source and fixed selection. */
export type TranscriptImage = {
  source: ChatTranscriptSource;
  selection: ChatTranscriptSelection;
  mimeType: 'image/png' | 'image/jpeg';
};
export type TranscriptNative = {
  copy(input: TranscriptCopy, signal?: AbortSignal): Promise<void>;
  openLink(url: string, signal?: AbortSignal): Promise<void>;
  imageUrl(input: TranscriptImage, signal?: AbortSignal): Promise<string>;
};

/** Watches deliver values as events under their request ID until cancelled. */
export type ChatWatchKind =
  | 'watch-chat'
  | 'watch-chat-list'
  | 'watch-connection'
  | 'watch-providers';
export type ChatCallKind = 'chat' | 'connection' | 'providers' | 'transcript' | ChatWatchKind;
export const isChatWatchKind = (kind: unknown): kind is ChatWatchKind =>
  kind === 'watch-chat' ||
  kind === 'watch-chat-list' ||
  kind === 'watch-connection' ||
  kind === 'watch-providers';
export interface ChatBridge {
  targets?(): Promise<DesktopChatTarget[]>;
  chooseFolder?(): Promise<string | null>;
  /**
   * Folders a new chat may use without a picker: local chat's recent ones, newest first, or a
   * remote host's approved roots and their folders.
   */
  recentFolders?(backendId?: string): Promise<string[]>;
  /**
   * Creates a new local chat's linked worktree beside the repository; the reply is its root. A
   * repeat with the same `requestId` gets the first one's outcome.
   */
  createWorktree?(root: string, branch: string, requestId: string): Promise<Reply>;
  /** Opens a local chat without a project's folder as a project where it is, returning its root. */
  turnIntoProject?(conversationId: string): Promise<string>;
  context(backendId?: string): Promise<ChatSession>;
  call(
    kind: ChatCallKind,
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
/** A failed chat reply: the shared error DTO without a target, its message at most 512 characters. */
export function errorReply(value: unknown): Extract<Reply, { ok: false }> {
  const { code, message } = errorDTO(value);
  return { ok: false, error: { code, message: message.slice(0, 512) } };
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
    kind: 'chat' | 'connection' | 'providers',
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
      // Main's ChatClient boundary (chat runtime) already decoded and bounded chat replies.
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
    kind: ChatWatchKind,
    input: unknown,
    receive: (v: never) => void,
    onError: (e: ApplicationError) => void,
  ) => {
    const id = crypto.randomUUID();
    let active = true;
    const off = bridge.events((eventId, result, eventBackend = 'remote') => {
      if (active && eventId === id && eventBackend === backendId)
        try {
          receive(decodeWatchValue(kind, unwrap(result)) as never);
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
      watch: (receive, error) => watch('watch-providers', {}, receive, error),
    },
    chat: {
      command: (op, input, options) => command('chat', op, input, options) as never,
      watch: (input, receive, error) => watch('watch-chat', input, receive, error),
      watchChatList: (input, receive, error) => watch('watch-chat-list', input, receive, error),
    },
    connection: {
      command: (op, input, options) => command('connection', op, input, options) as never,
      watch: (receive, error) => watch('watch-connection', {}, receive, error),
    },
  };
}
/** A watch event's value; main's ChatClient boundary (chat runtime) already decoded chat values. */
function decodeWatchValue(kind: ChatWatchKind, value: unknown) {
  if (kind === 'watch-connection') return decodeConnectionSnapshot(value);
  if (kind === 'watch-providers') return decodeProviderOutput('getProviders', value);
  return value;
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
      return unwrap(await bridge.call('transcript', operation, input, id, backendId));
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
  return {
    copy: async (input, signal) => {
      await call('copy', input, signal);
    },
    openLink: async (url, signal) => {
      await call('open-link', { url }, signal);
    },
    imageUrl: async (input, signal) => {
      const url = await call('image', input, signal);
      return typeof url === 'string' ? url : invalid();
    },
  };
}
