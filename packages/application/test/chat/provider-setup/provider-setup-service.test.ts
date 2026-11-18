import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SubscriptionRef } from 'effect';
import type { ProviderState } from '@moonbase/contracts/providers';
import { ChatProviderSetup } from '@moonbase/application/chat';
import {
  chatFixture,
  providerPort,
  turn,
  unavailable,
  waitFor,
  type ChatFixtureOptions,
} from '../chat-fixture.ts';

const status: ProviderState = { providers: [], flow: null };
const signingIn: ProviderState = {
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
const completed: ProviderState = {
  ...status,
  flow: { ...signingIn.flow!, state: 'completed', prompt: null },
};

/** A chat whose provider setup `answer` replies to, and its setup service. */
async function setupFixture(
  t: Parameters<typeof chatFixture>[0],
  answer: Parameters<typeof providerPort>[0],
  options: ChatFixtureOptions['dependencies'] = {},
) {
  const providers = providerPort(answer);
  const f = await chatFixture(t, { dependencies: { providers: providers.port, ...options } });
  const setup = f.service(ChatProviderSetup);
  return { f, setup, providers, shown: () => SubscriptionRef.getUnsafe(setup.state) };
}

test('a sign-in’s reply replaces a held status read, and answers never enter state or storage', async (t) => {
  const held = Promise.withResolvers<ProviderState>(),
    logout = Promise.withResolvers<ProviderState>();
  const { f, setup, providers, shown } = await setupFixture(t, (operation) => {
    if (operation === 'getProviders') return held.promise;
    if (operation === 'logoutProvider') return logout.promise;
    return operation === 'startProviderLogin' ? signingIn : completed;
  });
  const refreshing = f.run(setup.refresh);
  await waitFor(() => providers.calls.length === 1);
  await f.run(setup.login('openai'));
  held.resolve(status);
  await refreshing;
  assert.equal(shown().status?.flow?.id, 'flow');
  await f.run(setup.answer('flow', 'prompt', 'private-transient-answer'));
  assert.equal(shown().status?.flow?.state, 'completed');
  assert(!JSON.stringify(shown()).includes('private-transient-answer'));
  assert(!JSON.stringify(await f.state()).includes('private-transient-answer'));
  assert(!f.storage.value?.includes('private-transient-answer'));
  // An older command's late failure never replaces a newer command's reply.
  const loggingOut = f.run(setup.logout('openai'));
  await waitFor(() => providers.calls.some((call) => call.operation === 'logoutProvider'));
  await f.run(setup.login('openai'));
  logout.reject(unavailable());
  await loggingOut;
  assert.equal(shown().error, null);
  assert.equal(shown().status?.flow?.state, 'running');
});

test('sign-in progress comes from the watch, never from polling, and a dropped watch reopens', async (t) => {
  const { f, setup, providers, shown } = await setupFixture(
    t,
    (operation) => (operation === 'startProviderLogin' ? signingIn : status),
    { transcriptLimits: { watchRetryMs: [0] } },
  );
  await f.run(setup.refresh);
  assert.equal(providers.watches.length, 1);
  await f.run(setup.login('openai'));
  assert.equal(shown().status?.flow?.state, 'running');
  // The watch is the source once it delivers; a reply never overrides it.
  const [first] = providers.watches;
  first!.receive({
    ...signingIn,
    flow: { ...signingIn.flow!, message: 'Waiting for the browser' },
  });
  await waitFor(() => shown().status?.flow?.message === 'Waiting for the browser');
  await f.run(setup.answer('flow', 'prompt', 'key'));
  assert.equal(shown().status?.flow?.message, 'Waiting for the browser');
  first!.receive(completed);
  await waitFor(() => shown().status?.flow?.state === 'completed');
  // A dropped watch (a restarted daemon, say) opens again by itself after its backoff.
  first!.fail(unavailable());
  await waitFor(() => providers.watches.length === 2);
  assert.equal(first!.closed, true);
  // Once the backoff runs out it stays closed until a sign-in step opens it again.
  providers.watches[1]!.fail(unavailable());
  await waitFor(() => providers.watches[1]!.closed);
  await turn();
  assert.equal(providers.watches.length, 2);
  await f.run(setup.login('openai'));
  assert.equal(providers.watches.length, 3);
  // Nothing read providers again by itself: no timer polls a running flow.
  assert.deepEqual(
    providers.calls.map((call) => call.operation),
    ['getProviders', 'startProviderLogin', 'answerProviderPrompt', 'startProviderLogin'],
  );
  await f.close();
  assert(providers.watches.every((watch) => watch.closed));
});

test('closing the chat cancels a sign-in still running', async (t) => {
  const { f, setup, providers } = await setupFixture(t, () => signingIn);
  await f.run(setup.login('openai'));
  await f.close();
  assert.deepEqual(providers.calls.at(-1), {
    operation: 'cancelProviderLogin',
    input: { flowId: 'flow' },
  });
});
