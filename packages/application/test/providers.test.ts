import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMoonbaseApplication } from '@moonbase/application';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ProviderSetupClient, ProviderState } from '@moonbase/contracts/providers';
import { chatCapabilities } from './chat-capabilities-fixture.ts';

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
    watch: () => async () => {},
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
    watch: () => async () => {},
  };
  const application = await createMoonbaseApplication({
    chat: async () => ({ ...fixture.dependencies, providers }),
  });
  await application.chat!.providers!.login('openai');
  await assert.rejects(application.dispose(), /Setup cleanup failed/);
  assert.equal(application.getSnapshot().phase, 'failed');
});
test('sign-in progress comes from the watch, never from polling, and a failed watch reopens', async () => {
  const fixture = chatCapabilities(),
    calls: string[] = [];
  let receive: ((state: ProviderState) => void) | undefined,
    fail: ((error: ApplicationError) => void) | undefined,
    watches = 0,
    closes = 0;
  const providers: ProviderSetupClient = {
    command: async (operation) => {
      calls.push(operation);
      return operation === 'startProviderLogin' ? running : status;
    },
    watch: (onState, onError) => {
      watches++;
      receive = onState;
      fail = onError;
      return async () => {
        closes++;
      };
    },
  };
  const application = await createMoonbaseApplication({
    chat: async () => ({ ...fixture.dependencies, providers, transcriptWatchRetryMs: [0] }),
  });
  const controller = application.chat!.providers!;
  try {
    await controller.refresh();
    assert.equal(watches, 1);
    await controller.login('openai');
    assert.equal(controller.getSnapshot().status?.flow?.state, 'running');
    // The watch is the source once it delivers; a reply never overrides it.
    receive!({ ...running, flow: { ...running.flow!, message: 'Waiting for the browser' } });
    await controller.answer('flow', 'prompt', 'key');
    assert.equal(controller.getSnapshot().status?.flow?.message, 'Waiting for the browser');
    receive!({ ...status, flow: { ...running.flow!, state: 'completed', prompt: null } });
    assert.equal(controller.getSnapshot().status?.flow?.state, 'completed');
    // A dropped watch (a restarted daemon, say) opens again by itself after its backoff.
    fail!(new ApplicationError({ code: 'Unavailable', message: 'Gone.' }));
    assert.equal(closes, 1);
    while (watches < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    // Once the backoff runs out it stays closed until a sign-in step opens it again.
    fail!(new ApplicationError({ code: 'Unavailable', message: 'Gone again.' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(watches, 2);
    await controller.login('openai');
    assert.equal(watches, 3);
    // Nothing read providers again by itself: no timer polls a running flow.
    assert.deepEqual(calls, [
      'getProviders',
      'startProviderLogin',
      'answerProviderPrompt',
      'startProviderLogin',
    ]);
  } finally {
    await application.dispose();
  }
  assert.equal(closes, 3);
});
