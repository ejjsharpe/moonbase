import { running, settings, target, until, type ChatFixture } from '../chat-fixture.ts';

// Shared setup for the outbox's tests: the commands it retains and how a test starts them.

export type Operation = 'createChat' | 'sendChat' | 'stopChat';
export const operations: Operation[] = ['createChat', 'sendChat', 'stopChat'];
export const mutations: string[] = operations;

/** The inputs the chat sent `operation` with, in order. */
export const inputs = (f: ChatFixture, operation: string) =>
  f.calls.filter((call) => call.operation === operation).map((call) => call.input);
/** The saved chat data in storage. */
export const saved = (f: ChatFixture) => JSON.parse(f.storage.value!);
/** The retained commands now, copied. */
export const pendingOf = async (f: ChatFixture) => structuredClone((await f.state()).pending);
/** A host's reply admitting the Send `input`. */
export const admitted = (input: { requestId: string }, submissionId = 'submission') => ({
  target,
  requestId: input.requestId,
  admission: 'admitted' as const,
  submissionId,
});

/** Selects 'draft-0' … and gives each a draft. */
export async function fillDrafts(f: ChatFixture, count: number) {
  for (let n = 0; n < count; n++) {
    await f.select({ ...target, conversationId: 'draft-' + n });
    await f.setDraft('retained-' + n);
  }
}

/** Runs `operation` on the open chat, publishing `stop`'s run first for a Stop. */
export async function begin(f: ChatFixture, operation: Operation, stop = running()) {
  if (operation === 'createChat') return f.create('Captured title', settings);
  if (operation === 'sendChat') return f.send(settings);
  f.publish(stop);
  await until(f, (state) => !!state.snapshot?.run);
  return f.stop();
}

/** Closes the chat and opens it again over the same storage, connected and verified. */
export async function restart(f: ChatFixture, overrides?: Parameters<ChatFixture['reopen']>[0]) {
  await f.reopen(overrides);
  await f.start();
  await f.connect();
  await until(f, (state) => state.ready);
}
