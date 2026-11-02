import { normalizeApplicationError } from '@moonbase/application/effect-client';
import {
  decodeApplicationErrorDTO,
  type ApplicationErrorDTOSchema,
} from '@moonbase/application/error-schema';
import {
  decodeWorkspaceOutput,
  decodeWorkspaceEvent,
} from '@moonbase/application/workspace-schema';
import {
  ApplicationError,
  type CheckoutTarget,
  type EditorClient,
} from '@moonbase/application/client';

export const channels = {
  call: 'moonbase:call',
  cancel: 'moonbase:cancel',
  event: 'moonbase:event',
  action: 'moonbase:action',
  quit: 'moonbase:quit-result',
  ready: 'moonbase:ready',
  configured: 'moonbase:chat-configured',
} as const;
export type ErrorDTO = typeof ApplicationErrorDTOSchema.Type;
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: ErrorDTO };
export type DesktopAction = 'quit' | 'dispose' | 'cleanup-error';
export interface DesktopBridge {
  readonly clientId: string;
  call(
    method: 'command' | 'choose-checkout' | 'choose-imports' | 'clipboard-imports' | 'watch',
    input: unknown,
    id: string,
  ): Promise<Reply>;
  cancel(id: string): Promise<Reply<null>>;
  events(receive: (id: string, result: Reply) => void): () => void;
  actions(receive: (action: DesktopAction, id: string, error?: ErrorDTO) => void): () => void;
  quitResult(id: string, consent: boolean, cleanupError?: ErrorDTO): void;
  ready(): void;
  chatConfigured(): Promise<Reply<boolean>>;
  drop(checkout: CheckoutTarget, files: File[]): Promise<Reply<string[]>>;
}
export const invalid = (message: string): never => {
  throw new ApplicationError({ code: 'InvalidInput', message });
};
export function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid('Expected a plain object.');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[], required = allowed) {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in value))
  )
    invalid('Unexpected or missing input fields.');
}
export function string(value: unknown, max = 4096): asserts value is string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    invalid('Invalid text input.');
}
export function requestId(value: unknown): asserts value is string {
  string(value, 128);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) invalid('Invalid request identity.');
}
export function checkout(value: unknown): asserts value is CheckoutTarget {
  const v = record(value);
  keys(v, ['hostId', 'checkoutId', 'projectId', 'root', 'branch']);
  for (const field of Object.values(v)) string(field);
}
export function errorDTO(error: unknown): ErrorDTO {
  const e = normalizeApplicationError(error);
  return { code: e.code, message: e.message, ...(e.target ? { target: e.target } : {}) };
}
export function failure(value: unknown): ApplicationError {
  try {
    const dto = decodeApplicationErrorDTO(value);
    if (dto.message.length > 2 ** 22) invalid('Invalid error message.');
    return new ApplicationError(dto);
  } catch {
    return new ApplicationError({
      code: 'Incompatible',
      message: 'Malformed application error from desktop transport.',
    });
  }
}
export function unwrap<T>(value: Reply<T>): T {
  let reply: Record<string, unknown>;
  try {
    reply = record(value);
    if (reply.ok === true) keys(reply, ['ok', 'value']);
    else if (reply.ok === false) keys(reply, ['ok', 'error']);
    else invalid('Invalid reply envelope.');
  } catch {
    throw new ApplicationError({
      code: 'Incompatible',
      message: 'Malformed desktop reply envelope.',
    });
  }
  if (reply.ok === true) return reply.value as T;
  throw failure(reply.error);
}
export function cancellation(value: unknown): void {
  let error: ApplicationError;
  try {
    const v = record(value);
    if (v.ok === true) {
      keys(v, ['ok', 'value']);
      if (v.value !== null) invalid('Invalid cancellation acknowledgment.');
      return;
    }
    keys(v, ['ok', 'error']);
    if (v.ok !== false) invalid('Invalid cancellation acknowledgment.');
    error = failure(v.error);
  } catch {
    throw new ApplicationError({
      code: 'Incompatible',
      message: 'Malformed cancellation acknowledgment.',
    });
  }
  throw error;
}
export function bridgeClient(bridge: DesktopBridge): EditorClient {
  return {
    async command(operation, input, options) {
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
        return decodeWorkspaceOutput(
          operation,
          unwrap(await bridge.call('command', { operation, input }, id)),
        );
      } catch (error) {
        throw normalizeApplicationError(error);
      } finally {
        options?.signal?.removeEventListener('abort', cancel);
      }
    },
    watch(input, receive, onError) {
      const id = crypto.randomUUID();
      let active = true;
      const stop = bridge.events((eventId, result) => {
        if (active && eventId === id) {
          try {
            receive(decodeWorkspaceEvent(unwrap(result)));
          } catch (e) {
            onError(normalizeApplicationError(e));
          }
        }
      });
      const started = bridge.call('watch', input, id);
      void started.then(
        (result) => {
          if (active && !result.ok) onError(failure(result.error));
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
              stop();
            }
          },
          (error) => {
            stop();
            throw normalizeApplicationError(error);
          },
        );
        return completion;
      };
    },
  };
}
