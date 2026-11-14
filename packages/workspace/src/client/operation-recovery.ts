import { Cause, Effect, Exit } from 'effect';
import type {
  CommandInput,
  OperationResult,
  WorkspaceOperation,
} from '@moonbase/contracts/workspace';
import type { HostOperationResult } from '@moonbase/contracts/workspace-host';
import {
  ObserverAccessError,
  RecoveryConflictError,
  RecoveryPublicationError,
} from '@moonbase/contracts/workspace-errors';
import {
  UnresolvedWorkError,
  WorkspaceConflictError,
} from '@moonbase/contracts/workspace-host-errors';
import { attempt, type WorkspaceFailure } from '../attempt.ts';
import { canonical, errorText, isOriginalResult, key, same } from '../validation.ts';
import type { OperationRecord } from './client-schema.ts';
import { reconcile } from './reconcile.ts';
import type { RecoveryContext } from './recovery-context.ts';

type MergedOperation = {
  id: string;
  record: OperationRecord;
  updated: OperationRecord;
  fresh: OperationResult['items'];
  changed: boolean;
};
export const dedupeChanges = (changes: OperationResult['recoveryChanges']) => [
  ...new Map(changes.map((change) => [canonical(change), change])).values(),
];

/** Takes the host's items and outcome into the client's record, ahead of publishing it. */
export function adoptHostResult(record: OperationRecord, host: HostOperationResult) {
  record.result = { ...record.result, items: host.items, outcome: host.outcome };
  if (host.message === undefined) delete record.result.message;
  else record.result.message = host.message;
}

/**
 * Answers a repeated operation from its record; `missing` says the host has no record of a
 * request left unanswered, so it never ran.
 */
export const replayOperation = (
  context: RecoveryContext,
  id: string,
  input: WorkspaceOperation,
  record: OperationRecord,
) =>
  Effect.gen(function* () {
    if (!same(record.input, input))
      return yield* new WorkspaceConflictError({ conflict: 'operation-payload' });
    if (context.activeOperations.has(id)) return { result: record.result, missing: false };
    if (record.publicationError) yield* publishOperation(context, id, record);
    const missing =
      !record.remote &&
      record.result.outcome === 'uncertain' &&
      (yield* resolveOperation(context, id, record)) === 'missing' &&
      record.result.items.length === 0;
    return { result: record.result, missing };
  });

/** Asks the host what became of an operation this client sent, and applies what it reports. */
export const resolveOperation = (
  context: RecoveryContext,
  id: string,
  record: OperationRecord,
): Effect.Effect<'found' | 'missing' | 'unavailable', WorkspaceFailure> =>
  Effect.gen(function* () {
    const asked = yield* Effect.exit(
      context.host.operationStatus({ clientId: record.input.clientId, id: record.input.id }),
    );
    if (Exit.isFailure(asked)) {
      if (Cause.hasInterruptsOnly(asked.cause)) return yield* Effect.failCause(asked.cause);
      return 'unavailable';
    }
    if (!asked.value) return 'missing';
    adoptHostResult(record, asked.value);
    yield* publishOperation(context, id, record);
    return 'found';
  });

/** One operation's result, after asking the host about it if its outcome is unknown. */
export const getOperationStatus = (
  context: RecoveryContext,
  input: CommandInput<'operationStatus'>,
) =>
  Effect.gen(function* () {
    const id = key(input.clientId, input.id),
      record = yield* attempt(() => context.store.get<OperationRecord>('operations', id));
    if (!record) return null;
    if (
      !context.activeOperations.has(id) &&
      !context.isCheckoutActive(record.input.checkout.checkoutId)
    ) {
      if (!record.remote && record.result.outcome === 'uncertain')
        yield* resolveOperation(context, id, record);
      else if (record.publicationError) yield* publishOperation(context, id, record);
    }
    return record.result;
  });

/**
 * Records that a client has taken in an operation's effect on its recovery. Returns whether the
 * host should now be told this client's own operation is settled.
 */
