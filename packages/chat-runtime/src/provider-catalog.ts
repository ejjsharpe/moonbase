import { Effect } from 'effect';
import { getSupportedThinkingLevels, type Models } from '@earendil-works/pi-ai/models';
import type { ChatReasoningEffort } from '@moonbase/contracts/chat';
import type { ProviderState } from '@moonbase/contracts/providers';
import { ProviderSetupUnavailableError } from '@moonbase/contracts/provider-errors';

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

export const isLocalProvider = (id: string) =>
  localProviderIds.includes(id as (typeof localProviderIds)[number]);
/** Whether Claude Code, not Moonbase, signs in to `id`. */
export const isClaudeCodeSignIn = (id: string) => authKinds[id] === 'claude_code';

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

const unavailable = () => new ProviderSetupUnavailableError({ reason: 'setup' });

/**
 * The installed providers, their models and defaults, and whether each is configured. A provider's
 * auth check gets its own signal, which `getCheckProblem` is handed to say why that check failed.
 */
export const listProviders = (
  models: Models,
  getCheckProblem?: (providerId: string, signal: AbortSignal) => string | undefined,
): Effect.Effect<ProviderState['providers'], ProviderSetupUnavailableError> =>
  Effect.forEach(
    localProviderIds,
    (id) =>
      Effect.gen(function* () {
        const provider = models.getProvider(id);
        if (!provider) return yield* Effect.fail(unavailable());
        const listed = provider.getModels().map((model) => {
          const reasoningEfforts = getSupportedThinkingLevels(model);
          const preferredEffort = defaultModels[id]!.reasoningEffort;
          let defaultReasoningEffort = reasoningEfforts[0]!;
          if (reasoningEfforts.includes('medium')) defaultReasoningEffort = 'medium';
          if (reasoningEfforts.includes(preferredEffort)) defaultReasoningEffort = preferredEffort;
          return { modelId: model.id, name: model.name, reasoningEfforts, defaultReasoningEffort };
        });
        const defaultModel = listed.find((model) => model.modelId === defaultModels[id]!.modelId);
        const auth = yield* Effect.tryPromise({
          // Pi hands this signal to the provider's check, which keys its problem by it.
          try: (signal) =>
            models.checkAuth(id, { signal }).then((found) => {
              const problem = !found && getCheckProblem?.(id, signal);
              return problem
                ? { configured: false, problem: boundText(problem) }
                : { configured: !!found };
            }),
          catch: unavailable,
        });
        return {
          id,
          name: names[id] ?? provider.name,
          auth: authKinds[id] ?? ('api_key' as const),
          ...auth,
          models: listed,
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
    { concurrency: 'unbounded' },
  );
