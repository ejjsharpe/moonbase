import { Cause, Clock, Effect, Exit } from 'effect';
import { emptyRecovery, type EditorRecovery } from '@moonbase/contracts/workspace';
import { attempt, type WorkspaceFailure } from '../attempt.ts';
import { invalidStored } from '../store.ts';
import { SystemFailure } from '../system-failures.ts';
import { errorText, same } from '../validation.ts';
import type { SaveRecord, StoredSave } from './client-schema.ts';
import { pendingSaves } from './client-store.ts';
import { getFeedGapErrors, followRestoredCheckouts, syncFeed } from './feed-sync.ts';
import {
  markOperationAcknowledged,
  publishOperation,
  resolveOperation,
} from './operation-recovery.ts';
import {
  operationKey,
  saveKey,
  unresolvedSaves,
  type HostPorts,
  type RecoveryContext,
} from './recovery-context.ts';
import { acknowledgeSaves, applySaveStatus, publishSaves } from './save-recovery.ts';

/** Ports whose every call ends by `deadline`: one made after it fails at once. */
function boundedHost(host: HostPorts, deadline: number): HostPorts {
  const bound =
    <I, A>(call: (input: I) => Effect.Effect<A, WorkspaceFailure>) =>
    (input: I) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.timeoutOrElse(call(input), {
          duration: Math.max(0, deadline - now),
          orElse: () =>
            Effect.fail(new SystemFailure({ code: 'ETIMEDOUT', cause: 'host wait elapsed' })),
        }),
      );
  return {
    readFile: bound(host.readFile),
    verifyCheckout: bound(host.verifyCheckout),
    saveStatus: bound(host.saveStatus),
    acknowledgeSave: bound(host.acknowledgeSave),
    operationStatus: bound(host.operationStatus),
    acknowledgeOperation: bound(host.acknowledgeOperation),
    listOperations: bound(host.listOperations),
  };
}

/**
 * Resolves what the host knows of every save and operation this client left open: a settled
 * outcome is applied, a request the host never admitted is restored as a draft, and anything
 * still unclear is kept with its text. Returns, per save, why its restoration is still pending.
 */
const recoverEvidence = (context: RecoveryContext, openIds?: Set<string>) =>
  Effect.gen(function* () {
    const { store, host } = context;
    const notes = new Map<string, string>();
    const groups = new Map<string, SaveRecord[]>();
    for (const record of yield* attempt(() => store.readSaves(unresolvedSaves)))
      groups.set(record.input.clientId, [...(groups.get(record.input.clientId) ?? []), record]);
    yield* Effect.forEach(
      [...groups.values()],
      (records) =>
        Effect.gen(function* () {
          if (records.some((r) => context.isCheckoutActive(r.input.target.checkout.checkoutId)))
            return;
          const notStarted = new Set<string>();
          yield* Effect.forEach(
            records.filter((r) => !openIds || openIds.has(r.input.target.checkout.checkoutId)),
            (record) =>
              host
                .saveStatus({ clientId: record.input.clientId, requestId: record.input.requestId })
                .pipe(
                  Effect.map((status) => applySaveStatus(record, status, notStarted)),
                  // Restore admitted text without guessing an unavailable host's outcome.
                  Effect.ignore,
                ),
            { concurrency: 8, discard: true },
          );
          yield* followRestoredCheckouts(context, records);
          const published = yield* Effect.exit(publishSaves(context, records, true, notStarted));
          if (Exit.isFailure(published))
            for (const record of records)
              notes.set(
                saveKey(record.input),
                'Admitted Save recovery publication pending; previous valid snapshot retained. ' +
                  errorText(Cause.squash(published.cause)),
              );
        }),
      { concurrency: 8, discard: true },
    );
    yield* Effect.forEach(
      yield* attempt(() => context.getOpenOperations()),
      (record) => {
        const id = operationKey(record);
        if (context.isCheckoutActive(record.input.checkout.checkoutId)) return Effect.void;
        if (context.activeOperations.has(id)) return Effect.void;
        if (!record.remote && record.result.outcome === 'uncertain')
          return Effect.asVoid(resolveOperation(context, id, record));
        return record.publicationError ? publishOperation(context, id, record) : Effect.void;
      },
      { concurrency: 8, discard: true },
    );
    yield* acknowledgeSaves(
      context,
      (yield* attempt(() =>
        store.all<StoredSave>(
          'saves',
          pendingSaves + " AND json_extract(body, '$.state') = 'settled'",
        ),
      )).map((r) => ({ state: r.state, input: r.request })),
    );
    yield* Effect.forEach(
      (yield* attempt(() => context.getOpenOperations())).filter(
        (r) =>
          !r.remote &&
          !r.hostAcknowledged &&
          r.result.outcome !== 'uncertain' &&
          r.acknowledgedBy.includes(r.input.clientId),
      ),
      (record) =>
        host.acknowledgeOperation({ clientId: record.input.clientId, id: record.input.id }).pipe(
          Effect.andThen(markOperationAcknowledged(context, operationKey(record))),
          // The host keeps the entry until the next acknowledgement.
          Effect.ignore,
        ),
      { concurrency: 8, discard: true },
    );
    return notes;
  });

