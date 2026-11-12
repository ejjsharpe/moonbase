import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  maximumOperationFeedBytes,
  maximumOperationFeedPage,
} from '@moonbase/contracts/workspace-host-schema';
import type {
  HostInput,
  HostOperationResult,
  OperationFeed,
  SaveStatus,
} from '@moonbase/contracts/workspace-host';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { Directory } from './filesystem.ts';
import type { Store } from './store.ts';
import type {
  FeedRecord,
  HostOperationRecord,
  HostRequestRecord,
  HostSaveRecord,
} from './schema.ts';
import {
  canonical,
  errorText,
  fail,
  identifier,
  isOriginalResult,
  key,
  same,
  textDocument,
} from './validation.ts';

type SaveIdentity = Pick<HostInput<'saveStatus'>, 'installationId' | 'clientId' | 'requestId'>;
type OperationIdentity = Pick<HostInput<'operationStatus'>, 'installationId' | 'clientId' | 'id'>;
const sequenceKey = (sequence: number) => String(sequence).padStart(12, '0');
const floorKey = (checkoutId: string) => 'feed-floor/' + checkoutId;
const feeds = (kind: HostOperationRecord['input']['kind']) =>
  kind === 'move' || kind === 'copy' || kind === 'trash';

/**
 * The file host's save and operation journals, keyed by installation, client and request. An
 * entry stays until its client acknowledges it and the retention window passes. Completed moves,
 * copies and Trash also enter a feed with a store-wide, increasing sequence (and a floor per checkout), so other clients can
 * reconcile their own recovery.
 */
export class HostJournal {
  private readonly volatileSaves = new Map<string, HostSaveRecord>();
  private readonly volatileOperations = new Map<string, HostOperationRecord>();
  private readonly activeSaves = new Set<string>();
  private readonly store: Store;
  private readonly directory: (target: CheckoutTarget) => Promise<Directory>;
  private readonly isCheckoutActive: (checkoutId: string) => boolean;
  private readonly now: () => number;
  private readonly retentionMs: number;
  /** Names this store's feed; a recreated store starts a new one. */
  private readonly epoch: string;
  constructor(
    store: Store,
    directory: (target: CheckoutTarget) => Promise<Directory>,
    isCheckoutActive: (checkoutId: string) => boolean,
    now: () => number,
    retentionMs: number,
  ) {
    this.store = store;
    this.directory = directory;
    this.isCheckoutActive = isCheckoutActive;
    this.now = now;
    this.retentionMs = retentionMs;
    this.epoch = store.get<string>('meta', 'feed-epoch') ?? randomUUID();
    store.put('meta', 'feed-epoch', this.epoch);
    this.compact();
  }

  saveId = (i: SaveIdentity) => key(i.installationId, i.clientId, i.requestId);
  operationId = (i: OperationIdentity) => key(i.installationId, i.clientId, i.id);

