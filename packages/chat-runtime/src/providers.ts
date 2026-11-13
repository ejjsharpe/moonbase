import { randomUUID } from 'node:crypto';
import { Context, Effect, Layer } from 'effect';
import { readOnChange } from '@moonbase/effect/changes';
import { getSupportedThinkingLevels, type Models } from '@earendil-works/pi-ai/models';
import { ProviderSetupService, type ProviderSetupHandlers } from '@moonbase/contracts/services';
import {
  type ProviderCommand,
  type ProviderInput,
  type ProviderState,
  decodeProviderInput,
  decodeProviderOutput,
  readProviderSignInUrl,
} from '@moonbase/contracts/providers';
import { ApplicationError } from '@moonbase/contracts/errors';
import { daemonErrorReasons, type DaemonErrorReason } from '@moonbase/contracts/daemon';
import type { ChatReasoningEffort } from '@moonbase/contracts/chat';
type Interaction = Parameters<Models['login']>[2];
type AuthPrompt = Parameters<Interaction['prompt']>[0];
type AuthEvent = Parameters<Interaction['notify']>[0];

// Moonbase defaults for the pinned catalog; explicit user preferences take precedence.
const defaultModels: Record<string, { modelId: string; reasoningEffort: ChatReasoningEffort }> = {
  openai: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' },
  'openai-api-key': { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' },
  anthropic: { modelId: 'claude-opus-5-5', reasoningEffort: 'high' },
  google: { modelId: 'gemini-3.8-flash', reasoningEffort: 'medium' },
  openrouter: { modelId: 'openai/gpt-6.1-sol', reasoningEffort: 'medium' },
  'claude-code': { modelId: 'claude-opus-5-5', reasoningEffort: 'high' },
};

export const localProviderIds = [
  'openai',
  'openai-api-key',
  'anthropic',
  'google',
  'openrouter',
  'claude-code',
] as const;
const authKinds: Partial<Record<string, 'oauth' | 'claude_code'>> = {
  openai: 'oauth',
  'claude-code': 'claude_code',
};
const names: Partial<Record<string, string>> = {
  openai: 'ChatGPT subscription',
  google: 'Google Gemini',
  'claude-code': 'Claude subscription',
};
/** Refuses with a reason clients can show over the host protocol. */
function fail(reason: DaemonErrorReason): never {
  throw new ApplicationError(daemonErrorReasons[reason]);
}
const unavailable = () => new ApplicationError(daemonErrorReasons['provider-setup-unavailable']);
type Flow = {
  state: NonNullable<ProviderState['flow']>;
  /** When its owner last used provider setup. */
  usedAt: number;
  abort: AbortController;
  completion: Promise<void>;
  url?: string;
  answer?: {
    id: string;
    resolve(value: string): void;
    reject(error: unknown): void;
    options?: readonly string[];
  };
};
export type ProviderSetupConfiguration = {
  models: Models;
  /**
   * Opens a validated sign-in URL in the user's browser. Without it, `openProviderUrl` is refused
   * and clients read the URL with `getProviderUrl` to open it themselves.
   */
  openUrl?(url: string): Promise<void>;
  deviceId: string;
  /** Why the auth check made with `signal` couldn't tell whether a provider is configured, if it says. */
  getCheckProblem?(providerId: string, signal: AbortSignal): string | undefined;
  /** The current time in milliseconds; `Date.now` by default. */
  now?(): number;
};
/** An owner unheard from this long loses its flow, as when its client stopped without releasing it. */
export const inactiveProviderOwnerMs = 30 * 60 * 1000;
/** How many owners may hold a flow, and how many released owners stay refused. */
const maximumOwners = 64;
const maximumReleasedOwners = 256;
/** Fits provider-supplied text to the status contract: no NULs or lone surrogates, at most 512 bytes. */
function boundText(value: string) {
  let text = '',
    bytes = 0;
  for (const character of value.replace(/[\0\ud800-\udfff]/gu, '')) {
    bytes += new TextEncoder().encode(character).length;
    if (bytes > 512) break;
    text += character;
  }
  return text;
}

/** Tells a server when any owner's provider setup state may have changed, so it can push it. */
export class ProviderSetupChanges extends Context.Service<
  ProviderSetupChanges,
  { subscribe(listener: () => void): () => void }
>()('moonbase/ProviderSetupChanges') {}

/** Provider callbacks remain privileged; only status and live prompt identities leave this layer. */
export const ProviderSetupLive = (
  config: ProviderSetupConfiguration,
): Layer.Layer<ProviderSetupService | ProviderSetupChanges> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const listeners = new Set<() => void>();
      /** A flow, an owner or a sign-in changed; reading state never calls it. */
      const changed = () => {
        for (const listener of listeners) listener();
      };
      const owners = new Map<string, Flow>();
      const revisions = new Map<string, number>();
      const released = new Set<string>();
      const now = config.now ?? Date.now;
      const validateProviderUrl = (value: string) =>
        readProviderSignInUrl(value) ?? fail('unsupported-sign-in-url');
      const cancelFlow = async (flow: Flow) => {
        flow.abort.abort();
        flow.answer?.reject(new Error('Cancelled'));
        await flow.completion;
      };
      const cancel = async (owner: string, flowId?: string) => {
        const flow = owners.get(owner);
        if (!flow) {
          if (flowId) fail('sign-in-inactive');
          return;
        }
        if (flowId && flow.state.id !== flowId) fail('sign-in-inactive');
        await cancelFlow(flow);
      };
      /** Forgets an owner's flow, cancelling it. */
      const dropOwner = async (owner: string) => {
        const flow = owners.get(owner);
        owners.delete(owner);
        revisions.delete(owner);
        if (flow) await cancelFlow(flow);
        if (flow) changed();
      };
      /**
       * Marks `owner` as heard from and drops other owners that went quiet or exceed the bound,
       * least recently used first, so a daemon outliving its clients does not keep their flows.
       */
      const sweepOwners = async (owner: string) => {
        const time = now();
        const flow = owners.get(owner);
        if (flow) flow.usedAt = time;
        const others = [...owners]
          .filter(([other]) => other !== owner)
          .sort(([, a], [, b]) => b.usedAt - a.usedAt);
        const stale = others.filter(
          ([, flow], index) =>
            time - flow.usedAt >= inactiveProviderOwnerMs || index >= maximumOwners - 1,
        );
        await Promise.all(stale.map(([other]) => dropOwner(other)));
      };
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await Promise.all([...owners.keys()].map((owner) => cancel(owner)));
          owners.clear();
        }),
      );
      const getStatus = async (owner: string): Promise<ProviderState> => ({
        providers: await Promise.all(
          localProviderIds.map(async (id) => {
            const provider = config.models.getProvider(id);
            if (!provider) throw unavailable();
            const models = provider.getModels().map((model) => {
              const reasoningEfforts = getSupportedThinkingLevels(model);
              const preferredEffort = defaultModels[id]!.reasoningEffort;
              let defaultReasoningEffort = reasoningEfforts[0]!;
              if (reasoningEfforts.includes('medium')) defaultReasoningEffort = 'medium';
              if (reasoningEfforts.includes(preferredEffort))
                defaultReasoningEffort = preferredEffort;
              return {
                modelId: model.id,
                name: model.name,
                reasoningEfforts,
                defaultReasoningEffort,
              };
            });
            const defaultModel = models.find(
              (model) => model.modelId === defaultModels[id]!.modelId,
            );
            return {
              id,
              name: names[id] ?? provider.name,
              auth: authKinds[id] ?? ('api_key' as const),
              ...(await (async () => {
                // Pi hands this signal to the provider's check, which keys its problem by it.
                const signal = new AbortController().signal,
                  auth = await config.models.checkAuth(id, { signal }),
                  problem = !auth && config.getCheckProblem?.(id, signal);
                return problem
                  ? { configured: false, problem: boundText(problem) }
                  : { configured: !!auth };
              })()),
              models,
              ...(defaultModel
                ? {
                    defaultModel: {
                      model: { provider: id, modelId: defaultModel.modelId },
                      reasoningEffort: defaultModel.defaultReasoningEffort,
                    },
                  }
                : {}),
            };
          }),
        ),
        flow: owners.get(owner)?.state ?? null,
      });
      function getCurrentFlow(owner: string, id: string) {
        const flow = owners.get(owner);
        if (!flow || flow.state.id !== id || flow.state.state !== 'running')
          return fail('sign-in-inactive');
        return flow;
      }
      function getProviderUrl(owner: string, flowId: string) {
        if (released.has(owner)) fail('owner-released');
        const flow = getCurrentFlow(owner, flowId);
        if (!flow.url) fail('no-sign-in-url');
        return validateProviderUrl(flow.url!);
      }
      const invoke = async <K extends ProviderCommand>(
        owner: string,
        operation: K,
        input: ProviderInput<K>,
      ): Promise<ProviderState> => {
        if (released.has(owner)) fail('owner-released');
        const value = decodeProviderInput(operation, input);
        await sweepOwners(owner);
        let startedFlow: Flow | undefined;
        if (operation === 'startProviderLogin') {
          const { providerId } = value as ProviderInput<'startProviderLogin'>;
          if (!localProviderIds.includes(providerId as (typeof localProviderIds)[number]))
            fail('unknown-provider');
          if (authKinds[providerId] === 'claude_code') fail('claude-code-sign-in');
          const revision = (revisions.get(owner) ?? 0) + 1;
          revisions.set(owner, revision);
          await cancel(owner);
          if (released.has(owner) || revisions.get(owner) !== revision) fail('sign-in-superseded');
          // One sign-in per provider at a time: a provider's loopback callback (ChatGPT's
          // 127.0.0.1:1455) serves only one flow, and an abandoned client's flow must not hold it.
          for (;;) {
            const contenders = [...owners].filter(
              ([other, flow]) =>
                other !== owner &&
                flow.state.providerId === providerId &&
                flow.state.state === 'running',
            );
            if (!contenders.length) break;
            await Promise.all(contenders.map(([, flow]) => cancelFlow(flow)));
            if (released.has(owner) || revisions.get(owner) !== revision)
              fail('sign-in-superseded');
          }
          const abort = new AbortController();
          const flow: Flow = {
            state: {
              id: randomUUID(),
              providerId,
              state: 'running',
              message: 'Complete provider setup.',
              canOpenUrl: false,
              prompt: null,
            },
            usedAt: now(),
            abort,
            completion: Promise.resolve(),
          };
          owners.set(owner, flow);
          startedFlow = flow;
          const live = () => owners.get(owner) === flow && !abort.signal.aborted;
          const prompt = (prompt: AuthPrompt): Promise<string> =>
            new Promise((resolve, reject) => {
              if (!live() || prompt.signal?.aborted) {
                reject(Error('Cancelled'));
                return;
              }
              const id = randomUUID();
              const close = () => {
                abort.signal.removeEventListener('abort', cancelled);
                prompt.signal?.removeEventListener('abort', cancelled);
                if (flow.answer?.id === id) {
                  flow.answer = undefined;
                  flow.state = { ...flow.state, prompt: null };
                  changed();
                }
              };
              const cancelled = () => {
                close();
                reject(Error('Cancelled'));
              };
              flow.answer = {
                id,
                ...(prompt.type === 'select'
                  ? { options: prompt.options.map((option) => option.id) }
                  : {}),
                resolve: (value) => {
                  close();
                  resolve(value);
                },
                reject: (error) => {
                  close();
                  reject(error);
                },
              };
              flow.state = {
                ...flow.state,
                prompt: {
                  id,
                  type: prompt.type,
                  message: prompt.message,
                  options:
                    prompt.type === 'select'
                      ? prompt.options.map(({ id, label }) => ({ id, label }))
                      : [],
                },
              };
              abort.signal.addEventListener('abort', cancelled, { once: true });
              prompt.signal?.addEventListener('abort', cancelled, { once: true });
              changed();
            });
          const notify = (event: AuthEvent) => {
            if (!live()) return;
            if (event.type === 'auth_url') {
              flow.url = validateProviderUrl(event.url);
              flow.state = {
                ...flow.state,
                canOpenUrl: true,
                message: 'Open the provider sign-in page to continue.',
              };
            } else
              flow.state = {
                ...flow.state,
                message: 'Waiting for the provider to finish sign-in…',
              };
            changed();
          };
          flow.completion = config.models
            .login(
              providerId,
              providerId === 'openai' ? 'oauth' : 'api_key',
              { signal: abort.signal, prompt, notify },
              { agentName: 'Moonbase', getDeviceId: () => config.deviceId },
            )
            .then(
              () => {
                flow.state = {
                  ...flow.state,
                  state: 'completed',
                  prompt: null,
                  canOpenUrl: false,
                  message: 'Provider is configured.',
                };
              },
              () => {
                flow.state = {
                  ...flow.state,
                  state: abort.signal.aborted ? 'cancelled' : 'failed',
                  prompt: null,
                  canOpenUrl: false,
                  message: abort.signal.aborted ? 'Setup cancelled.' : unavailable().message,
                };
              },
            )
            .finally(() => {
              flow.answer = undefined;
              flow.url = undefined;
              changed();
            });
        } else if (operation === 'answerProviderPrompt') {
          const { flowId, promptId, answer } = value as ProviderInput<'answerProviderPrompt'>;
          const flow = getCurrentFlow(owner, flowId),
            pending = flow.answer;
          if (!pending || pending.id !== promptId) fail('prompt-obsolete');
          if (!answer.trim() || (pending.options && !pending.options.includes(answer)))
            fail('invalid-answer');
          pending.resolve(answer);
        } else if (operation === 'cancelProviderLogin') {
          await cancel(owner, (value as ProviderInput<'cancelProviderLogin'>).flowId);
        } else if (operation === 'openProviderUrl') {
          const url = getProviderUrl(owner, (value as ProviderInput<'openProviderUrl'>).flowId);
          if (!config.openUrl)
            throw new ApplicationError({
              code: 'Unavailable',
              message: 'Open provider sign-in links from a Moonbase client.',
            });
          await config.openUrl(url);
        } else if (operation === 'logoutProvider') {
          const { providerId } = value as ProviderInput<'logoutProvider'>;
          if (!localProviderIds.includes(providerId as (typeof localProviderIds)[number]))
            fail('unknown-provider');
          if (authKinds[providerId] === 'claude_code') fail('claude-code-sign-in');
          await cancel(owner);
          await config.models.logout(providerId);
        }
        if (operation !== 'getProviders' && operation !== 'openProviderUrl') changed();
        try {
          return decodeProviderOutput(operation, await getStatus(owner));
        } catch (error) {
          if (startedFlow) {
            await cancelFlow(startedFlow);
            if (owners.get(owner) === startedFlow) owners.delete(owner);
          }
          throw error;
        }
      };
      const service: ProviderSetupService['Service'] = {
        forOwner: (owner) =>
          Object.fromEntries(
            [
              'getProviders',
              'startProviderLogin',
              'answerProviderPrompt',
              'cancelProviderLogin',
              'openProviderUrl',
              'logoutProvider',
            ].map((operation) => [
              operation,
              (input: never) =>
                Effect.tryPromise({
                  try: () => invoke(owner, operation as ProviderCommand, input),
                  catch: (error) => (ApplicationError.is(error) ? error : unavailable()),
                }),
            ]),
          ) as ProviderSetupHandlers,
        releaseOwner: (owner) =>
          Effect.tryPromise({
            try: async () => {
              released.add(owner);
              for (const old of released) {
                if (released.size <= maximumReleasedOwners) break;
                released.delete(old);
              }
              await dropOwner(owner);
            },
            catch: unavailable,
          }),
        watch: (owner) =>
          readOnChange(
            (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
            () => invoke(owner, 'getProviders', {} as never),
          ),
        getProviderUrl: (owner, flowId) =>
          Effect.tryPromise({
            try: async () => {
              if (released.has(owner)) fail('owner-released');
              const { flowId: id } = decodeProviderInput('openProviderUrl', { flowId });
              // Reading the URL is use: the owner keeps its flow as when it polls.
              await sweepOwners(owner);
              return getProviderUrl(owner, id);
            },
            catch: (error) => (ApplicationError.is(error) ? error : unavailable()),
          }),
      };
      return Context.make(ProviderSetupService, service).pipe(
        Context.add(ProviderSetupChanges, {
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
        }),
      );
    }),
  );
