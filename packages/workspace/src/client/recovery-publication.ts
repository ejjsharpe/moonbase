import { isPathAtOrInside } from '@moonbase/contracts/paths';
import { Effect } from 'effect';
import type { CommandInput } from '@moonbase/contracts/workspace';
import { RecoveryPublicationError } from '@moonbase/contracts/workspace-errors';
import { attempt } from '../attempt.ts';
import { cancellationPoint } from '../cancellation.ts';
import { canonical, hash, same } from '../validation.ts';
import { followCheckouts } from './feed-sync.ts';
import type { RecoveryContext } from './recovery-context.ts';

/**
 * Publishes a client's recovery as its next revision. A checkout it adds is verified with the
 * host and its operation feed followed from now; a repeat of the same request returns its first
 * receipt. A draft an uncertain operation may still own cannot be dropped.
 */
export const persistRecovery = (context: RecoveryContext, input: CommandInput<'persistRecovery'>) =>
  Effect.gen(function* () {
    const { store } = context;
    yield* cancellationPoint;
    const digest = hash(canonical(input)),
      previous = yield* attempt(() => store.replayPublication(input, digest));
    if (previous) return previous;
    // A checkout the client already recovered was approved, and its feed followed, when it was added.
    const retained = (yield* attempt(() => store.readRecovery(input.clientId)))?.state;
    const added = input.state.checkouts.filter(
      (target) => !retained?.checkouts.some((c) => same(c, target)),
    );
    for (const target of added) yield* context.host.verifyCheckout(target);
    if (added.length) yield* followCheckouts(context, added);
    yield* cancellationPoint;
    const state = input.state;
    for (const record of yield* attempt(() => context.getOpenOperations())) {
      if (record.result.outcome !== 'uncertain') continue;
      for (const draft of retained?.drafts ?? [])
        if (
          same(draft.target.checkout, record.input.checkout) &&
          record.input.sources.some((s) => isPathAtOrInside(draft.target.path, s.target.path)) &&
          !state.drafts.some((d) => same(d.target, draft.target))
        )
          return yield* new RecoveryPublicationError({ pending: 'uncertain-draft' });
    }
    return yield* store.persist(input, digest);
  });