  getSave(id: string) {
    return this.volatileSaves.get(id) ?? this.store.get<HostSaveRecord>('saves', id);
  }
  reserveSave(id: string, record: HostSaveRecord) {
    this.assertNotCancelled(id);
    return this.store.reserve('saves', id, record);
  }
  /** A request a client was told never started (`saveStatus` of an unseen ID) is never admitted. */
  assertNotCancelled(id: string) {
    if (this.store.get<number>('cancelled', id) !== null)
      fail('Conflict', 'The save request was reported as not started and can no longer run.');
  }
  startSave(id: string) {
    this.activeSaves.add(id);
  }
  finishSave(id: string) {
    this.activeSaves.delete(id);
  }
  retainSave(id: string, record: HostSaveRecord) {
    this.volatileSaves.set(id, record);
  }
  /** Records a save's outcome; a failure leaves it in memory only, for the next replay to retry. */
  settleSave(id: string, record: HostSaveRecord) {
    this.store.put('saves', id, record);
    this.volatileSaves.delete(id);
  }
  replaySave(id: string, input: HostInput<'saveFile'>, record: HostSaveRecord) {
    if (!same(record.input, input))
      fail('Conflict', 'Save request ID already belongs to a different payload or target.');
    if (!record.result)
      return fail(
        'Uncertain',
        'Interrupted save retained its intent. Ask for its status; do not repeat it.',
      );
    if (this.volatileSaves.has(id)) {
      try {
        this.settleSave(id, record);
      } catch (error) {
        if (record.result.kind === 'saved')
          record.result = {
            ...record.result,
            persistencePending: true,
            message: 'Saved to disk; durable request publication pending. ' + errorText(error),
          };
      }
    }
    return record.result;
  }
  async saveStatus(input: SaveIdentity): Promise<SaveStatus> {
    const id = this.saveId(input),
      record = this.getSave(id);
    if (!record) {
      // Answering `not-started` is a promise: a delayed request must not run after the client
      // discards its intent, so the ID is remembered for as long as an entry is kept.
      this.store.put('cancelled', id, this.now());
      return { kind: 'not-started' };
    }
    const target = record.input.target;
    if (
      !record.result &&
      !this.activeSaves.has(id) &&
      !this.isCheckoutActive(target.checkout.checkoutId)
    ) {
      try {
        const disk = await (await this.directory(target.checkout)).read(target.path);
        if (disk.version === textDocument(record.input.text).version)
          record.result = { kind: 'saved', disk };
        else if (disk.version === record.input.expectedVersion)
          record.result = { kind: 'conflict', disk };
        if (record.result) this.settleOrRetain(id, record);
      } catch {
        /* Disk evidence is unavailable, so the outcome stays uncertain. */
      }
    }
    if (record.result && this.volatileSaves.has(id)) this.settleOrRetain(id, record);
    if (record.result) return { kind: record.result.kind, disk: record.result.disk };
    return { kind: 'uncertain', message: record.message };
  }
  private settleOrRetain(id: string, record: HostSaveRecord) {
    try {
      this.settleSave(id, record);
    } catch {
      this.retainSave(id, record);
    }
  }
  acknowledgeSave(input: SaveIdentity) {
    identifier(input.installationId);
    identifier(input.clientId);
    identifier(input.requestId);
    const id = this.saveId(input),
      record = this.getSave(id);
    if (!record || record.acknowledgedAt !== undefined) return;
    if (!record.result) fail('Uncertain', 'An unresolved save cannot be acknowledged away.');
    this.store.put('saves', id, { ...record, acknowledgedAt: this.now() });
    this.volatileSaves.delete(id);
    this.compact();
  }
  /** Saves started but with no outcome yet, in one checkout. */
  getPendingSaves(target: CheckoutTarget) {
    const records = new Map(
      this.store
        .all<HostSaveRecord>(
          'saves',
          "json_extract(body, '$.result') IS NULL AND json_extract(body, '$.input.target.checkout.checkoutId') = ?",
          [target.checkoutId],
        )
        .map((record) => [this.saveId(record.input), record]),
    );
    for (const [id, record] of this.volatileSaves) records.set(id, record);
    return [...records.values()].filter(
      (r) => !r.result && r.input.target.checkout.checkoutId === target.checkoutId,
    );
  }

