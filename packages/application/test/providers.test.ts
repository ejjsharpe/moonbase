import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMoonbaseApplication } from '@moonbase/application';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ProviderSetupClient, ProviderState } from '@moonbase/contracts/providers';
import { chatCapabilities } from './chat-capabilities.ts';

const status: ProviderState = { providers: [], flow: null };
const running: ProviderState = {
  providers: [],
  flow: {
    id: 'flow',
    providerId: 'openai',
    state: 'running',
    message: 'Sign in',
    canOpenUrl: true,
    prompt: { id: 'prompt', type: 'secret', message: 'Key', options: [] },
  },
};
test('setup rejects stale status replies and keeps transient answers out of snapshots/storage', async () => {
  const fixture = chatCapabilities(),
    held = Promise.withResolvers<ProviderState>();
  const providers: ProviderSetupClient = {
    command: async (operation) => {
      if (operation === 'getProviders') return held.promise;
      if (operation === 'startProviderLogin') return running;
      return { ...status, flow: { ...running.flow!, state: 'completed', prompt: null } };
    },
  };
  const application = await createMoonbaseApplication({
    chat: async () => ({ ...fixture.dependencies, providers }),
  });
  const controller = application.chat!.providers!;
  try {
    const refresh = controller.refresh();
    await controller.login('openai');
    held.resolve(status);
    await refresh;
    assert.equal(controller.getSnapshot().status?.flow?.id, 'flow');
    await controller.answer('flow', 'prompt', 'private-transient-answer');
    assert.equal(controller.getSnapshot().status?.flow?.state, 'completed');
    assert(!JSON.stringify(controller.getSnapshot()).includes('private-transient-answer'));
    assert(!fixture.storage.value?.includes('private-transient-answer'));
  } finally {
    await application.dispose();
  }
});
test('provider setup cleanup failure remains part of the root disposal outcome', async () => {
  const fixture = chatCapabilities();
  const providers: ProviderSetupClient = {
    command: async (operation) => {
      if (operation === 'cancelProviderLogin')
        throw new ApplicationError({ code: 'Persistence', message: 'Setup cleanup failed.' });
      return running;
    },
  };
  const application = await createMoonbaseApplication({
    chat: async () => ({ ...fixture.dependencies, providers }),
  });
  await application.chat!.providers!.login('openai');
  await assert.rejects(application.dispose(), /Setup cleanup failed/);
  assert.equal(application.getSnapshot().phase, 'failed');
});
