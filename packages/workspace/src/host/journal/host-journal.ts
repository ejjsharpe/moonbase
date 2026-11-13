import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  maximumOperationFeedBytes,
  maximumOperationFeedPage,
  type HostInput,
  type HostOperationResult,
  type HostSaveResult,
  type OperationFeed,
  type OperationFeedEntry,
  type SaveStatus,
} from '@moonbase/contracts/workspace-host';
import { randomUUID } from 'node:crypto';
import type { Directory } from '../../shared/filesystem.ts';
import type { Store } from '../../shared/store.ts';
import type {
  HostOperationRecord,
  HostRequestRecord,
  HostSaveRecord,
  PlannedItem,
} from '../schema.ts';
import {
  canonical,
  errorText,
  folded,
  isOriginalResult,
  key,
  overlaps,
  same,
} from '../../shared/validation.ts';
import { fail } from '@moonbase/contracts/errors';

/** The operations whose first outcome is remembered by request ID and replayed. */
export type RequestOperation =
  | 'createWorktree'
  | 'initializeRepository'
  | 'createChatWorktree'
  | 'turnChatIntoProject';
type SaveIdentity = Pick<HostInput<'saveStatus'>, 'installationId' | 'clientId' | 'requestId'>;
type OperationIdentity = Pick<HostInput<'operationStatus'>, 'installationId' | 'clientId' | 'id'>;
type JournalKind = 'saves' | 'operations' | 'requests';
/** A journal row for an ID the host answered it never saw: a request with that ID never runs. */
type Fenced = 'fenced';
const hourMs = 60 * 60 * 1000;
const floorKey = (checkoutId: string) => 'feed-floor/' + checkoutId;
const feeds = (kind: HostOperationRecord['input']['kind']) =>
  kind === 'move' || kind === 'copy' || kind === 'trash';

/**
 * The journal tables. `retained_at` starts a row's retention window: when its client acknowledged
 * it (saves, operations), when it was reserved or last settled (requests) or when the host answered
 * that it never saw the ID (a fence, which has no body). A row without it is never discarded.
 * `unsettled` marks a save with no outcome and an uncertain operation.
 */
export const journalSchema = `
CREATE TABLE IF NOT EXISTS journal (kind TEXT NOT NULL, id TEXT NOT NULL, checkout TEXT, installation TEXT, client TEXT, unsettled INTEGER NOT NULL, retained_at INTEGER, body TEXT, PRIMARY KEY(kind, id));
CREATE INDEX IF NOT EXISTS journal_checkout ON journal(kind, checkout, unsettled);
CREATE INDEX IF NOT EXISTS journal_retained ON journal(retained_at) WHERE retained_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS feed (checkout TEXT NOT NULL, sequence INTEGER NOT NULL, operation TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(checkout, sequence));
CREATE INDEX IF NOT EXISTS feed_by_operation ON feed(operation);`;