  getOperation(id: string) {
    return this.volatileOperations.get(id) ?? this.store.get<HostOperationRecord>('operations', id);
  }
  reserveOperation(id: string, record: HostOperationRecord) {
    return this.store.reserve('operations', id, record);
  }
  /** Progress while items run; the outcome and feed entry come from `finalizeOperation`. */
  writeOperation(id: string, record: HostOperationRecord) {
    this.store.put('operations', id, record);
  }
  retainOperation(id: string, record: HostOperationRecord) {
    this.volatileOperations.set(id, record);
  }
  private getOperations(predicate = '1', parameters: string[] = []) {
    const records = new Map(
      this.store
        .all<HostOperationRecord>('operations', predicate, parameters)
        .map((r) => [this.operationId(r.input), r]),
    );
    for (const [id, record] of this.volatileOperations) records.set(id, record);
    return [...records.values()];
  }
  /** A checkout's operations that still block the requesting client: uncertain, or its own and unacknowledged. */
  getUnsettledOperations(target: CheckoutTarget, installationId: string, clientId: string) {
    return this.getOperations(
      "json_extract(body, '$.input.checkout.checkoutId') = ? AND (json_extract(body, '$.result.outcome') = 'uncertain' OR (json_extract(body, '$.acknowledgedAt') IS NULL AND json_extract(body, '$.input.installationId') = ? AND json_extract(body, '$.input.clientId') = ?))",
      [target.checkoutId, installationId, clientId],
    ).filter(
      (r) =>
        r.input.checkout.checkoutId === target.checkoutId &&
        (r.result.outcome === 'uncertain' ||
          (r.acknowledgedAt === undefined &&
            r.input.installationId === installationId &&
            r.input.clientId === clientId)),
    );
  }
  /** A checkout's operations that are uncertain, or unacknowledged by the requesting installation. */
  getUnsettledCheckoutOperations(target: CheckoutTarget, installationId: string) {
    return this.getOperations("json_extract(body, '$.input.checkout.checkoutId') = ?", [
      target.checkoutId,
    ]).filter(
      (r) =>
        r.input.checkout.checkoutId === target.checkoutId &&
        (r.result.outcome === 'uncertain' ||
          (r.acknowledgedAt === undefined && r.input.installationId === installationId)),
    );
  }
  replayOperation(id: string, input: HostInput<'mutate'>, record: HostOperationRecord) {
    if (!same(record.input, input))
      fail('Conflict', 'Operation ID already belongs to another payload/client/checkout.');
    if (this.volatileOperations.has(id)) {
      try {
        this.finalizeOperation(id, record);
      } catch {
        /* The outcome stays in memory; the next replay tries again. */
      }
    }
    return record.result;
  }
  /**
   * Computes the operation's outcome from its items and records it together with the feed entry
   * for items completed since the last one.
   */
  finalizeOperation(id: string, record: HostOperationRecord) {
    const items = record.result.items;
    const originals = items.filter((item) => isOriginalResult(record.input.kind, item));
    const expected = record.input.sources.length || record.input.nativeReferences?.length || 1;
    let outcome: HostOperationResult['outcome'];
    if (originals.length !== expected || originals.some((item) => item.outcome === 'uncertain'))
      outcome = 'uncertain';
    else if (originals.every((item) => item.outcome === 'completed')) outcome = 'completed';
    else outcome = 'failed';
    const fed = record.fed ?? [];
    const fresh = feeds(record.input.kind)
      ? items.filter(
          (item) =>
            item.outcome === 'completed' &&
            isOriginalResult(record.input.kind, item) &&
            !fed.includes(canonical(item)),
        )
      : [];
    const result = { ...record.result, outcome };
    if (outcome !== 'uncertain') delete result.message;
    const updated: HostOperationRecord = {
      ...record,
      result,
      fed: [...fed, ...fresh.map(canonical)],
    };
    this.store.transaction(() => {
      if (fresh.length) {
        const sequence = (this.store.get<number>('counters', 'feed') ?? 0) + 1;
        this.store.put('counters', 'feed', sequence);
        const entry: FeedRecord = {
          sequence,
          installationId: record.input.installationId,
          clientId: record.input.clientId,
          id: record.input.id,
          checkout: record.input.checkout,
          kind: record.input.kind,
          items: fresh,
          operation: id,
        };
        this.store.put('feed', sequenceKey(sequence), entry);
      }
      this.store.put('operations', id, updated);
    });
    Object.assign(record, updated);
    this.volatileOperations.delete(id);
  }
  async operationStatus(input: OperationIdentity): Promise<HostOperationResult | null> {
    identifier(input.installationId);
    identifier(input.clientId);
    identifier(input.id);
    const id = this.operationId(input),
      record = this.getOperation(id);
    if (!record) return null;
    await this.recoverOperation(id, record);
    return record.result;
  }
  /** Settles an interrupted operation from disk evidence, never repeating a mutation. */
  private async recoverOperation(id: string, record: HostOperationRecord) {
    if (this.isCheckoutActive(record.input.checkout.checkoutId)) return;
    const finalize = () => {
      try {
        this.finalizeOperation(id, record);
      } catch {
        this.retainOperation(id, record);
      }
    };
    const expected = record.input.sources.length || record.input.nativeReferences?.length || 1;
    const items = record.result.items.filter((item) => isOriginalResult(record.input.kind, item));
    if (items.length === expected && items.every((item) => item.outcome !== 'uncertain')) {
      const outcome = items.every((item) => item.outcome === 'completed') ? 'completed' : 'failed';
      if (record.result.outcome !== outcome || this.volatileOperations.has(id)) {
        record.result.outcome = outcome;
        finalize();
      }
    }
    if (record.result.outcome !== 'uncertain' || record.input.kind !== 'move') return;
    let directory: Directory;
    try {
      directory = await this.directory(record.input.checkout);
    } catch {
      return;
    }
    for (const source of record.input.sources) {
      if (
        record.result.items.some(
          (i) => i.source === source.target.path && i.destination && i.outcome === 'completed',
        )
      )
        continue;
      const destination =
        record.input.sources.length === 1
          ? record.input.destination!
          : join(record.input.destination!, basename(source.target.path));
      const inspect = async (p: string) => {
        try {
          return (await directory.entry(p)).identity;
        } catch {
          return null;
        }
      };
      const from = await inspect(source.target.path),
        to = await inspect(destination);
      if (to === source.identity && from !== source.identity) {
        record.result.items = record.result.items.filter(
          (i) => i.source !== source.target.path || !i.destination,
        );
        record.result.items.push({
          source: source.target.path,
          destination,
          outcome: 'completed',
          message: 'Recovered exact moved object identity; no mutation repeated.',
        });
      } else if (
        from === source.identity &&
        to !== source.identity &&
        !record.input.replacements?.length
      ) {
        record.result.items = record.result.items.filter((i) => i.source !== source.target.path);
        record.result.items.push({
          source: source.target.path,
          destination,
          outcome: 'failed',
          message: 'Original object remains at source; no mutation repeated.',
        });
      }
    }
    finalize();
  }
  acknowledgeOperation(input: HostInput<'acknowledgeOperation'>) {
    identifier(input.installationId);
    identifier(input.clientId);
    identifier(input.id);
    const id = this.operationId(input),
      record = this.getOperation(id);
    if (!record || record.acknowledgedAt !== undefined) return;
    if (record.result.outcome === 'uncertain')
      fail(
        'Uncertain',
        'Uncertain operation evidence cannot be acknowledged away. Inspect the affected paths.',
      );
    this.store.put('operations', id, { ...record, acknowledgedAt: this.now() });
    this.volatileOperations.delete(id);
    this.compact();
  }

