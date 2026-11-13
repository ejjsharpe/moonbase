import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeChatInput, decodeChatOutput } from './schema.ts';
import { decodeProviderInput, decodeProviderOutput } from '../providers/schema.ts';

const session = { host: { hostId: 'local', storeId: 'local-store' }, actorId: 'owner' };
test('local settings/host variants stay portable while setup inputs reject extra authority and status drops private fields', () => {
  const create = {
    session,
    requestId: 'create',
    title: 'Local',
    settings: { cwd: '/approved', model: { provider: 'openai', modelId: 'model' } },
  };
  assert.deepEqual(decodeChatInput('createChat', create), create);
  const withEffort = { ...create, settings: { ...create.settings, reasoningEffort: 'xhigh' } };
  assert.deepEqual(decodeChatInput('createChat', withEffort), withEffort);
  assert.throws(() =>
    decodeChatInput('createChat', {
      ...create,
      settings: { ...create.settings, reasoningEffort: 'invented' },
    }),
  );
  assert.deepEqual(decodeChatOutput('getChatHost', { ...session, mode: 'local' }), {
    ...session,
    mode: 'local',
  });
  assert.throws(() =>
    decodeChatInput('createChat', { ...create, settings: { ...create.settings, approved: true } }),
  );
  assert.throws(
    () =>
      decodeProviderInput('openProviderUrl', { flowId: 'flow', url: 'https://attacker.invalid' }),
    (error: unknown) => {
      assert(!String(error).includes('attacker.invalid'));
      return true;
    },
  );
  assert.throws(() =>
    decodeProviderInput('answerProviderPrompt', {
      flowId: 'flow',
      promptId: 'prompt',
      answer: 'private-key',
      ownerId: 'another-document',
    }),
  );
  const status = decodeProviderOutput('getProviders', {
    providers: [],
    token: 'private-token',
    flow: {
      id: 'flow',
      providerId: 'openai',
      state: 'running',
      message: 'Sign in',
      canOpenUrl: true,
      prompt: null,
      key: 'private-key',
    },
  });
  assert(!JSON.stringify(status).includes('private-'));
});
