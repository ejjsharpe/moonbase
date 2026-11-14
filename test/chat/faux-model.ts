import type { MutableModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, type FauxProviderHandle } from '@earendil-works/pi-ai/providers/faux';
// The faux models controlled host behaviours serve. They stand in for providers the host's provider
// setup offers, so a client lists and chooses them as it would real ones; none reaches a provider.

/** Served without sign-in, and the provider's default model, so a new chat has it chosen. */
export const fauxModel = { provider: 'anthropic', modelId: 'claude-opus-5-5' };
export const fauxModelOptions = {
  provider: fauxModel.provider,
  models: [{ id: fauxModel.modelId, name: 'Faux model', reasoning: true }],
};
/** Served once its faux API key is set up through the host's provider setup. */
export const keyedModel = { provider: 'google', modelId: 'gemini-3.8-flash' };

/**
 * Installs a faux provider that counts as signed in, and a signed-out stand-in for Claude Code,
 * which provider setup lists and a controlled host never runs.
 */
export function installFaux(models: MutableModels, faux: FauxProviderHandle) {
  const claudeCode = fauxProvider({
    provider: 'claude-code',
    models: [{ id: 'claude-code-faux', name: 'Faux Claude Code' }],
  });
  models.setProvider({ ...claudeCode.provider, name: 'Claude Code', auth: {} });
  models.setProvider({
    ...faux.provider,
    name: 'Faux',
    auth: {
      apiKey: {
        name: 'Faux key',
        login: async () => ({ type: 'api_key' as const, key: 'faux' }),
        resolve: async () => ({ auth: { apiKey: 'faux' } }),
      },
    },
  });
}