/**
 * The file host's save and operation journals, keyed by installation, client and request. An
 * entry stays until its client acknowledges it and the retention window passes. Completed moves,
 * copies and Trash also enter a feed with a store-wide, increasing sequence (and a floor per
 * checkout), so other clients can reconcile their own recovery.
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
  private compactedAt = 0;
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

  private read<T>(kind: JournalKind, id: string): T | Fenced | null {
    const row = this.store
      .statement('SELECT body FROM journal WHERE kind=? AND id=?')
      .get(kind, id);
    if (!row) return null;
    return row.body === null ? 'fenced' : this.store.parse<T>(kind, row.body);
  }
  /** Inserts a row unless its ID is taken, and returns the row that holds it. */
  private reserve<T>(kind: JournalKind, id: string, columns: unknown[], body: T) {
    const inserted = this.store.write(
      'INSERT INTO journal(kind, id, checkout, installation, client, unsettled, retained_at, body) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(kind, id) DO NOTHING',
      [kind, id, ...(columns as never[]), JSON.stringify(body)],
    );
    return Number(inserted.changes) ? null : this.read<T>(kind, id);
  }
  /** Writes a reserved row's record and whether it is unsettled; its retention is unchanged. */
  private update(kind: JournalKind, id: string, unsettled: boolean, body: unknown) {
    this.store.write('UPDATE journal SET unsettled=?, body=? WHERE kind=? AND id=?', [
      unsettled ? 1 : 0,
      JSON.stringify(body),
      kind,
      id,
    ]);
  }
  /** Remembers, for the retention window, that the host told a client it never saw `id`. */
  private fence(kind: JournalKind, id: string) {
    this.store.write(
      'INSERT INTO journal(kind, id, unsettled, retained_at) VALUES(?,?,0,?) ON CONFLICT(kind, id) DO NOTHING',
      [kind, id, this.now()],
    );
  }
  /** Starts an acknowledged entry's retention window. */
  private retain(kind: JournalKind, id: string) {
    this.store.write(
      'UPDATE journal SET retained_at=? WHERE kind=? AND id=? AND retained_at IS NULL',
      [this.now(), kind, id],
    );
    // Discarding is not urgent: once an hour at most, besides when the store opens.
    if (this.now() - this.compactedAt >= hourMs) this.compact();
  }
  private rows<T>(sql: string, parameters: string[]) {
    return this.store
      .statement(sql)
      .all(...parameters)
      .map((row) => ({
        id: row.id as string,
        record: this.store.parse<T>(row.kind as string, row.body),
      }));
  }

  getSave(id: string) {
    return this.volatileSaves.get(id) ?? this.read<HostSaveRecord>('saves', id);
  }
  /** Reserves a save's ID; returns what already holds it, a fence included. */
  reserveSave(id: string, record: HostSaveRecord) {
    const { input } = record;
    const columns = [input.target.checkout.checkoutId, input.installationId, input.clientId];
    const taken = this.reserve('saves', id, [...columns, record.result ? 0 : 1, null], record);
    return taken === null ? null : this.getSave(id);
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
  /** Records a save's outcome; on failure the caller keeps it in memory for the next replay. */
  settleSave(id: string, record: HostSaveRecord) {
    this.update('saves', id, !record.result, record);
    this.volatileSaves.delete(id);
  }
  /** A save request as the journal keeps it: its text's version in place of the text. */
  saveInput({ text: _text, ...input }: HostInput<'saveFile'>, version: string) {
    return { ...input, version };
  }
  replaySave(id: string, input: HostSaveRecord['input'], record: HostSaveRecord | Fenced) {
    if (record === 'fenced')
      return fail(
        'Conflict',
        'The save request was reported as not started and can no longer run.',
      );
    if (!same(record.input, input))
      fail('Conflict', 'Save request ID already belongs to a different payload or target.');
    if (!record.result)
      return fail(
        'Uncertain',
        'Interrupted save retained its intent. Ask for its status; do not repeat it.',
      );
    const result: HostSaveResult = record.result;
    if (this.volatileSaves.has(id)) {
      try {
        this.settleSave(id, record);
      } catch (error) {
        if (result.kind === 'saved')
          return {
            ...result,
            persistencePending: true,
            message: 'Saved to disk; durable request publication pending. ' + errorText(error),
          };
      }
    }
    return result;
  }
  async saveStatus(input: SaveIdentity): Promise<SaveStatus> {
    const id = this.saveId(input),
      record = this.getSave(id);
    if (record === null) {
      // Answering `not-started` is a promise: a delayed request must not run after the client
      // discards its intent, so the ID stays taken for as long as an entry is kept.
      this.fence('saves', id);
      return { kind: 'not-started' };
    }
    if (record === 'fenced') return { kind: 'not-started' };
    if (
      !record.result &&
      !this.activeSaves.has(id) &&
      !this.isCheckoutActive(record.input.target.checkout.checkoutId)
    )
      await this.resolveSave(id, record);
    if (record.result && this.volatileSaves.has(id)) this.settleOrRetain(id, record);
    if (!record.result) return { kind: 'uncertain', message: record.message };
    return record.result;
  }
  /**
   * Settles an interrupted save from the disk without repeating it: its own text there is `saved`,
   * anything else a `conflict` with what is there, over which the client keeps its draft. A file
   * that can't be read leaves it uncertain.
   */
  private async resolveSave(id: string, record: HostSaveRecord) {
    const target = record.input.target;
    try {
      const disk = await (await this.directory(target.checkout)).read(target.path);
      record.result =
        disk.version === record.input.version
          ? { kind: 'saved', version: disk.version }
          : { kind: 'conflict', disk };
    } catch {
      return;
    }
    this.settleOrRetain(id, record);
  }
  private settleOrRetain(id: string, record: HostSaveRecord) {
    try {
      this.settleSave(id, record);
    } catch {
      this.retainSave(id, record);
    }
  }
  acknowledgeSave(input: SaveIdentity) {
    const id = this.saveId(input),
      record = this.getSave(id);
    if (!record || record === 'fenced') return;
    if (!record.result) fail('Uncertain', 'An unresolved save cannot be acknowledged away.');
    if (this.volatileSaves.has(id)) this.settleSave(id, record);
    this.retain('saves', id);
  }
  /** Saves started but with no outcome yet, in one checkout. */
  getPendingSaves(target: CheckoutTarget) {
    return this.rows<HostSaveRecord>(
      "SELECT id, kind, body FROM journal WHERE kind='saves' AND checkout=? AND unsettled=1",
      [target.checkoutId],
    );
  }

  getOperation(id: string) {
    return this.volatileOperations.get(id) ?? this.read<HostOperationRecord>('operations', id);
  }
  /** Reserves an operation's ID; returns what already holds it, a fence included. */
  reserveOperation(id: string, record: HostOperationRecord) {
    const { input } = record;
    const columns = [input.checkout.checkoutId, input.installationId, input.clientId];
    const taken = this.reserve('operations', id, [...columns, 1, null], record);
    return taken === null ? null : this.getOperation(id);
  }
  /** Progress while items run; the outcome and feed entry come from `finalizeOperation`. */
  writeOperation(id: string, record: HostOperationRecord) {
    this.update('operations', id, true, record);
  }
  retainOperation(id: string, record: HostOperationRecord) {
    this.volatileOperations.set(id, record);
  }
  /** A checkout's operations that still block the requesting client: uncertain, or its own and unacknowledged. */
  getUnsettledOperations(target: CheckoutTarget, installationId: string, clientId: string) {
    return this.rows<HostOperationRecord>(
      "SELECT id, kind, body FROM journal WHERE kind='operations' AND checkout=? AND (unsettled=1 OR (retained_at IS NULL AND installation=? AND client=?))",
      [target.checkoutId, installationId, clientId],
    );
  }
  /** A checkout's operations that are uncertain, or unacknowledged by the requesting installation. */
  getUnsettledCheckoutOperations(target: CheckoutTarget, installationId: string) {
    return this.rows<HostOperationRecord>(
      "SELECT id, kind, body FROM journal WHERE kind='operations' AND checkout=? AND (unsettled=1 OR (retained_at IS NULL AND installation=?))",
      [target.checkoutId, installationId],
    );
  }
  replayOperation(id: string, input: HostInput<'mutate'>, record: HostOperationRecord | Fenced) {
    if (record === 'fenced')
      return fail('Conflict', 'The operation was reported as not started and can no longer run.');
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
    let outcome: HostOperationResult['outcome'];
    if (
      originals.length !== record.planned.length ||
      originals.some((item) => item.outcome === 'uncertain')
    )
      outcome = 'uncertain';
    else if (originals.every((item) => item.outcome === 'completed')) outcome = 'completed';
    else outcome = 'failed';
    const fed = record.fed ?? [];
    const fresh = feeds(record.input.kind)
      ? originals.filter((item) => item.outcome === 'completed' && !fed.includes(canonical(item)))
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
        const entry: OperationFeedEntry = {
          sequence,
          installationId: record.input.installationId,
          clientId: record.input.clientId,
          id: record.input.id,
          checkout: record.input.checkout,
          kind: record.input.kind,
          items: fresh,
        };
        this.store.write('INSERT INTO feed VALUES(?,?,?,?)', [
          record.input.checkout.checkoutId,
          sequence,
          id,
          JSON.stringify(entry),
        ]);
      }
      this.update('operations', id, outcome === 'uncertain', updated);
    });
    Object.assign(record, updated);
    this.volatileOperations.delete(id);
  }
  async operationStatus(input: OperationIdentity): Promise<HostOperationResult | null> {
    const id = this.operationId(input),
      record = this.getOperation(id);
    if (record === null) {
      // As with saves: a client that hears `null` discards its intent, so the ID never runs.
      this.fence('operations', id);
      return null;
    }
    if (record === 'fenced') return null;
    if (!this.isCheckoutActive(record.input.checkout.checkoutId))
      await this.recoverOperation(id, record);
    return record.result;
  }
  /**
   * Settles an interrupted operation from disk evidence, never repeating a mutation. Each item
   * without an outcome is `completed` when the disk shows its effect (a move's object at its
   * destination, Trash's object gone from its path, a new object at a copy's, import's or
   * creation's destination) and `failed` otherwise, so drafts stay where they are.
   */
  private async recoverOperation(id: string, record: HostOperationRecord) {
    if (record.result.outcome !== 'uncertain' && !this.volatileOperations.has(id)) return;
    const kind = record.input.kind;
    const settled = (item: PlannedItem) =>
      record.result.items.some(
        (i) => isOriginalResult(kind, i) && i.source === item.source && i.outcome !== 'uncertain',
      );
    const open = record.planned.filter((item) => !settled(item));
    if (open.length) {
      let directory: Directory;
      try {
        directory = await this.directory(record.input.checkout);
      } catch {
        return;
      }
      const identityAt = async (p: string | undefined) => {
        if (p === undefined) return null;
        try {
          return (await directory.entry(p)).identity;
        } catch {
          return null;
        }
      };
      for (const item of open) {
        const to = await identityAt(item.destination);
        const replaced = record.input.replacements?.find(
          (r) =>
            item.destination !== undefined && folded(r.target.path) === folded(item.destination),
        )?.identity;
        let completed = to !== null && to !== replaced;
        if (kind === 'move' || kind === 'trash') {
          const left = (await identityAt(item.source)) !== item.identity;
          completed = left && (kind === 'trash' || to === item.identity);
        }
        record.result.items = record.result.items.filter(
          (i) => !isOriginalResult(kind, i) || i.source !== item.source,
        );
        record.result.items.push({
          source: item.source,
          ...(item.destination === undefined ? {} : { destination: item.destination }),
          outcome: completed ? 'completed' : 'failed',
          message: completed
            ? 'Recovered from disk; no mutation repeated.'
            : 'The disk does not show this item done; no mutation repeated. Inspect it.',
        });
      }
    }
    try {
      this.finalizeOperation(id, record);
    } catch {
      this.retainOperation(id, record);
    }
  }
  acknowledgeOperation(input: HostInput<'acknowledgeOperation'>) {
    const id = this.operationId(input),
      record = this.getOperation(id);
    if (!record || record === 'fenced') return;
    if (record.result.outcome === 'uncertain')
      fail(
        'Uncertain',
        'Uncertain operation evidence cannot be acknowledged away. Inspect the affected paths.',
      );
    if (this.volatileOperations.has(id)) this.finalizeOperation(id, record);
    this.retain('operations', id);
  }
  /**
   * Refuses work on `paths` while a save or operation there is unresolved, after settling each
   * from disk. The caller holds the paths' lease, so none of them is still running.
   */
  async assertSettled(
    target: CheckoutTarget,
    paths: string[],
    installationId: string,
    clientId: string,
    footprint: (input: HostInput<'mutate'>) => string[],
  ) {
    let blocked = false;
    for (const { id, record } of this.getPendingSaves(target)) {
      if (!overlaps(paths, [record.input.target.path])) continue;
      const current = this.getSave(id);
      if (current && current !== 'fenced' && !current.result) await this.resolveSave(id, current);
      blocked ||= !(current && current !== 'fenced' && current.result);
    }
    for (const { id, record } of this.getUnsettledOperations(target, installationId, clientId)) {
      if (!overlaps(paths, footprint(record.input))) continue;
      const current = this.getOperation(id);
      if (!current || current === 'fenced') continue;
      await this.recoverOperation(id, current);
      // What is left blocks: an uncertain operation, or this client's own unacknowledged one.
      blocked ||=
        current.result.outcome === 'uncertain' ||
        (current.input.installationId === installationId && current.input.clientId === clientId);
    }
    if (blocked)
      fail(
        'Uncertain',
        'An operation awaits recovery publication or inspection. Query its status; do not repeat the mutation.',
      );
  }

  /** Reserves a request's ID; returns the record that already holds it. */
  reserveRequest(id: string, input: HostRequestRecord['input']) {
    return this.reserve<HostRequestRecord>('requests', id, [null, null, null, 0, this.now()], {
      input,
    }) as HostRequestRecord | null;
  }
  /** Records a request's outcome, replayed for its ID for the retention window. */
  settleRequest(id: string, record: HostRequestRecord) {
    this.store.write('UPDATE journal SET body=?, retained_at=? WHERE kind=? AND id=?', [
      JSON.stringify(record),
      this.now(),
      'requests',
      id,
    ]);
  }
  /** Drops a reservation so a retry under the same ID runs again. */
  releaseRequest(id: string) {
    this.store.write("DELETE FROM journal WHERE kind='requests' AND id=?", [id]);
  }
  requestId = (operation: string, i: { installationId: string; requestId: string }) =>
    key(operation, i.installationId, i.requestId);
  /** Replays a request's recorded outcome. */
  replayRequest(record: HostRequestRecord, operation: RequestOperation, input: unknown) {
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
    const rows = this.store
      .statement('SELECT body FROM feed WHERE checkout=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(target.checkoutId, after, maximumOperationFeedPage + 1)
      .map((row) => this.store.parse<OperationFeedEntry>('feed', row.body));
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
      operations: page,
      through: more ? page[page.length - 1].sequence : Math.max(latest, after),
      floor,
      epoch,
      more,
    };
  }

  /** Discards entries whose retention window has passed; unacknowledged ones stay. */
  compact() {
    this.compactedAt = this.now();
    const cutoff = this.compactedAt - this.retentionMs;
    try {
      this.store.transaction(() => {
        // Discarding one checkout's entries only raises that checkout's floor.
        const floors = this.store
          .statement(
            "SELECT feed.checkout AS checkout, MAX(feed.sequence) AS sequence FROM feed JOIN journal ON journal.kind='operations' AND journal.id=feed.operation WHERE journal.retained_at <= ? GROUP BY feed.checkout",
          )
          .all(cutoff);
        this.store
          .statement(
            "DELETE FROM feed WHERE operation IN (SELECT id FROM journal WHERE kind='operations' AND retained_at <= ?)",
          )
          .run(cutoff);
        this.store.statement('DELETE FROM journal WHERE retained_at <= ?').run(cutoff);
        for (const { checkout, sequence } of floors) {
          const floor = floorKey(checkout as string);
          this.store.put(
            'counters',
            floor,
            Math.max(Number(sequence), this.store.get<number>('counters', floor) ?? 0),
          );
        }
      });
    } catch {
      /* Retention is best effort; entries stay until the next attempt. */
    }
  }
}
