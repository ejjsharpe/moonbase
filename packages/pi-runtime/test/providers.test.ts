import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeProviderSetupClient } from '@moonbase/application/runtime/clients';
import { ProviderSetupLive, inactiveProviderOwnerMs, localProviderIds } from '../src/providers.ts';
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
  // Claude Code's catalog reuses the pinned Anthropic metadata; claude-code.test.ts covers the real one.
  const anthropic = anthropicProvider();
  models.setProvider({
    ...anthropic,
    id: 'claude-code',
    getModels: () => anthropic.getModels().map((model) => ({ ...model, provider: 'claude-code' })),
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

test('an unconfigured provider reports why its check failed, bounded for the status contract', async (t) => {
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const problem = 'Claude Code status check failed (exit 127):\0 \ud800' + 'é'.repeat(400),
    problems = new WeakMap<AbortSignal, string>();
  for (const id of localProviderIds) {
    const provider = fauxProvider({ provider: id }).provider;
    models.setProvider(
      id === 'claude-code'
        ? {
            ...provider,
            auth: {
              apiKey: {
                name: 'CLI',
                check: async ({ signal }) => {
                  problems.set(signal, problem);
                  return undefined;
                },
                resolve: async () => undefined,
              },
            },
          }
        : provider,
    );
  }
  const runtime = ManagedRuntime.make(
    ProviderSetupLive({
      models,
      deviceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      openUrl: async () => {},
      // Only the check that made it, and found nothing, reports one.
      getCheckProblem: (_id, signal) => problems.get(signal) ?? problem.slice(0, 5),
    }),
  );
  t.after(() => runtime.dispose());
  const status = await makeProviderSetupClient(runtime, 'problem').command('getProviders', {});
  const claude = status.providers.find((provider) => provider.id === 'claude-code')!;
  assert.equal(claude.configured, false);
  assert.match(claude.problem!, /^Claude Code status check failed \(exit 127\): é+$/);
  assert(new TextEncoder().encode(claude.problem).length <= 512);
  assert(new TextEncoder().encode(claude.problem).length > 500);
  for (const provider of status.providers)
    if (provider.id !== 'claude-code') {
      assert.equal(provider.configured, true);
      assert.equal(provider.problem, undefined);
    }
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
  assert.equal(
    state.providers.find((provider) => provider.id === 'claude-code')?.auth,
    'claude_code',
  );
  for (const operation of ['startProviderLogin', 'logoutProvider'] as const)
    await assert.rejects(foreign.command(operation, { providerId: 'claude-code' }), {
      code: 'InvalidInput',
      message: /claude auth login/,
    });
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

test('one sign-in per provider at a time, and owners that went quiet or exceed the bound lose their flows', async (t) => {
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const aborted: string[] = [];
  for (const id of localProviderIds) {
    // Each sign-in waits for its prompt until it is aborted.
    const waitForKey = async (interaction: {
      signal?: AbortSignal;
      prompt(prompt: { type: 'secret'; message: string }): Promise<string>;
    }) => {
      interaction.signal?.addEventListener('abort', () => aborted.push(id), { once: true });
      return interaction.prompt({ type: 'secret', message: 'Enter key' });
    };
    models.setProvider({
      ...fauxProvider({ provider: id }).provider,
      name: id,
      auth:
        id === 'openai'
          ? {
              oauth: {
                name: 'Controlled ChatGPT',
                login: async (interaction) => {
                  interaction.notify({
                    type: 'auth_url',
                    url: 'https://auth.openai.com/oauth/authorize?state=controlled',
                  });
                  return {
                    type: 'oauth',
                    access: await waitForKey(interaction),
                    refresh: 'refresh',
                    expires: 0,
                  };
                },
                refresh: async () => {
                  throw Error('No refresh');
                },
                toAuth: async (value) => ({ apiKey: value.access }),
              },
            }
          : {
              apiKey: {
                name: 'API key',
                login: async (interaction) => ({
                  type: 'api_key',
                  key: await waitForKey(interaction),
                }),
                resolve: async () => undefined,
              },
            },
    });
  }
  let time = 0;
  const runtime = ManagedRuntime.make(
    ProviderSetupLive({
      models,
      deviceId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      now: () => time,
    }),
  );
  t.after(() => runtime.dispose());
  const owner = (id: string) => makeProviderSetupClient(runtime, id);
  const flowOf = async (id: string) => (await owner(id).command('getProviders', {})).flow;

  // A client that restarted under a new owner takes over the provider's sign-in.
  const abandoned = await owner('crashed').command('startProviderLogin', { providerId: 'openai' });
  const other = await owner('other').command('startProviderLogin', { providerId: 'google' });
  const taken = await owner('restarted').command('startProviderLogin', { providerId: 'openai' });
  assert.deepEqual(aborted, ['openai']);
  assert.equal((await flowOf('crashed'))?.state, 'cancelled');
  assert.equal((await flowOf('crashed'))?.id, abandoned.flow!.id);
  assert.equal((await flowOf('restarted'))?.state, 'running');
  assert.equal((await flowOf('other'))?.id, other.flow!.id, 'another provider is untouched');
  assert.equal((await flowOf('other'))?.state, 'running');

  // An owner unheard from for the inactivity window loses its flow; one still polling keeps it,
  // and reading its sign-in URL counts as polling.
  const providers = await runtime.runPromise(ProviderSetupService);
  time += inactiveProviderOwnerMs - 1;
  assert.equal((await flowOf('restarted'))?.id, taken.flow!.id);
  time += inactiveProviderOwnerMs - 1;
  assert.equal(
    await runtime.runPromise(providers.getProviderUrl('restarted', taken.flow!.id)),
    'https://auth.openai.com/oauth/authorize?state=controlled',
  );
  time += 1;
  assert.equal(await flowOf('observer'), null);
  assert.equal((await flowOf('restarted'))?.state, 'running');
  assert.deepEqual(aborted.sort(), ['google', 'openai']);
  assert.equal(await flowOf('other'), null);
  assert.equal(await flowOf('crashed'), null);

  // At most 64 owners hold a flow; the least recently used go first.
  for (let index = 0; index < 70; index++) {
    time += 1;
    await owner(`document-${index}`).command('startProviderLogin', { providerId: 'anthropic' });
  }
  time += 1;
  assert.equal(await flowOf('document-0'), null);
  assert.equal(await flowOf('restarted'), null);
  assert.equal((await flowOf('document-69'))?.state, 'running');
  assert.equal((await flowOf('document-68'))?.state, 'cancelled');

  // Released owners stay refused within a bound; the oldest are forgotten.
  for (let index = 0; index < 300; index++)
    await runtime.runPromise(providers.releaseOwner(`released-${index}`));
  await assert.rejects(owner('released-299').command('getProviders', {}), {
    code: 'InvalidInput',
    message: 'The owning document was released.',
  });
  assert.equal(await flowOf('released-0'), null);
});
