import { Effect, Semaphore, Stream, SubscriptionRef } from 'effect';
import {
  emptyRecoveryState,
  type RecoveryOutline,
  type RecoveryState,
} from '@moonbase/contracts/recovery';
import { attempt } from '../attempt.ts';
import { same } from '../validation.ts';
import type { ClientStore } from './client-store.ts';

/** A recovery without its draft text: each draft names only the file text it was edited from. */
export function outlineRecovery(state: RecoveryState): RecoveryOutline {
  return {
    ...state,
    buffers: state.buffers.map(({ draft, ...buffer }) =>
      draft ? { ...buffer, draft: { baseline: draft.disk.version } } : buffer,
    ),
  };
}

/**
 * Every client's recovery outline, as committed in the store, in one `SubscriptionRef`. It is read
 * from the store when the client starts, so what committed before a crash is what it publishes,
 * and `refresh` takes in what commands committed since. A client's outline is replaced only when
 * it changed, so draft text (a keystroke) publishes nothing.
 */
export const makeRecoveryOutlines = (store: ClientStore) =>
  Effect.gen(function* () {
    const initial = yield* attempt(
      () =>
        new Map<string, RecoveryOutline>(
          store
            .readRecoveries()
            .readable.map(({ client, state }) => [client, outlineRecovery(state)]),
        ),
    ).pipe(Effect.orElseSucceed(() => new Map<string, RecoveryOutline>()));
    // The clients written so far are in the outlines already.
    store.takeWrittenClients();
    const outlines = yield* SubscriptionRef.make<ReadonlyMap<string, RecoveryOutline>>(initial);
    // One refresh at a time, so a later one never publishes an older read of the store.
    const turn = yield* Semaphore.make(1);
    const refresh = Semaphore.withPermit(turn)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(outlines);
        const next = yield* attempt(() => {
          let changed: Map<string, RecoveryOutline> | undefined;
          for (const client of store.takeWrittenClients()) {
            let outline: RecoveryOutline | undefined;
            try {
              const stored = store.readRecovery(client);
              outline = stored ? outlineRecovery(stored.state) : undefined;
            } catch {
              // An unreadable row keeps what was published; loading the client reports it.
              continue;
            }
            if (!outline || same(outline, current.get(client))) continue;
            (changed ??= new Map(current)).set(client, outline);
          }
          return changed;
        });
        if (next) yield* SubscriptionRef.set(outlines, next);
      }),
    ).pipe(Effect.ignore);
    const watch = (clientId: string) =>
      SubscriptionRef.changes(outlines).pipe(
        Stream.map((all) => all.get(clientId) ?? outlineRecovery(emptyRecoveryState(clientId))),
        Stream.changesWith((a: RecoveryOutline, b: RecoveryOutline) => same(a, b)),
      );
    return { refresh, watch };
  });
export type RecoveryOutlines = Effect.Success<ReturnType<typeof makeRecoveryOutlines>>;
