// Controlled host behaviour: one faux reply, held until released when `hold` is set, and a second
// faux provider that needs an API key, so provider setup and model choice reach no real provider.
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
} from '@earendil-works/pi-ai/providers/faux';
import { fauxModelOptions, installFaux, keyedModel } from './faux-model.ts';

export function createBehaviour({ hold }) {
  const faux = fauxProvider({ ...fauxModelOptions, tokensPerSecond: 100000 });
  let release;
  const gate = hold
    ? new Promise((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage('REMOTE COMPLETED');
    },
  ]);
  const keyed = fauxProvider({
    provider: keyedModel.provider,
    models: [{ id: keyedModel.modelId, name: 'Keyed faux model', reasoning: true }],
    tokensPerSecond: 100000,
  });
  keyed.setResponses(
    Array.from({ length: 8 }, () =>
      fauxAssistantMessage([fauxThinking('Keyed thinking'), fauxText('KEYED COMPLETED')]),
    ),
  );
  return {
    installProviders: (models) => {
      installFaux(models, faux);
      models.setProvider({
        ...keyed.provider,
        name: 'Keyed faux',
        auth: {
          apiKey: {
            name: 'Faux API key',
            login: async (interaction) => ({
              type: 'api_key',
              key: await interaction.prompt({
                type: 'secret',
                message: 'Enter API key',
              }),
            }),
            resolve: async ({ credential }) =>
              credential?.key ? { auth: { apiKey: credential.key } } : undefined,
          },
        },
      });
    },
    stats: () => ({
      calls: faux.state.callCount + keyed.state.callCount,
      tools: 0,
    }),
    release: () => release?.(),
  };
}
