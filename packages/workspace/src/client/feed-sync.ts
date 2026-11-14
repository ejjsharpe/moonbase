import { Effect, Exit } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { RecoveryState } from '@moonbase/contracts/recovery';
import type { OperationFeed, OperationFeedEntry } from '@moonbase/contracts/workspace-host';
import { attempt } from '../attempt.ts';
import { canonical, errorText, key } from '../validation.ts';
import type { FeedCursor, FeedGap, OperationRecord, SaveRecord } from './client-schema.ts';
import type { StoredRecovery } from './client-store.ts';
import { applyOperations, recordPublicationFailure } from './operation-recovery.ts';
import { feedKey, type RecoveryContext } from './recovery-context.ts';

/**
 * Starts following the operation feed of checkouts entering the recovery at the host's present
 * position, so moves made after this are applied however long before the next load. A checkout
 * another local recovery already names keeps its position. A host that cannot list it leaves it
 * to the next feed sync.
 */
export const followCheckouts = (context: RecoveryContext, targets: CheckoutTarget[]) =>
  Effect.gen(function* () {
    const { store } = context;
    const { readable } = yield* attempt(() => store.readRecoveries());
    for (const target of targets) {
      const followed =
        context.getFeedCursor(target) &&
        readable.some((r) =>
          r.state.checkouts.some(
            (c) => c.hostId === target.hostId && c.checkoutId === target.checkoutId,
          ),
        );
      if (followed) continue;
      const feed = yield* Effect.exit(
        context.host.listOperations({ checkout: target, after: null }),
      );
      yield* attempt(() => {
        if (Exit.isSuccess(feed))
          store.put('feed-cursors', feedKey(target), {
            sequence: feed.value.through,
            epoch: feed.value.epoch,
          });
        // The next feed sync starts it, marking the checkout's history as incomplete.
        else store.delete('feed-cursors', feedKey(target));
      });
    }
  });

/**
 * Starts following the feed of checkouts a save's restored text may bring into the recovery, so
 * they are not later reported as having an unknown history. A host that cannot answer leaves
 * that to the next feed sync.
 */
export const followRestoredCheckouts = (context: RecoveryContext, records: SaveRecord[]) => {
  const targets = new Map(
    records.map((r) => [feedKey(r.input.target.checkout), r.input.target.checkout]),
  );
  return Effect.forEach(
    [...targets],
    ([id, target]) =>
      Effect.gen(function* () {
        if (context.store.get<FeedCursor>('feed-cursors', id)) return;
        const feed = yield* context.host.listOperations({ checkout: target, after: null });
        yield* attempt(() =>
          context.store.put('feed-cursors', id, { sequence: feed.through, epoch: feed.epoch }),
        );
      }).pipe(
        // The next feed sync starts it and reports what it could not know.
        Effect.ignore,
      ),
    { concurrency: 8, discard: true },
  );
};

/**
 * Applies completed moves, copies and Trash that other installations' clients made in the local
 * recoveries' checkouts since each checkout's position. A checkout whose history cannot be listed
 * keeps its position and is listed again on the next load. Returns messages for what failed.
 */
