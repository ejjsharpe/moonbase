import { isPathAtOrInside } from '@moonbase/contracts/paths';
import { Effect } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type {
  HostOperationResult,
  OperationFeed,
  SaveStatus,
} from '@moonbase/contracts/workspace-host';
import { UnresolvedWorkError } from '@moonbase/contracts/workspace-host-errors';
import { attempt, type WorkspaceFailure } from '../attempt.ts';
import { getOperationPaths } from '../operation-paths.ts';
import { canonical, key, overlaps, same } from '../validation.ts';
import type { FeedCursor, OperationRecord, StoredSave } from './client-schema.ts';
import { openOperations, pendingSaves, type ClientStore } from './client-store.ts';

/** The file host as the client's recovery asks it, with the installation already bound. */
export type HostPorts = {
  readFile(target: {
    checkout: CheckoutTarget;
    path: string;
  }): Effect.Effect<{ text: string; version: string }, WorkspaceFailure>;
  verifyCheckout(target: CheckoutTarget): Effect.Effect<void, WorkspaceFailure>;
  saveStatus(input: {
    clientId: string;
    requestId: string;
  }): Effect.Effect<SaveStatus, WorkspaceFailure>;
  acknowledgeSave(input: {
    clientId: string;
    requestId: string;
  }): Effect.Effect<void, WorkspaceFailure>;
  operationStatus(input: {
    clientId: string;
    id: string;
  }): Effect.Effect<HostOperationResult | null, WorkspaceFailure>;
  acknowledgeOperation(input: {
    clientId: string;
    id: string;
  }): Effect.Effect<void, WorkspaceFailure>;
  listOperations(input: {
    checkout: CheckoutTarget;
    after: number | null;
  }): Effect.Effect<OperationFeed, WorkspaceFailure>;
};
export type Recoveries = ReturnType<ClientStore['readRecoveries']>;

export const saveKey = (request: { clientId: string; requestId: string }) =>
  key(request.clientId, request.requestId);
export const operationKey = (record: OperationRecord) =>
  key(record.input.clientId, record.input.id);
export const feedKey = (target: CheckoutTarget) => key(target.hostId, target.checkoutId);
/** Saves whose outcome is not yet in the recovery. */
export const unresolvedSaves = pendingSaves + " AND json_extract(body, '$.state') <> 'settled'";

/** Whether anything is left to do for an operation record (see `OperationRecord.open`). */
function isOpen(record: OperationRecord) {
  const published = record.publishedItems ?? [];
  const owners = [
    ...(record.remote ? [] : [record.input.clientId]),
    ...Object.keys(record.publicationRevisions),
  ];
  return (
    record.result.outcome === 'uncertain' ||
    record.publicationError !== undefined ||
    record.result.items.some(
      (item) => item.outcome === 'completed' && !published.includes(canonical(item)),
    ) ||
    owners.some((client) => !record.acknowledgedBy.includes(client)) ||
    (!record.remote && !record.hostAcknowledged)
  );
}

/**
 * What one client store's recovery works with: the store, the file host as it may ask it now,
 * and which saves and operations are running in this process. `withHost` gives the same
 * recovery another way of asking the host (one bounded by a deadline, or one a cancelled caller
 * cannot stop).
 */
