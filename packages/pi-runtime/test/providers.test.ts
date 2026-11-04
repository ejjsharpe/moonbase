import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeProviderSetupClient } from '@moonbase/application/runtime/clients';
import { ProviderSetupLive, localProviderIds } from '../src/providers.ts';
import { ProviderSetupService } from '@moonbase/contracts/services';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

test('maintained defaults and reasoning options match the pinned provider catalogs', async (t) => {
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  for (const make of [openaiProvider, anthropicProvider, googleProvider, openrouterProvider])
    models.setProvider(make());
  const openai = openaiProvider();
  models.setProvider({
    ...openai,
    id: 'openai-api-key',
    getModels: () => openai.getModels().map((model) => ({ ...model, provider: 'openai-api-key' })),
  });
  const runtime = ManagedRuntime.make(
    ProviderSetupLive({
      models,
      deviceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      openUrl: async () => {
        throw Error('No network or login expected');
      },
    }),
  );
  t.after(() => runtime.dispose());
  const client = makeProviderSetupClient(runtime, 'defaults');
  const status = await client.command('getProviders', {});
  for (const provider of status.providers) {
    assert(provider.defaultModel, `Missing default for ${provider.id}`);
    assert.equal(provider.defaultModel.model.provider, provider.id);
    const selected = provider.models.find(
      (model) => model.modelId === provider.defaultModel!.model.modelId,
    );
    assert(selected?.reasoningEfforts?.includes(provider.defaultModel.reasoningEffort!));
  }
  assert.deepEqual(status.providers.find((provider) => provider.id === 'openai')!.defaultModel, {
    model: { provider: 'openai', modelId: 'gpt-6.1-sol' },
    reasoningEffort: 'medium',
  });
  assert.deepEqual(status.providers.find((provider) => provider.id === 'anthropic')!.defaultModel, {
    model: { provider: 'anthropic', modelId: 'claude-opus-5-5' },
    reasoningEffort: 'high',
  });
});

