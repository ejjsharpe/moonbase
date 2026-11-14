import { Context, type Deferred, Effect, Layer } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  InterruptedRequestError,
  RecordedRefusalError,
  UnresolvedWorkError,
  WorkspaceConflictError,
} from '@moonbase/contracts/workspace-host-errors';
import type {
  HostInput,
  HostOperationResult,
  HostSaveResult,
  OperationFeedEntry,
  SaveStatus,
} from '@moonbase/contracts/workspace-host';
import { randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import { attempt, type WorkspaceFailure } from '../attempt.ts';
import { Checkouts } from './checkouts.ts';
import { HostSettings } from './host-settings.ts';
import { HostStore } from './host-store.ts';
import { Leases } from './leases.ts';
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
} from '../validation.ts';

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
import { floorKey } from './operation-feed.ts';
const feeds = (kind: HostOperationRecord['input']['kind']) =>
  kind === 'move' || kind === 'copy' || kind === 'trash';

/** What the journal reads besides its store. */
type JournalDependencies = {
  store: Store;
  /** Opens checkouts to settle interrupted work from the disk. */
  checkouts: Pick<Checkouts['Service'], 'directory'>;
  /** Whether a running save or operation holds paths of a checkout. */
  leases: Pick<Leases['Service'], 'isActive'>;
  now: () => number;
  retentionMs: number;
};

/**
 * The file host's save and operation journals, keyed by installation, client and request. An
 * entry stays until its client acknowledges it and the retention window passes. Completed moves,
 * copies and Trash also enter a feed with a store-wide, increasing sequence (and a floor per
 * checkout), so other clients can reconcile their own recovery.
 */
