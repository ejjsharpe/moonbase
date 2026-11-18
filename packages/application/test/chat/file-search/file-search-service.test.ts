import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Exit, Scope, SubscriptionRef } from 'effect';
import { ChatFileSearch } from '@moonbase/application/chat';
import {
  chatFixture,
  context,
  target,
  turn,
  unavailable,
  until,
  waitFor,
} from '../chat-fixture.ts';

test('file search asks the host about the open chat’s folder, or a new chat’s', async (t) => {
  const f = await chatFixture(t);
  const findFiles = (query: string, cwd?: string) =>
    f.run(
      Effect.flatMap(ChatFileSearch, (search) => search.findFiles(query, cwd)).pipe(Effect.result),
    );
  await f.start();
  const offline = await findFiles('a');
  assert(offline._tag === 'Failure' && offline.failure._tag === 'ChatRefusedError');
  assert.equal(offline.failure.reason, 'not-connected');
  await f.connect();
  await until(f, (state) => state.ready);
  const reply = { query: 'a', matches: [{ path: 'a.ts', positions: [0] }], partial: false };
  f.answers.set('findChatFiles', () => reply);
  // A new chat without a folder has nothing to search.
  const unchosen = await findFiles('a');
  assert(unchosen._tag === 'Failure' && unchosen.failure._tag === 'ChatRefusedError');
  assert.equal(unchosen.failure.reason, 'no-folder');
  const chosen = await findFiles('a', '/chosen');
  assert(chosen._tag === 'Success');
  assert.deepEqual(chosen.success, reply);
  assert.deepEqual(f.calls.at(-1)!.input, { session: context, cwd: '/chosen', query: 'a' });
  await f.select(target);
  await findFiles('a', '/ignored');
  assert.deepEqual(f.calls.at(-1)!.input, { target, query: 'a' });
});

test('a file picker shows only the latest answer and cancels the searches before it', async (t) => {
  const f = await chatFixture(t);
  await f.start();
  await f.connect();
  await until(f, (state) => state.ready);
  const searches: {
    input: { query: string; cwd?: string };
    signal: AbortSignal;
    reply: PromiseWithResolvers<unknown>;
  }[] = [];
  f.answers.set('findChatFiles', (input: { query: string; cwd?: string }, signal: AbortSignal) => {
    const reply = Promise.withResolvers<unknown>();
    searches.push({ input, signal, reply });
    return reply.promise;
  });
  const scope = Scope.makeUnsafe();
  const picker = await f.run(
    Effect.provideService(
      Effect.flatMap(ChatFileSearch, (search) => search.make),
      Scope.Scope,
      scope,
    ),
  );
  const shown = () => SubscriptionRef.getUnsafe(picker.state);
  await f.run(picker.search('a', '/work'));
  await waitFor(() => searches.length === 1);
  await f.run(picker.search('ab', '/work'));
  await waitFor(() => searches.length === 2);
  assert.equal(searches[0]!.signal.aborted, true);
  assert.equal(searches[1]!.input.cwd, '/work');
  assert.equal(shown().busy, true);
  searches[0]!.reply.resolve({
    query: 'a',
    matches: [{ path: 'stale.ts', positions: [] }],
    partial: false,
  });
  searches[1]!.reply.resolve({
    query: 'ab',
    matches: [{ path: 'ab.ts', positions: [0, 1] }],
    partial: true,
  });
  await waitFor(() => !shown().busy);
  assert.deepEqual(shown(), {
    query: 'ab',
    matches: [{ path: 'ab.ts', positions: [0, 1] }],
    partial: true,
    busy: false,
    error: null,
  });
  await f.run(picker.search('abc', '/work'));
  await waitFor(() => searches.length === 3);
  searches[2]!.reply.reject(unavailable('No ripgrep or Git.'));
  await waitFor(() => !shown().busy);
  assert.ok(shown().error);
  assert.deepEqual(shown().matches, []);
  // Closing the picker cancels its search.
  await f.run(picker.search('x', '/work'));
  await waitFor(() => searches.length === 4);
  await f.runtime.runPromise(Scope.close(scope, Exit.void));
  await turn();
  assert.equal(searches[3]!.signal.aborted, true);
});
