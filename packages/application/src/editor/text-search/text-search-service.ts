import { Context, Effect, Exit, Layer, type Scope, Stream, type SubscriptionRef } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/services';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { describeEditorFailure } from '../alerts/alerts.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorViews } from '../views/views-service.ts';
import { EditorDiscovery } from '../discovery/discovery-service.ts';
import { checkoutKey } from '../recovery/recovery-references.ts';
import { makeEditorQuery } from '../editor-query.ts';
import {
  describeMatches,
  emptyTextSearch,
  type TextSearchOptions,
  type TextSearchSnapshot,
} from './text-search.ts';

/** One popup's search of a checkout's file contents. */
export type TextSearch = {
  readonly state: SubscriptionRef.SubscriptionRef<TextSearchSnapshot>;
  /** Searches one open checkout; a newer query cancels the running one. */
  readonly query: (
    query: string,
    options: TextSearchOptions,
    checkout: CheckoutTarget,
  ) => Effect.Effect<void>;
  readonly open: <E>(open: Effect.Effect<boolean, E>) => Effect.Effect<boolean>;
  readonly message: (message: string) => Effect.Effect<void>;
};

export type EditorTextSearchShape = {
  /** A popup's search, for as long as its scope: a change on disk refreshes its last query. */
  readonly make: Effect.Effect<TextSearch, never, Scope.Scope>;
};

/** Debounced searches of file contents, one per popup. */
export class EditorTextSearch extends Context.Service<EditorTextSearch, EditorTextSearchShape>()(
  'moonbase/editor/EditorTextSearch',
) {
  static readonly layer = Layer.effect(
    EditorTextSearch,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      const session = yield* EditorSession;
      const views = yield* EditorViews;
      const discovery = yield* EditorDiscovery;
      const admits = Effect.map(session.get, (s) => s.admissionsOpen && !s.closing);
      return {
        make: Effect.gen(function* () {
          const runner = yield* makeEditorQuery(emptyTextSearch);
          yield* discovery.changes.pipe(
            Stream.runForEach(() => runner.refresh),
            Effect.forkScoped,
          );
          return {
            state: runner.state,
            query: (query, options, checkout) =>
              Effect.gen(function* () {
                if (!(yield* admits)) return;
                const { matchCase, wholeWord, regex } = options;
                const key = JSON.stringify([
                  query,
                  matchCase,
                  wholeWord,
                  regex,
                  checkoutKey(checkout),
                ]);
                if (!query) {
                  yield* runner.replace(key, Effect.void);
                  yield* runner.update({
                    files: [],
                    checkout,
                    message: runner.resultMessage('Type text to search for.'),
                  });
                  return;
                }
                if (!runner.repeats(key)) yield* runner.update({ message: 'Searching…' });
                const input = {
                  matchCase,
                  wholeWord,
                  regex,
                  checkout: structuredClone(checkout),
                  query,
                };
                yield* runner.replace(
                  key,
                  Effect.gen(function* () {
                    const result = yield* Effect.exit(
                      Effect.andThen(views.view(input.checkout), workspace.searchText(input)),
                    );
                    if (Exit.isFailure(result)) {
                      const reason = result.cause.reasons.find((item) => item._tag === 'Fail');
                      yield* runner.update({
                        files: [],
                        checkout: input.checkout,
                        message: runner.resultMessage(
                          reason?._tag === 'Fail'
                            ? describeEditorFailure(reason.error)
                            : 'Search failed.',
                        ),
                      });
                      return;
                    }
                    yield* runner.update({
                      files: result.value.files,
                      checkout: input.checkout,
                      message: runner.resultMessage(describeMatches(result.value)),
                    });
                  }),
                );
              }),
            open: (open) =>
              Effect.flatMap(admits, (admitted) =>
                admitted ? runner.open(open) : Effect.succeed(false),
              ),
            message: (message) =>
              Effect.flatMap(admits, (admitted) =>
                admitted ? runner.update({ message }) : Effect.void,
              ),
          } satisfies TextSearch;
        }),
      } satisfies EditorTextSearchShape;
    }),
  );
}
