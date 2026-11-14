import { Effect } from 'effect';
import type { CommandInput } from '@moonbase/contracts/workspace';
import { RecoveryPublicationError } from '@moonbase/contracts/workspace-errors';
import { attempt } from '../attempt.ts';
import { cancellationPoint } from '../cancellation.ts';
import { canonical, hash, same } from '../validation.ts';
import { followCheckouts } from './feed-sync.ts';
import { fromLegacyRecovery } from './legacy-recovery.ts';
import type { RecoveryContext } from './recovery-context.ts';

/**
 * Publishes a client's path-keyed snapshot as its next revision, keeping the buffer IDs the store
 * holds for the paths it names. A checkout it adds is verified with the host and its operation
 * feed followed from now; a repeat of the same request returns its first receipt. A draft an
 * uncertain operation may still own cannot be dropped.
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
    const dropsHeldDraft = yield* attempt(() =>
      (retained?.buffers ?? []).some(
        (buffer) =>
          buffer.draft &&
          !input.state.drafts.some((d) => same(d.target, buffer.target)) &&
          context.isDraftHeld(buffer.target),
      ),
    );
    if (dropsHeldDraft) return yield* new RecoveryPublicationError({ pending: 'uncertain-draft' });
    return yield* store.persist(input, digest, (current) =>
      fromLegacyRecovery(input.state, current),
    );
  });