/**
 * A client's recovery as it loads: the feed of other clients' moves, the outcomes of its open
 * saves and operations, and its open checkouts, each asked of the host within `hostWaitMs`
 * together. What the host did not answer in time is retried on the next load; local work
 * (drafting unsettled saves) needs no host.
 */
export const loadRecovery = (context: RecoveryContext, clientId: string, hostWaitMs: number) =>
  Effect.gen(function* () {
    const { store } = context;
    const recoveries = yield* attempt(() => store.readRecoveries());
    // This client's own recovery must read; another's that does not is reported.
    if (recoveries.unreadable.some((r) => r.client === clientId))
      return yield* Effect.fail(invalidStored());
    const before = recoveries.readable.find((r) => r.client === clientId);
    const errors = recoveries.unreadable.map(
      ({ client, error }) => 'Recovery of ' + client + ' is unreadable: ' + error,
    );
    const deadline = (yield* Clock.currentTimeMillis) + hostWaitMs;
    const expired = Effect.map(Clock.currentTimeMillis, (now) => now >= deadline);
    const bounded = context.withHost(boundedHost(context.host, deadline));
    // One phase's failure is reported (unless the host ran out of time) and the next still runs.
    const phase = <A>(effect: Effect.Effect<A, WorkspaceFailure>) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(effect);
        if (Exit.isSuccess(exit)) return exit.value;
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause);
        if (!(yield* expired)) errors.push(errorText(Cause.squash(exit.cause)));
        return undefined;
      });
    errors.push(...((yield* phase(syncFeed(bounded, recoveries.readable, expired))) ?? []));
    const notes =
      (yield* phase(recoverEvidence(bounded, new Set(before?.state.openCheckoutIds ?? [])))) ??
      new Map<string, string>();
    const stored = yield* attempt(() => store.readRecovery(clientId)),
      state: EditorRecovery = stored?.state ?? emptyRecovery(clientId);
    yield* Effect.forEach(
      state.checkouts.filter((c) => state.openCheckoutIds.includes(c.checkoutId)),
      (target) =>
        Effect.gen(function* () {
          if (yield* expired) return;
          const checked = yield* Effect.exit(bounded.host.verifyCheckout(target));
          if (
            Exit.isFailure(checked) &&
            !Cause.hasInterruptsOnly(checked.cause) &&
            !(yield* expired)
          )
            errors.push(target.root + ': ' + errorText(Cause.squash(checked.cause)));
        }),
      { concurrency: 8, discard: true },
    );
    if (yield* expired)
      errors.push(
        'The local host did not answer in time; files are checked again on the next load.',
      );
    return yield* attempt(() => {
      const relevant = context
        .getOpenOperations()
        .filter(
          (r) =>
            !r.acknowledgedBy.includes(clientId) &&
            (r.input.clientId === clientId ||
              state.checkouts.some((c) => same(c, r.input.checkout))),
        );
      for (const record of relevant)
        if (record.publicationRevisions[clientId] === undefined) {
          record.publicationRevisions[clientId] = stored?.revision ?? 0;
          context.putOperation(operationKey(record), record);
        }
      for (const record of relevant)
        if (record.publicationError) errors.push(record.publicationError);
      const operations = relevant.map((r) => r.result);
      for (const operation of operations)
        if (operation.outcome === 'uncertain')
          errors.push(
            'Uncertain operation ' +
              operation.id +
              ': ' +
              (operation.message ??
                'inspect original, destination, staging and Finder Trash; drafts retained.'),
          );
      for (const record of store.all<StoredSave>(
        'saves',
        unresolvedSaves + " AND json_extract(body, '$.request.clientId') = ?",
        [clientId],
      ))
        errors.push(
          'Uncertain save ' +
            record.request.requestId +
            ' for ' +
            record.request.target.path +
            ': inspect disk; journal text retained.' +
            (record.message ? ' ' + record.message : '') +
            (notes.has(saveKey(record.request)) ? ' ' + notes.get(saveKey(record.request)) : ''),
        );
      errors.push(...getFeedGapErrors(context, state));
      return { revision: stored?.revision ?? 0, state, errors, operations };
    });
  });