export const acknowledgeOperation = (
  context: RecoveryContext,
  input: CommandInput<'acknowledgeOperation'>,
) =>
  Effect.gen(function* () {
    const { store } = context;
    const id = key(input.operationClientId, input.id),
      record = yield* attempt(() => store.get<OperationRecord>('operations', id));
    if (!record || record.acknowledgedBy.includes(input.clientId)) return false;
    const observation = yield* attempt(() => store.readRecovery(input.clientId));
    if (
      input.clientId !== input.operationClientId &&
      !observation?.state.checkouts.some((c) => same(c, record.input.checkout))
    )
      return yield* new ObserverAccessError();
    if (
      record.publicationError ||
      record.result.items.some(
        (item) =>
          item.outcome === 'completed' && !(record.publishedItems ?? []).includes(canonical(item)),
      )
    )
      return yield* new RecoveryPublicationError({ pending: 'operation-acknowledgement' });
    if (record.result.outcome === 'uncertain')
      return yield* new UnresolvedWorkError({ state: 'operation-unacknowledgeable' });
    if (
      (yield* attempt(() => store.publication(input.clientId))) <=
      (record.publicationRevisions[input.clientId] ?? observation?.revision ?? 0)
    )
      return yield* new RecoveryPublicationError({ pending: 'reconcile-first' });
    yield* attempt(() =>
      context.putOperation(id, {
        ...record,
        acknowledgedBy: [...record.acknowledgedBy, input.clientId],
      }),
    );
    return !record.remote && input.clientId === input.operationClientId;
  });

export const markOperationAcknowledged = (context: RecoveryContext, id: string) =>
  attempt(() => {
    const record = context.store.get<OperationRecord>('operations', id);
    if (record) context.putOperation(id, { ...record, hostAcknowledged: true });
  });

/**
 * Applies an operation's completed items to every local recovery that names its checkout, and
 * records it, in one transaction. A failure is kept with the record (when the store can still
 * be written) and retried at the next load or repeat; the host also keeps the outcome until it
 * is acknowledged.
 */
export const publishOperation = (context: RecoveryContext, id: string, record: OperationRecord) =>
  context.store
    .transaction(() => applyOperations(context, [{ id, record }]))
    .pipe(
      Effect.map(([merged]) => {
        delete record.publicationError;
        Object.assign(record, merged.updated);
      }),
      Effect.catch((error) => attempt(() => recordPublicationFailure(context, id, record, error))),
      Effect.ignore,
    );

/** Keeps a record's failed publication, to be retried at the next load or repeat. */
export function recordPublicationFailure(
  context: RecoveryContext,
  id: string,
  record: OperationRecord,
  error: unknown,
) {
  record.publicationError =
    'Recovery publication pending; previous valid snapshot retained. ' + errorText(error);
  record.result.message = record.publicationError;
  try {
    const committed = context.store.get<OperationRecord>('operations', id);
    record.result.recoveryChanges = dedupeChanges([
      ...(committed?.result.recoveryChanges ?? []),
      ...record.result.recoveryChanges,
    ]);
    record.publishedItems = [
      ...new Set([...(committed?.publishedItems ?? []), ...(record.publishedItems ?? [])]),
    ];
    context.putOperation(id, record);
  } catch {
    /* The host still holds the outcome; the next load or repeat asks it again. */
  }
}

/**
 * Merges each record with what is stored and applies new items to the recoveries they touch.
 * Synchronous: the caller runs it in its transaction.
 */
