import {
  ApplicationError,
  type ApplicationErrorCode,
  type CheckoutTarget,
  type EditorClient,
  type FileTarget,
  type WorkspaceCommand,
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
export type ErrorDTO = { code: ApplicationErrorCode; message: string; target?: FileTarget };
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: ErrorDTO };
export type DesktopAction = 'quit' | 'dispose';
export interface DesktopBridge {
  readonly clientId: string;
  call(
    method: 'command' | 'choose-checkout' | 'choose-imports' | 'clipboard-imports' | 'watch',
    input: unknown,
    id: string,
  ): Promise<Reply>;
  cancel(id: string): Promise<Reply<null>>;
  events(receive: (id: string, result: Reply) => void): () => void;
  actions(receive: (action: DesktopAction, id: string) => void): () => void;
  quitResult(id: string, consent: boolean, cleanupError?: ErrorDTO): void;
  ready(): void;
  chatConfigured(): Promise<Reply<boolean>>;
  drop(checkout: CheckoutTarget, files: File[]): Promise<Reply<string[]>>;
}
const codes: ApplicationErrorCode[] = [
  'InvalidInput',
  'Unavailable',
  'Conflict',
  'Persistence',
  'Uncertain',
  'Cancelled',
  'Unauthorized',
  'Incompatible',
];
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
  const e = ApplicationError.fromUnknown(error);
  return { code: e.code, message: e.message, ...(e.target ? { target: e.target } : {}) };
}
export function failure(value: unknown): ApplicationError {
  try {
    const v = record(value);
    keys(v, ['code', 'message', 'target'], ['code', 'message']);
    if (!codes.includes(v.code as ApplicationErrorCode)) invalid('Invalid error code.');
    string(v.message, 2 ** 22);
    if (v.target !== undefined) {
      const t = record(v.target);
      keys(t, ['checkout', 'path']);
      checkout(t.checkout);
      string(t.path);
    }
    return new ApplicationError(v as ErrorDTO);
  } catch {
    return new ApplicationError({
      code: 'Incompatible',
      message: 'Malformed application error from desktop transport.',
    });
  }
}
export function unwrap<T>(value: Reply<T>): T {
  if (value.ok) return value.value;
  throw failure(value.error);
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
        return unwrap(await bridge.call('command', { operation, input }, id)) as never;
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
            receive(unwrap(result) as never);
          } catch (e) {
            onError(ApplicationError.fromUnknown(e));
          }
        }
      });
      const started = bridge.call('watch', input, id);
      void started.then(
        (result) => {
          if (active && !result.ok) onError(failure(result.error));
        },
        (e) => {
          if (active) onError(ApplicationError.fromUnknown(e));
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
            throw ApplicationError.fromUnknown(error);
          },
        );
        return completion;
      };
    },
  };
}
export const commandFields: Record<WorkspaceCommand, [string[], string[]?]> = {
  openCheckout: [['root']],
  readFile: [['checkout', 'path']],
  saveFile: [['target', 'clientId', 'requestId', 'text', 'expectedVersion']],
  listDirectory: [
    ['checkout', 'path', 'hideIgnored'],
    ['checkout', 'path'],
  ],
  gitStatus: [['checkout']],
  readComparison: [['target', 'area']],
  lookupFiles: [
    ['checkout', 'query', 'limit', 'history'],
    ['checkout', 'query'],
  ],
  inspectEntries: [['checkout', 'paths']],
  mutate: [
    [
      'id',
      'clientId',
      'checkout',
      'kind',
      'sources',
      'destination',
      'text',
      'replacements',
      'nativeReferences',
    ],
    ['id', 'clientId', 'checkout', 'kind', 'sources'],
  ],
  operationStatus: [['clientId', 'id']],
  acknowledgeOperation: [['clientId', 'operationClientId', 'id']],
  loadRecovery: [['clientId']],
  persistRecovery: [['clientId', 'requestId', 'expectedRevision', 'state']],
  getRecoveryPublication: [['clientId', 'requestId']],
};
