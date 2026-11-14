import { Effect, Stream } from 'effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import type {
  ChatServiceShape,
  LocalHostHandlers,
  ProviderSetupService,
} from '@moonbase/contracts/services';
import type { ChatServerServices } from '../src/server.ts';
import { chatHostCapabilities } from '@moonbase/contracts/host';

/** Hooks a test runs around each served operation: before it (with its signal) and after it. */
export type Hooks = {
  calls: string[];
  before?(operation: string, signal: AbortSignal): Promise<void>;
  after?(operation: string): Promise<void>;
};
/** `service` with `hooks` around each of its Effect methods; watches pass through. */
export function hooked<T extends object>(
  service: T,
  hooks: Hooks,
  rename: Record<string, string> = {},
): T {
  const bound = { ...service } as Record<string, unknown>;
  for (const [name, method] of Object.entries(service)) {
    if (typeof method !== 'function' || name.startsWith('watch') || name === 'forOwner') continue;
    const operation = rename[name] ?? name;
    bound[name] = (...args: unknown[]) =>
      Effect.gen(function* () {
        hooks.calls.push(operation);
        if (hooks.before) yield* Effect.promise((signal) => hooks.before!(operation, signal));
        const value = yield* (method as (...args: unknown[]) => Effect.Effect<unknown>)(...args);
        if (hooks.after)
          yield* Effect.tryPromise({
            try: () => hooks.after!(operation),
            catch: (error) => error as ApplicationError,
          });
        return value;
      });
  }
  return bound as T;
}
/** Provider setup with `hooks` around each owner's operation. */
export const hookedProviders = (
  providers: ProviderSetupService['Service'],
  hooks: Hooks,
): ProviderSetupService['Service'] => ({
  ...hooked(providers, hooks, {
    releaseOwner: 'releaseProviderOwner',
    getProviderUrl: 'openProviderUrl',
  }),
  forOwner: (ownerId) => hooked(providers.forOwner(ownerId), hooks),
});

const refused = () =>
  Effect.fail(new ApplicationError({ code: 'Unavailable', message: 'Not served here.' }));
/**
 * A daemon whose folder and provider operations are all refused: the host still advertises local
 * mode, so a client accepts its chats.
 */
export function refusingDaemon(): NonNullable<ChatServerServices['daemon']> {
  const handlers = new Proxy({}, { get: () => refused }) as LocalHostHandlers;
  return {
    localHost: handlers,
    providers: {
      forOwner: () => new Proxy({}, { get: () => refused }) as never,
      releaseOwner: refused,
      watch: () =>
        Stream.fail(new ApplicationError({ code: 'Unavailable', message: 'Not served here.' })),
      getProviderUrl: refused,
    },
    capabilities: [chatHostCapabilities.local],
  };
}
/** Only chat: a served chat service that is not hooked keeps its own methods. */
export const asServed = (chat: ChatServiceShape) => chat;