export function applyOperations(
  context: RecoveryContext,
  entries: { id: string; record: OperationRecord }[],
) {
  const { store } = context;
  const merged = entries.map(({ id, record }) => mergeOperation(context, id, record));
  const changed = merged.filter((m) => m.changed);
  if (!changed.length) return merged;
  const { readable, unreadable } = store.readRecoveries();
  const applying = changed.filter((m) => m.fresh.length);
  // An unreadable client recovery is skipped here, so its draft may stay at a moved path:
  // the checkout's history is marked incomplete (every load reports the row).
  if (unreadable.length) for (const m of applying) context.markGap(m.updated.input.checkout);
  for (const { client, state, body, revision: current } of readable) {
    const relevant = changed.filter(
      (m) =>
        client === m.updated.input.clientId ||
        state.checkouts.some((c) => same(c, m.updated.input.checkout)),
    );
    if (!relevant.length) continue;
    let revision = current;
    const fresh = relevant.filter((m) => m.fresh.length);
    if (fresh.length) {
      const collisions = reconcile(
        state,
        fresh.map((m) => ({ ...m.updated, result: { ...m.updated.result, items: m.fresh } })),
      );
      for (const { checkout, paths } of collisions.values()) context.markGap(checkout, paths);
      if (JSON.stringify(state) !== body) {
        store.writeInternalRecovery(client, revision, state);
        const change = { clientId: client, previousRevision: revision, revision: revision + 1 };
        for (const m of fresh) m.updated.result.recoveryChanges.push(change);
        revision++;
      }
    }
    for (const m of relevant) m.updated.publicationRevisions[client] = revision;
  }
  for (const m of changed) {
    m.updated.result.recoveryChanges = dedupeChanges(m.updated.result.recoveryChanges);
    context.putOperation(m.id, m.updated);
  }
  return merged;
}

function mergeOperation(
  context: RecoveryContext,
  id: string,
  record: OperationRecord,
): MergedOperation {
  const committed = context.store.get<OperationRecord>('operations', id);
  if (committed && !same(committed.input, record.input))
    throw new RecoveryConflictError({ conflict: 'operation-identity' });
  const items = new Map(
    (committed?.result.items ?? []).map((item) => [
      canonical([item.source, item.destination]),
      item,
    ]),
  );
  for (const item of record.result.items) {
    const itemKey = canonical([item.source, item.destination]),
      previous = items.get(itemKey);
    if (previous?.outcome !== 'completed') items.set(itemKey, item);
  }
  const mergedItems = [...items.values()],
    originals = mergedItems.filter((item) => isOriginalResult(record.input.kind, item));
  const expected = record.input.sources.length || record.input.nativeReferences?.length || 1;
  let outcome: OperationResult['outcome'];
  if (record.remote) outcome = 'completed';
  else if (originals.length !== expected || originals.some((item) => item.outcome === 'uncertain'))
    outcome = 'uncertain';
  else if (originals.every((item) => item.outcome === 'completed')) outcome = 'completed';
  else outcome = 'failed';
  const published = new Set([
    ...(committed?.publishedItems ?? []),
    ...(record.publishedItems ?? []),
  ]);
  const fresh = mergedItems.filter(
    (item) => item.outcome === 'completed' && !published.has(canonical(item)),
  );
  const failed = record.publicationError ?? committed?.publicationError;
  if (
    committed &&
    same(committed.result.items, mergedItems) &&
    committed.result.outcome === outcome &&
    !fresh.length &&
    failed === undefined
  )
    return { id, record, updated: committed, fresh, changed: false };
  const updated: OperationRecord = {
    ...record,
    publicationRevisions: { ...record.publicationRevisions, ...committed?.publicationRevisions },
    acknowledgedBy: [...new Set([...(committed?.acknowledgedBy ?? []), ...record.acknowledgedBy])],
    publishedItems: [...published, ...fresh.map(canonical)],
    result: {
      ...record.result,
      items: mergedItems,
      outcome,
      recoveryChanges: [
        ...(committed?.result.recoveryChanges ?? []),
        ...record.result.recoveryChanges,
      ],
    },
  };
  delete updated.publicationError;
  if (
    updated.result.outcome !== 'uncertain' &&
    (failed !== undefined || committed?.result.outcome === 'uncertain')
  )
    delete updated.result.message;
  return { id, record, updated, fresh, changed: true };
}
