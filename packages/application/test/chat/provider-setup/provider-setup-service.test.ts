import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Fiber, Scheduler, SubscriptionRef } from 'effect';
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
  let heldLogin = (): ProviderState | Promise<ProviderState> => signingIn;
  const { f, setup, providers, shown } = await setupFixture(t, (operation) => {
    if (operation === 'getProviders') return held.promise;
    if (operation === 'logoutProvider') return logout.promise;
    return operation === 'startProviderLogin' ? heldLogin() : completed;
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
  // An older command's late failure never replaces a newer command's reply: the logout fails
  // once the newer login has started, and setup stays busy until the login settles too.
  const loggingOut = f.run(setup.logout('openai'));
  await waitFor(() => providers.calls.some((call) => call.operation === 'logoutProvider'));
  const loggedOut = Promise.withResolvers<void>();
  heldLogin = async () => {
    logout.reject(unavailable());
    await loggedOut.promise;
    return signingIn;
  };
  const loggingIn = f.run(setup.login('openai'));
  await loggingOut;
  // Read before the login is released, and assert after, so a failure never leaves it held.
  const { error, busy } = shown();
  loggedOut.resolve();
  await loggingIn;
  assert.deepEqual({ error, busy }, { error: null, busy: true });
  assert.equal(shown().busy, false);
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

test('closing the chat cancels a sign-in still running, even one its caller stopped waiting for', async (t) => {
  const held = Promise.withResolvers<ProviderState>();
  let caller: Fiber.Fiber<unknown, unknown> | undefined;
  const { f, setup, providers } = await setupFixture(t, (operation) => {
    if (operation !== 'startProviderLogin') return signingIn;
    // The caller is interrupted as soon as the host has the login.
    caller!.interruptUnsafe();
    return held.promise;
  });
  const loggingIn = f.runtime.runFork(
    Effect.withFiber((fiber) => {
      caller = fiber;
      return setup.login('openai');
    }),
  );
  assert(Exit.hasInterrupts(await f.runtime.runPromise(Fiber.await(loggingIn))));
  const closing = f.close();
  held.resolve(signingIn);
  await closing;
  assert.deepEqual(providers.calls.at(-1), {
    operation: 'cancelProviderLogin',
    input: { flowId: 'flow' },
  });
});

test('closing the chat waits for a sign-in caught starting, then cancels it once', async (t) => {
  const held = Promise.withResolvers<ProviderState>();
  const { f, setup, providers, shown } = await setupFixture(t, (operation) =>
    operation === 'startProviderLogin' ? held.promise : status,
  );
  await f.run(setup.refresh);
  // The login yields to the event loop every few steps, so closing starts once it is admitted
  // but before it has started.
  const loggingIn = f.runtime.runFork(
    setup.login('openai').pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3)),
  );
  await waitFor(() => shown().busy);
  const closing = f.close();
  held.resolve(signingIn);
  await closing;
  await f.runtime.runPromise(Fiber.await(loggingIn));
  assert.deepEqual(
    providers.calls.filter((call) => call.operation === 'cancelProviderLogin'),
    [{ operation: 'cancelProviderLogin', input: { flowId: 'flow' } }],
  );
  assert.equal(shown().busy, false);
});
