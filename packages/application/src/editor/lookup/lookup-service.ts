import { Context, Effect, Exit, Layer, type Scope, Stream, type SubscriptionRef } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/workspace-service';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { describeEditorFailure } from '../alerts/alerts.ts';
import { EditorSession } from '../session/session-service.ts';
import { EditorViews } from '../views/views-service.ts';
import { EditorDiscovery } from '../discovery/discovery-service.ts';
import { checkoutKey, sameCheckout } from '../recovery/recovery-references.ts';
import { makeEditorQuery } from '../editor-query.ts';
import { emptyLookup, lookupCheckouts, rankLookup, type LookupSnapshot } from './lookup.ts';

/** One popup's file-name lookup. */
export type Lookup = {
  readonly state: SubscriptionRef.SubscriptionRef<LookupSnapshot>;
  /** Looks up `query` in up to 8 checkouts; earlier rows stay until the new ones arrive. */
  readonly query: (query: string, checkouts: readonly CheckoutTarget[]) => Effect.Effect<void>;
  /** Opens a result; a newer query cancels it. */
  readonly open: <E>(open: Effect.Effect<boolean, E>) => Effect.Effect<boolean>;
  readonly message: (message: string) => Effect.Effect<void>;
};

export type EditorLookupShape = {
  /** A popup's lookup, for as long as its scope: a change on disk refreshes its last query. */
  readonly make: Effect.Effect<Lookup, never, Scope.Scope>;
};

/** Debounced file-name lookups, one per popup. */
export class EditorLookup extends Context.Service<EditorLookup, EditorLookupShape>()(
  'moonbase/editor/EditorLookup',
) {
  static readonly layer = Layer.effect(
    EditorLookup,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceService;
      const session = yield* EditorSession;
      const views = yield* EditorViews;
      const discovery = yield* EditorDiscovery;
      return {
        make: Effect.gen(function* () {
          const runner = yield* makeEditorQuery(emptyLookup);
          yield* discovery.changes.pipe(
            Stream.runForEach(() => runner.refresh),
            Effect.forkScoped,
          );
          const search = (checkout: CheckoutTarget, query: string) =>
            Effect.gen(function* () {
              yield* views.view(checkout);
              const { recovery } = yield* views.get;
              return yield* workspace.lookupFiles({
                checkout,
                query,
                limit: 100,
                history: recovery.recentFiles
                  .filter((item) => sameCheckout(item.checkout, checkout))
                  .map((item) => item.path),
              });
            });
          return {
            state: runner.state,
            query: (query, checkouts) =>
              Effect.gen(function* () {
                if (!(yield* session.admits)) return;
                const key = JSON.stringify([query, checkouts.map(checkoutKey)]);
                // Earlier rows stay until the new ones arrive, so the list doesn't flicker while
                // typing. A refresh keeps its message too: the rows already answer the same query.
                if (!runner.repeats(key)) yield* runner.update({ message: 'Searching…' });
                const captured = structuredClone(checkouts);
                yield* runner.replace(
                  key,
                  Effect.gen(function* () {
                    const results = yield* Effect.all(
                      captured
                        .slice(0, lookupCheckouts)
                        .map((checkout) =>
                          Effect.exit(
                            Effect.map(search(checkout, query), (result) => ({ checkout, result })),
                          ),
                        ),
                      { concurrency: lookupCheckouts },
                    );
                    const errors = results.flatMap((exit) =>
                      Exit.isFailure(exit)
                        ? exit.cause.reasons.flatMap((reason) =>
                            reason._tag === 'Fail' ? [describeEditorFailure(reason.error)] : [],
                          )
                        : [],
                    );
                    const ranked = rankLookup(
                      results.flatMap((exit) => (Exit.isSuccess(exit) ? [exit.value] : [])),
                      errors,
                      captured.length > lookupCheckouts,
                    );
                    yield* runner.update({
                      rows: ranked.rows,
                      message: runner.resultMessage(ranked.message),
                    });
                  }),
                );
              }),
            open: (open) =>
              Effect.flatMap(session.admits, (admitted) =>
                admitted ? runner.open(open) : Effect.succeed(false),
              ),
            message: (message) =>
              Effect.flatMap(session.admits, (admitted) =>
                admitted ? runner.update({ message }) : Effect.void,
              ),
          } satisfies Lookup;
        }),
      } satisfies EditorLookupShape;
    }),
  );
}
