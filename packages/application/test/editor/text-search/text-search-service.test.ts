import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import {
  EditorCheckouts,
  EditorLoader,
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

test('text search reports matches, replaces stale queries and explains invalid patterns', async () => {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'original', 'b.ts': 'second' } }]);
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(editorLayer({ clientId: 'search' }), memory.layer),
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
      }).pipe(Effect.scoped),
    );
  } finally {
    await runtime.dispose();
  }
});