test('provider-owned setup binds prompts and URLs to the live document, supports cancellation and never publishes answers', async (t) => {
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  let authenticated = false;
  for (const id of localProviderIds) {
    const faux = fauxProvider({ provider: id });
    models.setProvider({
      ...faux.provider,
      name: id,
      auth:
        id === 'openai'
          ? {
              oauth: {
                name: 'Controlled Codex',
                login: async (interaction) => {
                  const method = await interaction.prompt({
                    type: 'select',
                    message: 'Sign-in method',
                    options: [{ id: 'browser', label: 'Browser' }],
                  });
                  assert.equal(method, 'browser');
                  interaction.notify({
                    type: 'auth_url',
                    url: 'https://auth.openai.com/oauth/authorize?state=controlled',
                  });
                  const answer = await interaction.prompt({ type: 'manual_code', message: 'Code' });
                  assert.equal(answer, 'private-code');
                  authenticated = true;
                  return {
                    type: 'oauth',
                    access: 'private-access',
                    refresh: 'private-refresh',
                    expires: Date.now() + 60000,
                  };
                },
                refresh: async () => {
                  throw Error('private token refresh failed');
                },
                toAuth: async (value) => ({ apiKey: value.access }),
              },
            }
          : {
              apiKey: {
                name: 'API key',
                login: async (interaction) => ({
                  type: 'api_key',
                  key: await interaction.prompt({ type: 'secret', message: 'Enter API key' }),
                }),
                resolve: async ({ credential }) =>
                  credential?.key ? { auth: { apiKey: credential.key } } : undefined,
              },
            },
    });
  }
  const opened: string[] = [];
  const runtime = ManagedRuntime.make(
    ProviderSetupLive({
      deviceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      models,
      openUrl: async (url) => {
        opened.push(url);
      },
    }),
  );
  t.after(() => runtime.dispose());
  const client = makeProviderSetupClient(runtime, 'document-a'),
    foreign = makeProviderSetupClient(runtime, 'document-b');
  let state = await client.command('startProviderLogin', { providerId: 'openai' });
  assert.equal(state.providers[0]!.defaultModel, undefined);
  const initial = state.flow!;
  assert(initial.prompt);
  await assert.rejects(
    foreign.command('answerProviderPrompt', {
      flowId: initial.id,
      promptId: initial.prompt.id,
      answer: 'browser',
    }),
    { code: 'InvalidInput' },
  );
  await client.command('answerProviderPrompt', {
    flowId: initial.id,
    promptId: initial.prompt.id,
    answer: 'browser',
  });
  state = await client.command('getProviders', {});
  assert.equal(state.flow?.canOpenUrl, true);
  await client.command('openProviderUrl', { flowId: initial.id });
  assert.equal(opened.length, 1);
  await assert.rejects(
    client.command('answerProviderPrompt', {
      flowId: initial.id,
      promptId: initial.prompt.id,
      answer: 'browser',
    }),
    { code: 'InvalidInput' },
  );
  const prompt = state.flow!.prompt!;
  await client.command('answerProviderPrompt', {
    flowId: initial.id,
    promptId: prompt.id,
    answer: 'private-code',
  });
  for (let i = 0; i < 10; i++) {
    state = await client.command('getProviders', {});
    if (state.flow?.state === 'completed') break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert(authenticated);
  assert.equal(state.flow?.state, 'completed');
  assert.equal(state.providers.find((provider) => provider.id === 'openai')?.configured, true);
  assert(!/private-(?:code|access|refresh)/.test(JSON.stringify(state)));
  await assert.rejects(client.command('openProviderUrl', { flowId: initial.id }), {
    code: 'InvalidInput',
  });
  state = await client.command('startProviderLogin', { providerId: 'openai-api-key' });
  const old = state.flow!;
  const service = await runtime.runPromise(ProviderSetupService);
  await runtime.runPromise(service.releaseOwner('document-a'));
  await assert.rejects(
    client.command('answerProviderPrompt', {
      flowId: old.id,
      promptId: old.prompt!.id,
      answer: 'private-key',
    }),
    { code: 'InvalidInput' },
  );
  const second = await foreign.command('startProviderLogin', { providerId: 'anthropic' });
  assert.equal(
    (await foreign.command('cancelProviderLogin', { flowId: second.flow!.id })).flow?.state,
    'cancelled',
  );
  await foreign.command('logoutProvider', { providerId: 'openai' });
  assert.equal(
    (await foreign.command('getProviders', {})).providers.find(
      (provider) => provider.id === 'openai',
    )?.configured,
    false,
  );
});

test('a status failure unwinds a newly started login before returning an error without flow ownership', async (t) => {
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  let signal: AbortSignal | undefined;
  for (const id of localProviderIds) {
    const faux = fauxProvider({ provider: id });
    models.setProvider({
      ...faux.provider,
      auth:
        id === 'openai'
          ? {
              oauth: {
                name: 'Controlled',
                login: async (interaction) => {
                  signal = interaction.signal;
                  await interaction.prompt({ type: 'text', message: 'Wait' });
                  throw Error('Unexpected completion');
                },
                refresh: async () => {
                  throw Error('No network');
                },
                toAuth: async () => ({}),
              },
            }
          : faux.provider.auth,
    });
  }
  let broken = false;
  const checkAuth = models.checkAuth.bind(models);
  models.checkAuth = (id, options) => {
    if (broken && id === 'anthropic') return Promise.reject(Error('Private storage diagnostic'));
    return checkAuth(id, options);
  };
  const runtime = ManagedRuntime.make(
    ProviderSetupLive({
      models,
      openUrl: async () => {},
      deviceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    }),
  );
  t.after(() => runtime.dispose());
  const client = makeProviderSetupClient(runtime, 'document');
  assert.equal((await client.command('getProviders', {})).flow, null);
  broken = true;
  await assert.rejects(client.command('startProviderLogin', { providerId: 'openai' }), {
    code: 'Unavailable',
  });
  assert.equal(signal?.aborted, true);
  broken = false;
  assert.equal((await client.command('getProviders', {})).flow, null);
});
