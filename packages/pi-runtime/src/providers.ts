import { randomUUID } from 'node:crypto';
import { Effect, Layer } from 'effect';
import { getSupportedThinkingLevels, type Models } from '@earendil-works/pi-ai/models';
type Interaction = Parameters<Models['login']>[2];
type AuthPrompt = Parameters<Interaction['prompt']>[0];
type AuthEvent = Parameters<Interaction['notify']>[0];
import { ProviderSetupService, type ProviderSetupHandlers } from '@moonbase/contracts/services';
import type { ProviderCommand, ProviderInput, ProviderState } from '@moonbase/contracts/providers';
import { decodeProviderInput, decodeProviderOutput } from '@moonbase/contracts/providers-schema';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatReasoningEffort } from '@moonbase/contracts/chat';

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
const claudeCodeLogin =
  'Claude Code manages this sign-in. Run `claude auth login` or `claude auth logout` in a terminal, then refresh providers.';
function fail(message: string): never {
  throw new ApplicationError({ code: 'InvalidInput', message });
}
const unavailable = () =>
  new ApplicationError({
    code: 'Unavailable',
    message:
      'Provider setup or encrypted credential storage is unavailable. Existing credentials were retained; retry setup or sign in again.',
  });
type Flow = {
  state: NonNullable<ProviderState['flow']>;
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
  openUrl(url: string): Promise<void>;
  deviceId: string;
  /** Why the auth check made with `signal` couldn't tell whether a provider is configured, if it says. */
  getCheckProblem?(providerId: string, signal: AbortSignal): string | undefined;
};
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

/** Provider callbacks remain privileged; only status and live prompt identities leave this layer. */
export const ProviderSetupLive = (
  config: ProviderSetupConfiguration,
): Layer.Layer<ProviderSetupService> =>
  Layer.effect(
    ProviderSetupService,
    Effect.gen(function* () {
      const owners = new Map<string, Flow>();
      const revisions = new Map<string, number>();
      const released = new Set<string>();
      const validateProviderUrl = (value: string) => {
        const url = new URL(value);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.hostname !== 'auth.openai.com'
        )
          fail('The provider supplied an unsupported sign-in URL.');
        return url.href;
      };
      const cancelFlow = async (flow: Flow) => {
        flow.abort.abort();
        flow.answer?.reject(new Error('Cancelled'));
        await flow.completion;
      };
      const cancel = async (owner: string, flowId?: string) => {
        const flow = owners.get(owner);
        if (!flow) {
          if (flowId) fail('This sign-in flow is no longer active.');
          return;
        }
        if (flowId && flow.state.id !== flowId) fail('This sign-in flow is no longer active.');
        await cancelFlow(flow);
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
          return fail('This sign-in flow is no longer active.');
        return flow;
      }
      const invoke = async <K extends ProviderCommand>(
        owner: string,
        operation: K,
        input: ProviderInput<K>,
      ): Promise<ProviderState> => {
        if (released.has(owner)) fail('The owning document was released.');
        const value = decodeProviderInput(operation, input);
        let startedFlow: Flow | undefined;
        if (operation === 'startProviderLogin') {
          const { providerId } = value as ProviderInput<'startProviderLogin'>;
          if (!localProviderIds.includes(providerId as (typeof localProviderIds)[number]))
            fail('Choose an installed provider.');
          if (authKinds[providerId] === 'claude_code') fail(claudeCodeLogin);
          const revision = (revisions.get(owner) ?? 0) + 1;
          revisions.set(owner, revision);
          await cancel(owner);
          if (released.has(owner) || revisions.get(owner) !== revision)
            fail('This sign-in request was superseded.');
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
            });
        } else if (operation === 'answerProviderPrompt') {
          const { flowId, promptId, answer } = value as ProviderInput<'answerProviderPrompt'>;
          const flow = getCurrentFlow(owner, flowId),
            pending = flow.answer;
          if (!pending || pending.id !== promptId) fail('This setup prompt is obsolete.');
          if (!answer.trim() || (pending.options && !pending.options.includes(answer)))
            fail('Enter a valid answer for the active prompt.');
          pending.resolve(answer);
        } else if (operation === 'cancelProviderLogin') {
          await cancel(owner, (value as ProviderInput<'cancelProviderLogin'>).flowId);
        } else if (operation === 'openProviderUrl') {
          const flow = getCurrentFlow(owner, (value as ProviderInput<'openProviderUrl'>).flowId);
          if (!flow.url) fail('There is no active sign-in URL.');
          await config.openUrl(validateProviderUrl(flow.url));
        } else if (operation === 'logoutProvider') {
          const { providerId } = value as ProviderInput<'logoutProvider'>;
          if (!localProviderIds.includes(providerId as (typeof localProviderIds)[number]))
            fail('Choose an installed provider.');
          if (authKinds[providerId] === 'claude_code') fail(claudeCodeLogin);
          await cancel(owner);
          await config.models.logout(providerId);
        }
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
      return {
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
              revisions.delete(owner);
              await cancel(owner);
              owners.delete(owner);
            },
            catch: unavailable,
          }),
      };
    }),
  );