  /** The first outcome recorded for a request without a client acknowledgement. */
  getRequest(id: string) {
    return this.store.get<HostRequestRecord>('requests', id);
  }
  reserveRequest(id: string, record: HostRequestRecord) {
    return this.store.reserve('requests', id, record);
  }
  settleRequest(id: string, record: HostRequestRecord) {
    this.store.put('requests', id, { ...record, settledAt: this.now() });
  }
  /** Drops an unsettled reservation so a retry under the same ID runs again. */
  releaseRequest(id: string) {
    this.store.delete('requests', id);
  }
  requestId = (operation: string, i: { installationId: string; requestId: string }) =>
    key(operation, i.installationId, i.requestId);
  /** Replays a request's recorded outcome; null when the request is new. */
  replayRequest<K extends 'createWorktree' | 'initializeRepository'>(
    id: string,
    operation: K,
    input: HostInput<K>,
  ): HostRequestRecord['result'] | null {
    const record = this.getRequest(id);
    if (!record) return null;
    if (!same(record.input, input))
      fail('Conflict', 'Request ID already belongs to a different payload.');
    if (record.result) return record.result;
    if (record.error)
      throw new ApplicationError({
        code: record.error.code as ApplicationError['code'],
        message: record.error.message,
      });
    return fail(
      'Uncertain',
      `The earlier ${operation} was interrupted. Inspect the repository; do not repeat it.`,
    );
  }