export class RecoveryContext {
  readonly store: ClientStore;
  readonly host: HostPorts;
  readonly installationId: string;
  /** Running saves and operations, by ID, with the checkout each holds. */
  readonly activeSaves: Map<string, string>;
  readonly activeOperations: Map<string, string>;
  constructor({
    store,
    host,
    installationId,
    activeSaves = new Map(),
    activeOperations = new Map(),
  }: {
    store: ClientStore;
    host: HostPorts;
    installationId: string;
    activeSaves?: Map<string, string>;
    activeOperations?: Map<string, string>;
  }) {
    this.store = store;
    this.host = host;
    this.installationId = installationId;
    this.activeSaves = activeSaves;
    this.activeOperations = activeOperations;
  }
  withHost(host: HostPorts) {
    return new RecoveryContext({ ...this, host });
  }
  isCheckoutActive(checkoutId: string) {
    return (
      [...this.activeSaves.values()].includes(checkoutId) ||
      [...this.activeOperations.values()].includes(checkoutId)
    );
  }
  /** Saves that have no outcome and are not running now, in one checkout (without their text). */
  getPendingSaves(target: CheckoutTarget) {
    return this.store
      .all<StoredSave>(
        'saves',
        unresolvedSaves + " AND json_extract(body, '$.request.target.checkout.checkoutId') = ?",
        [target.checkoutId],
      )
      .filter((r) => !this.activeSaves.has(saveKey(r.request)));
  }
  putOperation(id: string, record: OperationRecord) {
    record.open = isOpen(record);
    this.store.put('operations', id, record);
  }
  /** Operation records with something left to do, optionally in one checkout. */
  getOpenOperations(target?: CheckoutTarget) {
    return target
      ? this.store.all<OperationRecord>(
          'operations',
          openOperations + " AND json_extract(body, '$.input.checkout.checkoutId') = ?",
          [target.checkoutId],
        )
      : this.store.all<OperationRecord>('operations', openOperations);
  }
  /** Operations in the checkout that are uncertain or that this client has not yet acknowledged. */
  getUnsettledOperations(target: CheckoutTarget, clientId: string) {
    return this.getOpenOperations(target).filter(
      (r) =>
        !this.activeOperations.has(operationKey(r)) &&
        (r.result.outcome === 'uncertain' || !r.acknowledgedBy.includes(clientId)),
    );
  }
  /**
   * A checkout's operation records that are not settled for every purpose: uncertain, with a
   * recovery publication still failing, or not yet acknowledged by the client that made them.
   */
  getUnsettledCheckoutOperations(target: CheckoutTarget) {
    return this.getOpenOperations(target).filter(
      (r) =>
        !this.activeOperations.has(operationKey(r)) &&
        !r.remote &&
        (r.result.outcome === 'uncertain' ||
          r.publicationError !== undefined ||
          !r.acknowledgedBy.includes(r.input.clientId)),
    );
  }
  /**
   * Whether an uncertain operation may still own a draft at `target` (one of its sources holds
   * it), so the draft cannot be dropped until the operation is resolved.
   */
  isDraftHeld(target: { checkout: CheckoutTarget; path: string }) {
    return this.getOpenOperations().some(
      (r) =>
        r.result.outcome === 'uncertain' &&
        same(target.checkout, r.input.checkout) &&
        r.input.sources.some((s) => isPathAtOrInside(target.path, s.target.path)),
    );
  }
  /** Refuses to start over work whose outcome this client has not settled. */
  assertSettled(target: CheckoutTarget, paths: string[], clientId: string) {
    return attempt(
      () =>
        this.getUnsettledOperations(target, clientId).some((r) =>
          overlaps(paths, getRecordPaths(r)),
        ) || this.getPendingSaves(target).some((r) => overlaps(paths, [r.request.target.path])),
    ).pipe(
      Effect.flatMap((blocked) =>
        blocked ? Effect.fail(new UnresolvedWorkError({ state: 'awaits-recovery' })) : Effect.void,
      ),
    );
  }
  /** Marks a checkout's history incomplete: its drafts may be at paths a missed move left behind. */
  markGap(target: CheckoutTarget) {
    this.store.put('feed-gaps', feedKey(target), {
      hostId: target.hostId,
      checkoutId: target.checkoutId,
    });
  }
  getFeedCursor(target: CheckoutTarget) {
    return this.store.get<FeedCursor>('feed-cursors', feedKey(target));
  }
}

/** Where a record touches: its operation's paths, or its items when the feed reported it. */
export const getRecordPaths = (record: OperationRecord) =>
  record.remote
    ? record.result.items.flatMap((item) =>
        item.destination === undefined ? [item.source] : [item.source, item.destination],
      )
    : getOperationPaths(record.input);
