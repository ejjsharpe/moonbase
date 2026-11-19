import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deferred, Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import {
  EditorCheckouts,
  EditorLoader,
  EditorSession,
  EditorTextSearch,
  editorLayer,
  type TextSearch,
} from '@moonbase/application/editor';

const checkout: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'search',
  projectId: 'project',
  root: '/memory/search',
  vcs: 'git',
  branch: 'main',
  worktree: 'main',
};

/** Waits until the search shows `message`. */
const settled = (search: TextSearch, message: string) =>
  SubscriptionRef.changes(search.state).pipe(
    Stream.filter((state) => state.message === message),
    Stream.runHead,
  );

test('text search reports matches, replaces stale queries, explains invalid patterns and ends with the editor', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'original', 'b.ts': 'second' } }]);
  // Once `holding` is set, a search waits for `release` before it answers.
  let holding: { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
  const workspace = Layer.effect(
    WorkspaceService,
    Effect.map(Effect.service(WorkspaceService), (service) => ({
      ...service,
      searchText: (input: Parameters<typeof service.searchText>[0]) =>
        Effect.suspend(() =>
          holding
            ? Deferred.succeed(holding.entered, undefined).pipe(
                Effect.andThen(Deferred.await(holding.release)),
                Effect.andThen(service.searchText(input)),
              )
            : service.searchText(input),
        ),
    })),
  ).pipe(Layer.provide(memory.layer));
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(editorLayer({ clientId: 'search' }), workspace),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* EditorLoader).load;
        const opened = yield* (yield* EditorCheckouts).openCheckout(checkout.root);
        const search = yield* (yield* EditorTextSearch).make;
        const options = { matchCase: false, wholeWord: false, regex: false };
        // A newer query replaces one still waiting: only its answer arrives.
        yield* search.query('orig', options, opened);
        yield* search.query('SEC', options, opened);
        yield* settled(search, '1 match in 1 file');
        const [file] = (yield* SubscriptionRef.get(search.state)).files;
        assert.equal(file.path, 'b.ts');
        assert.deepEqual(file.matches[0].ranges, [{ start: 0, end: 3 }]);
        yield* search.query('SEC', { ...options, matchCase: true }, opened);
        yield* settled(search, 'No matches.');
        yield* search.query('(', { ...options, regex: true }, opened);
        yield* settled(search, 'Invalid regular expression.');
        yield* search.query('', options, opened);
        assert.deepEqual((yield* SubscriptionRef.get(search.state)).files, []);

        // Closing the editor while the popup stays open ends its search: a reply that arrives
        // later publishes nothing.
        const hold = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        holding = hold;
        yield* search.query('orig', options, opened);
        yield* Deferred.await(hold.entered);
        yield* (yield* EditorSession).close;
        yield* Deferred.succeed(hold.release, undefined);
        yield* Effect.yieldNow;
        assert.deepEqual((yield* SubscriptionRef.get(search.state)).files, []);
      }).pipe(Effect.scoped),
    );
  } finally {
    await runtime.dispose();
  }
});