export class Journal {
  private readonly volatileSaves = new Map<string, HostSaveRecord>();
  private readonly volatileOperations = new Map<string, HostOperationRecord>();
  private readonly activeSaves = new Set<string>();
  /** The requests running in this process, so a concurrent duplicate waits for the first. */
  readonly runningRequests = new Map<
    string,
    { input: unknown; outcome: Deferred.Deferred<CheckoutTarget, WorkspaceFailure> }
  >();
  private readonly store: Store;
  private readonly checkouts: JournalDependencies['checkouts'];
  private readonly leases: JournalDependencies['leases'];
  private readonly now: () => number;
  private readonly retentionMs: number;
  private compactedAt = 0;
  /** Names this store's feed; a recreated store starts a new one. */
  readonly epoch: string;
  constructor({ store, checkouts, leases, now, retentionMs }: JournalDependencies) {
    this.store = store;
    this.checkouts = checkouts;
    this.leases = leases;
    this.now = now;
    this.retentionMs = retentionMs;
    this.epoch = store.get<string>('meta', 'feed-epoch') ?? randomUUID();
    store.put('meta', 'feed-epoch', this.epoch);
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
    return Effect.andThen(
      attempt(() =>
        this.store.write(
          'UPDATE journal SET retained_at=? WHERE kind=? AND id=? AND retained_at IS NULL',
          [this.now(), kind, id],
        ),
      ),
      // Discarding is not urgent: once an hour at most, besides when the store opens.
      Effect.suspend(() =>
        this.now() - this.compactedAt >= hourMs ? this.compact() : Effect.void,
      ),
    );
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
    if (record === 'fenced') throw new WorkspaceConflictError({ conflict: 'save-not-started' });
    if (!same(record.input, input)) throw new WorkspaceConflictError({ conflict: 'save-payload' });
    if (!record.result) throw new UnresolvedWorkError({ state: 'save-interrupted' });
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
  saveStatus(input: SaveIdentity): Effect.Effect<SaveStatus, WorkspaceFailure> {
    return Effect.gen({ self: this }, function* () {
      const id = this.saveId(input),
        record = yield* attempt(() => this.getSave(id));
      if (record === null) {
        // Answering `not-started` is a promise: a delayed request must not run after the client
        // discards its intent, so the ID stays taken for as long as an entry is kept.
        yield* attempt(() => this.fence('saves', id));
        return { kind: 'not-started' } as const;
      }
      if (record === 'fenced') return { kind: 'not-started' } as const;
      if (
        !record.result &&
        !this.activeSaves.has(id) &&
        !this.leases.isActive(record.input.target.checkout.checkoutId)
      )
        yield* this.resolveSave(id, record);
      if (record.result && this.volatileSaves.has(id)) this.settleOrRetain(id, record);
      if (!record.result) return { kind: 'uncertain', message: record.message } as const;
      return record.result;
    });
  }
  /**
   * Settles an interrupted save from the disk without repeating it: its own text there is `saved`,
   * anything else a `conflict` with what is there, over which the client keeps its draft. A file
   * that can't be read leaves it uncertain.
   */
  private resolveSave(id: string, record: HostSaveRecord) {
    const target = record.input.target;
    return this.checkouts.directory(target.checkout).pipe(
      Effect.flatMap((directory) => directory.read(target.path)),
      Effect.map((disk) => {
        record.result =
          disk.version === record.input.version
            ? { kind: 'saved', version: disk.version }
            : { kind: 'conflict', disk };
        this.settleOrRetain(id, record);
      }),
      Effect.catch(() => Effect.void),
    );
  }
  private settleOrRetain(id: string, record: HostSaveRecord) {
    try {
      this.settleSave(id, record);
    } catch {
      this.retainSave(id, record);
    }
  }
  acknowledgeSave(input: SaveIdentity): Effect.Effect<void, WorkspaceFailure> {
    return Effect.gen({ self: this }, function* () {
      const id = this.saveId(input),
        record = yield* attempt(() => this.getSave(id));
      if (!record || record === 'fenced') return;
      if (!record.result)
        return yield* new UnresolvedWorkError({ state: 'save-unacknowledgeable' });
      if (this.volatileSaves.has(id)) yield* attempt(() => this.settleSave(id, record));
      yield* this.retain('saves', id);
    });
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
    return Effect.gen({ self: this }, function* () {
      if (record === 'fenced')
        return yield* new WorkspaceConflictError({ conflict: 'operation-not-started' });
      if (!same(record.input, input))
        return yield* new WorkspaceConflictError({ conflict: 'operation-payload' });
      // The outcome stays in memory when this fails; the next replay tries again.
      if (this.volatileOperations.has(id)) yield* Effect.ignore(this.finalizeOperation(id, record));
      return record.result;
    });
  }
  /**
   * Computes the operation's outcome from its items and records it together with the feed entry
   * for items completed since the last one.
   */
  finalizeOperation(
    id: string,
    record: HostOperationRecord,
  ): Effect.Effect<void, WorkspaceFailure> {
    return Effect.suspend(() => {
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
      return this.store
        .transaction(() => {
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
        })
        .pipe(
          Effect.map(() => {
            Object.assign(record, updated);
            this.volatileOperations.delete(id);
          }),
        );
    });
  }
  operationStatus(
    input: OperationIdentity,
  ): Effect.Effect<HostOperationResult | null, WorkspaceFailure> {
    return Effect.gen({ self: this }, function* () {
      const id = this.operationId(input),
        record = yield* attempt(() => this.getOperation(id));
      if (record === null) {
        // As with saves: a client that hears `null` discards its intent, so the ID never runs.
        yield* attempt(() => this.fence('operations', id));
        return null;
      }
      if (record === 'fenced') return null;
      if (!this.leases.isActive(record.input.checkout.checkoutId))
        yield* this.recoverOperation(id, record);
      return record.result;
    });
  }
  /**
   * Settles an interrupted operation from disk evidence, never repeating a mutation. Each item
   * without an outcome is `completed` when the disk shows its effect (a move's object at its
   * destination, Trash's object gone from its path, a new object at a copy's, import's or
   * creation's destination) and `failed` otherwise, so drafts stay where they are.
   */
  private recoverOperation(id: string, record: HostOperationRecord) {
    return Effect.gen({ self: this }, function* () {
      if (record.result.outcome !== 'uncertain' && !this.volatileOperations.has(id)) return;
      const kind = record.input.kind;
      const settled = (item: PlannedItem) =>
        record.result.items.some(
          (i) => isOriginalResult(kind, i) && i.source === item.source && i.outcome !== 'uncertain',
        );
      const open = record.planned.filter((item) => !settled(item));
      if (open.length) {
        const opened = yield* Effect.exit(this.checkouts.directory(record.input.checkout));
        if (opened._tag === 'Failure') return;
        const directory = opened.value;
        const identityAt = (p: string | undefined) =>
          p === undefined
            ? Effect.succeed(null)
            : directory.entry(p).pipe(
                Effect.map((entry): string | null => entry.identity),
                Effect.orElseSucceed(() => null),
              );
        for (const item of open) {
          const to = yield* identityAt(item.destination);
          const replaced = record.input.replacements?.find(
            (r) =>
              item.destination !== undefined && folded(r.target.path) === folded(item.destination),
          )?.identity;
          let completed = to !== null && to !== replaced;
          if (kind === 'move' || kind === 'trash') {
            const left = (yield* identityAt(item.source)) !== item.identity;
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
      yield* this.finalizeOperation(id, record).pipe(
        Effect.catch(() => Effect.sync(() => this.retainOperation(id, record))),
      );
    });
  }
  acknowledgeOperation(
    input: HostInput<'acknowledgeOperation'>,
  ): Effect.Effect<void, WorkspaceFailure> {
    return Effect.gen({ self: this }, function* () {
      const id = this.operationId(input),
        record = yield* attempt(() => this.getOperation(id));
      if (!record || record === 'fenced') return;
      if (record.result.outcome === 'uncertain')
        return yield* new UnresolvedWorkError({ state: 'operation-unacknowledgeable' });
      if (this.volatileOperations.has(id)) yield* this.finalizeOperation(id, record);
      yield* this.retain('operations', id);
    });
  }
  /**
   * Refuses work on `paths` while a save or operation there is unresolved, after settling each
   * from disk. The caller holds the paths' lease, so none of them is still running.
   */
  assertSettled(
    target: CheckoutTarget,
    paths: string[],
    installationId: string,
    clientId: string,
    footprint: (input: HostInput<'mutate'>) => string[],
  ): Effect.Effect<void, WorkspaceFailure> {
    return Effect.gen({ self: this }, function* () {
      let blocked = false;
      for (const { id, record } of yield* attempt(() => this.getPendingSaves(target))) {
        if (!overlaps(paths, [record.input.target.path])) continue;
        const current = yield* attempt(() => this.getSave(id));
        if (current && current !== 'fenced' && !current.result)
          yield* this.resolveSave(id, current);
        blocked ||= !(current && current !== 'fenced' && current.result);
      }
      const operations = yield* attempt(() =>
        this.getUnsettledOperations(target, installationId, clientId),
      );
      for (const { id, record } of operations) {
        if (!overlaps(paths, footprint(record.input))) continue;
        const current = yield* attempt(() => this.getOperation(id));
        if (!current || current === 'fenced') continue;
        yield* this.recoverOperation(id, current);
        // What is left blocks: an uncertain operation, or this client's own unacknowledged one.
        blocked ||=
          current.result.outcome === 'uncertain' ||
          (current.input.installationId === installationId && current.input.clientId === clientId);
      }
      if (blocked) return yield* new UnresolvedWorkError({ state: 'awaits-recovery' });
    });
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
      throw new WorkspaceConflictError({ conflict: 'request-payload' });
    if (record.result) return record.result;
    if (record.error)
      throw new RecordedRefusalError({
        code: record.error.code as RecordedRefusalError['code'],
        text: record.error.message,
      });
    throw new InterruptedRequestError({ operation });
  }

  /** Discards entries whose retention window has passed; unacknowledged ones stay. */
  compact(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.compactedAt = this.now();
      const cutoff = this.compactedAt - this.retentionMs;
      return this.store.transaction(() => {
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
    }).pipe(
      // Retention is best effort; entries stay until the next attempt.
      Effect.ignore,
    );
  }
}

/** The host's journals, opened over its store when the host starts. */
export class HostJournal extends Context.Service<HostJournal, Journal>()(
  'moonbase/workspace/HostJournal',
) {
  static readonly layer = Layer.effect(
    HostJournal,
    Effect.gen(function* () {
      const { config, now } = yield* HostSettings;
      const store = yield* HostStore;
      const checkouts = yield* Checkouts;
      const leases = yield* Leases;
      const journal = yield* attempt(
        () =>
          new Journal({
            store,
            checkouts,
            leases,
            now,
            retentionMs: config.journalRetentionMs ?? 7 * 24 * 60 * 60 * 1000,
          }),
      );
      // Acknowledged entries past their window are discarded when the store opens.
      yield* journal.compact();
      return journal;
    }),
  );
}
