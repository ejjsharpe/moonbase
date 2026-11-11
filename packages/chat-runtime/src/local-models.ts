import {
  createModels,
  createProvider,
  type CreateModelsOptions,
} from '@earendil-works/pi-ai/models';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';

/** The SDK's public static loader registration also supports an Electron bundle. */
export function createLocalModels(credentials: NonNullable<CreateModelsOptions['credentials']>) {
  registerBunOAuthFlows();
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const openai = openaiProvider();
  models.setProvider({ ...openai, auth: { oauth: openai.auth.oauth } });
  models.setProvider(
    createProvider({
      id: 'openai-api-key',
      name: 'OpenAI API key',
      auth: { apiKey: openai.auth.apiKey },
      models: openai.getModels().map((model) => ({ ...model, provider: 'openai-api-key' })),
      api: openAIResponsesApi(),
    }),
  );
  for (const create of [anthropicProvider, googleProvider, openrouterProvider])
    models.setProvider(create());
  return models;
}