  /** Entries for one checkout after `after`, in sequence order, one page at a time. */
  listOperations(target: CheckoutTarget, after: number | null): OperationFeed {
    const latest = this.store.get<number>('counters', 'feed') ?? 0;
    const floor = this.store.get<number>('counters', floorKey(target.checkoutId)) ?? 0;
    const epoch = this.epoch;
    if (after === null) return { operations: [], through: latest, floor, epoch, more: false };
    const rows = this.store.all<FeedRecord>(
      'feed',
      "json_extract(body, '$.checkout.checkoutId') = ? AND json_extract(body, '$.sequence') > ?",
      [target.checkoutId, after],
      maximumOperationFeedPage + 1,
    );
    // A page also stays within `maximumOperationFeedBytes` (at least one entry), so any page
    // fits a reply however many items its entries carry.
    let bytes = 0,
      kept = 0;
    for (const row of rows.slice(0, maximumOperationFeedPage)) {
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (kept && bytes > maximumOperationFeedBytes) break;
      kept++;
    }
    const more = rows.length > kept;
    const page = rows.slice(0, kept);
    return {
      operations: page.map(({ operation: _operation, ...entry }) => entry),
      through: more ? page[page.length - 1].sequence : Math.max(latest, after),
      floor,
      epoch,
      more,
    };
  }

  /** Discards entries acknowledged longer ago than the retention window; unacknowledged ones stay. */
  compact() {
    const cutoff = this.now() - this.retentionMs;
    try {
      this.store.transaction(() => {
        const db = this.store.db;
        // Discarding one checkout's entries only raises that checkout's floor.
        const floors = new Map<string, number>();
        const expired = (bucket: string, field: string) =>
          db
            .prepare(
              `SELECT key FROM records WHERE bucket=? AND json_extract(body, '$.${field}') <= ?`,
            )
            .all(bucket, cutoff)
            .map((row) => row.key as string);
        for (const operation of expired('operations', 'acknowledgedAt')) {
          for (const row of db
            .prepare(
              "SELECT json_extract(body, '$.sequence') AS sequence, json_extract(body, '$.checkout.checkoutId') AS checkout FROM records WHERE bucket='feed' AND json_extract(body, '$.operation') = ?",
            )
            .all(operation))
            floors.set(
              row.checkout as string,
              Math.max(floors.get(row.checkout as string) ?? 0, Number(row.sequence)),
            );
          db.prepare(
            "DELETE FROM records WHERE bucket='feed' AND json_extract(body, '$.operation') = ?",
          ).run(operation);
          this.store.delete('operations', operation);
        }
        for (const save of expired('saves', 'acknowledgedAt')) this.store.delete('saves', save);
        db.prepare(
          "DELETE FROM records WHERE bucket='cancelled' AND CAST(body AS INTEGER) <= ?",
        ).run(cutoff);
        for (const request of expired('requests', 'settledAt'))
          this.store.delete('requests', request);
        for (const [checkoutId, floor] of floors)
          this.store.put(
            'counters',
            floorKey(checkoutId),
            Math.max(floor, this.store.get<number>('counters', floorKey(checkoutId)) ?? 0),
          );
      });
    } catch {
      /* Retention is best effort; entries stay until the next attempt. */
    }
  }
}