export const syncFeed = (
  context: RecoveryContext,
  recoveries: StoredRecovery[],
  /** Whether the host has run out of time, after which its failures are reported once instead. */
  expired: Effect.Effect<boolean>,
) =>
  Effect.gen(function* () {
    const targets = new Map<string, CheckoutTarget>();
    for (const { state } of recoveries)
      for (const target of state.checkouts) targets.set(feedKey(target), target);
    const errors: string[] = [];
    yield* Effect.forEach(
      [...targets.values()],
      (target) =>
        syncCheckoutFeed(context, target).pipe(
          Effect.catch((error) =>
            Effect.map(expired, (late) => {
              if (!late)
                errors.push(
                  'Operation history unavailable for ' + target.root + ': ' + errorText(error),
                );
            }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
    return errors;
  });

const syncCheckoutFeed = (context: RecoveryContext, target: CheckoutTarget) =>
  Effect.gen(function* () {
    const { store } = context;
    const id = feedKey(target);
    // What came before the present is unknowable: drafts there are reported until resolved.
    const restart = Effect.gen(function* () {
      const feed = yield* context.host.listOperations({ checkout: target, after: null });
      yield* store.transaction(() => {
        context.markGap(target);
        store.put('feed-cursors', id, { sequence: feed.through, epoch: feed.epoch });
      });
    });
    let cursor = yield* attempt(() => store.get<FeedCursor>('feed-cursors', id));
    // A checkout that entered a recovery without being followed (such as by a restored save).
    if (!cursor) return yield* restart;
    for (;;) {
      const feed: OperationFeed = yield* context.host.listOperations({
        checkout: target,
        after: cursor.sequence,
      });
      // A recreated host store restarts its sequence.
      if (feed.epoch !== cursor.epoch) return yield* restart;
      yield* applyFeedPage(context, target, cursor, feed);
      if (!feed.more) return;
      cursor = { sequence: feed.through, epoch: feed.epoch };
    }
  });

/**
 * Applies one page of a checkout's feed and advances its position in one transaction. A page
 * that cannot be applied to the recovery (one too large for it, say) is kept with its error, to
 * be retried at each load like an operation of this client's, and the position still advances.
 */
const applyFeedPage = (
  context: RecoveryContext,
  target: CheckoutTarget,
  cursor: FeedCursor,
  feed: OperationFeed,
) =>
  Effect.gen(function* () {
    const { store } = context;
    const records = yield* attempt(() => readFeedRecords(context, feed.operations));
    const advance = () => {
      if (feed.floor > cursor.sequence) context.markGap(target);
      store.put('feed-cursors', feedKey(target), { sequence: feed.through, epoch: feed.epoch });
    };
    yield* store
      .transaction(() => {
        if (records.length) applyOperations(context, structuredClone(records));
        advance();
      })
      .pipe(
        Effect.catch((error) =>
          store.transaction(() => {
            for (const { id, record } of records)
              recordPublicationFailure(context, id, record, error);
            advance();
          }),
        ),
      );
  });

/** Other installations' feed entries as remote operation records, one per operation. */
function readFeedRecords(context: RecoveryContext, entries: OperationFeedEntry[]) {
  const records = new Map<string, OperationRecord>();
  for (const entry of entries) {
    // This installation applies its own results as they return.
    if (entry.installationId === context.installationId) continue;
    const id = key(entry.clientId, entry.id);
    let record = records.get(id) ?? context.store.get<OperationRecord>('operations', id);
    if (record && !record.remote) continue;
    record ??= {
      open: true,
      input: {
        id: entry.id,
        clientId: entry.clientId,
        checkout: entry.checkout,
        kind: entry.kind,
        sources: [],
      },
      remote: true,
      result: {
        id: entry.id,
        clientId: entry.clientId,
        recoveryChanges: [],
        checkout: entry.checkout,
        kind: entry.kind,
        outcome: 'completed',
        items: [],
      },
      publishedItems: [],
      publicationRevisions: {},
      acknowledgedBy: [],
    };
    const known = new Set(record.result.items.map((item) => canonical(item)));
    record.result.items = [
      ...record.result.items,
      ...entry.items.filter((item) => !known.has(canonical(item))),
    ];
    records.set(id, record);
  }
  return [...records].map(([id, record]) => ({ id, record }));
}

/** A gap's mark stays while any local recovery still holds a draft in its checkout. */
export function getFeedGapErrors(context: RecoveryContext, state: RecoveryState) {
  const { store } = context;
  const gaps = store.all<FeedGap>('feed-gaps');
  if (!gaps.length) return [];
  const errors: string[] = [];
  const { readable, unreadable } = store.readRecoveries();
  for (const gap of gaps) {
    // An unreadable recovery may hold a draft in any gapped checkout: its marks stay (the load
    // reports the unreadable row).
    const held =
      unreadable.length > 0 ||
      readable.some((r) =>
        r.state.buffers.some((b) => b.draft && b.target.checkout.checkoutId === gap.checkoutId),
      );
    if (!held) store.delete('feed-gaps', key(gap.hostId, gap.checkoutId));
    else {
      const drafted = state.buffers.filter(
        (b) => b.draft && b.target.checkout.checkoutId === gap.checkoutId,
      );
      if (!drafted.length) continue;
      const stranded = (gap.stranded ?? []).filter((p) => drafted.some((b) => b.target.path === p));
      errors.push(
        'Operation history for ' +
          gap.checkoutId +
          ' is incomplete: drafts stay at their last known paths and need attention.' +
          (stranded.length
            ? ' These drafts stayed behind when their file moved onto another draft: ' +
              stranded.join(', ') +
              '.'
            : ''),
      );
    }
  }
  return errors;
}
