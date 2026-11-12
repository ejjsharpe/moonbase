import { basename, join } from 'node:path';
import {
  emptyRecovery,
  type CheckoutTarget,
  type CommandInput,
  type EditorRecovery,
  type FileDocument,
  type OperationResult,
  type SaveResult,
  type WorkspaceOperation,
} from '@moonbase/contracts/workspace';
import type {
  HostOperationResult,
  OperationFeed,
  OperationFeedEntry,
  SaveStatus,
} from '@moonbase/contracts/workspace-host';
import {
  type FeedCursor,
  type OperationRecord,
  type SaveRecord,
  type StoredSave,
  fromStoredSave,
  toStoredSave,
} from './client-schema.ts';
import {
  type ClientStore,
  type StoredRecovery,
  openOperations,
  pendingSaves,
} from './client-store.ts';
import { invalidStored } from './store.ts';
import {
  affected,
  canonical,
  ensure,
  errorText,
  fail,
  identifier,
  isOriginalResult,
  key,
  overlaps,
  recovery,
  same,
  hash,
} from './validation.ts';

/**
 * Applies completed moves, copies and Trash to one recovery. A move onto a path that already holds
 * a draft leaves the moving draft where it was; the checkouts where that happened are returned.
 */
export function reconcile(state: EditorRecovery, records: OperationRecord[]) {
  const collisions = new Map<string, CheckoutTarget>();
  for (const record of records) {
    if (!state.checkouts.some((c) => same(c, record.input.checkout))) continue;
    for (const item of record.result.items) {
      if (item.outcome !== 'completed') continue;
      const kind = record.input.kind;
      if (!['move', 'copy', 'trash'].includes(kind)) continue;
      if (kind !== 'trash' && !item.destination) continue;
      const matches = (target: { checkout: CheckoutTarget; path: string }) =>
        same(target.checkout, record.input.checkout) && affected(target.path, item.source);
      const move = (p: string) => item.destination! + p.slice(item.source.length);
      const occupied = (path: string) =>
        state.drafts.some(
          (d) => same(d.target.checkout, record.input.checkout) && d.target.path === path,
        );
      if (kind === 'copy') {
        // oxlint-disable-next-line no-useless-spread -- Copies append to state.drafts; iterate only the original drafts.
        for (const draft of [...state.drafts])
          if (matches(draft.target) && !occupied(move(draft.target.path)))
            state.drafts.push({
              ...draft,
              target: { ...draft.target, path: move(draft.target.path) },
            });
        continue;
      }
      // Trash never proves permission to discard another client's dirty work.
      if (kind === 'move') {
        state.drafts = state.drafts.map((d) => {
          if (!matches(d.target)) return d;
          // Another draft already holds the destination: neither is dropped, and the checkout's
          // history is marked so the draft left behind is reported.
          if (occupied(move(d.target.path))) {
            collisions.set(record.input.checkout.checkoutId, record.input.checkout);
            return d;
          }
          return { ...d, target: { ...d.target, path: move(d.target.path) } };
        });
        state.recentFiles = state.recentFiles.map((t) =>
          matches(t) ? { ...t, path: move(t.path) } : t,
        );
        const view = state.views[record.input.checkout.checkoutId];
        if (view) {
          const rename = (p: string) => (affected(p, item.source) ? move(p) : p);
          view.openFiles = [...new Set(view.openFiles.map(rename))];
          view.active = rename(view.active);
          if (view.preview) view.preview = rename(view.preview);
          view.fileViews = Object.fromEntries(
            Object.entries(view.fileViews).map(([p, mode]) => [rename(p), mode]),
          );
          view.positions = Object.fromEntries(
            Object.entries(view.positions).map(([p, positions]) => [rename(p), positions]),
          );
          view.tree.expanded = view.tree.expanded.map(rename);
          view.tree.selected = view.tree.selected.map(rename);
          view.tree.focus = rename(view.tree.focus);
        }
      }
    }
  }
  return collisions;
}

/** The file host as the client's recovery sees it, with the installation already bound. */
export type HostPorts = {
  readFile(
    target: CheckoutTargetFile,
    signal: AbortSignal,
  ): Promise<{ text: string; version: string }>;
  verifyCheckout(target: CheckoutTarget, signal: AbortSignal): Promise<void>;
  saveStatus(
    input: { clientId: string; requestId: string },
    signal: AbortSignal,
  ): Promise<SaveStatus>;
  acknowledgeSave(
    input: { clientId: string; requestId: string },
    signal: AbortSignal,
  ): Promise<void>;
  operationStatus(
    input: { clientId: string; id: string },
    signal: AbortSignal,
  ): Promise<HostOperationResult | null>;
  acknowledgeOperation(input: { clientId: string; id: string }, signal: AbortSignal): Promise<void>;
  listOperations(
    input: { checkout: CheckoutTarget; after: number | null },
    signal: AbortSignal,
  ): Promise<OperationFeed>;
};
type CheckoutTargetFile = { checkout: CheckoutTarget; path: string };
export type Recoveries = ReturnType<ClientStore['readRecoveries']>;
type MergedOperation = {
  id: string;
  record: OperationRecord;
  updated: OperationRecord;
  fresh: OperationResult['items'];
  changed: boolean;
};

/** Runs `run` over `items`, at most `limit` at a time; `run` handles its own failures. */
async function forEachConcurrently<T>(items: T[], run: (item: T) => Promise<void>, limit = 8) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await run(items[next++]);
    }),
  );
}
const saveKey = (request: { clientId: string; requestId: string }) =>
  key(request.clientId, request.requestId);
const operationKey = (record: OperationRecord) => key(record.input.clientId, record.input.id);
const feedKey = (target: CheckoutTarget) => key(target.hostId, target.checkoutId);
/** Saves whose outcome is not yet in the recovery. */
const unresolvedSaves = pendingSaves + " AND json_extract(body, '$.state') <> 'settled'";
const dedupeChanges = (changes: OperationResult['recoveryChanges']) => [
  ...new Map(changes.map((change) => [canonical(change), change])).values(),
];
/**
 * The text a save began from: kept with the save when it was read from the host, else a draft's
 * baseline in the recovery, which holds it while no publication came after the save began (only
 * then is a save restored). Internal writes move and copy drafts but keep their baseline, and
 * versions are content hashes, so any draft's baseline with that version is the same text.
 */
function findBaseline(
  state: EditorRecovery,
  target: { checkout: CheckoutTarget; path: string },
  baseline: SaveRecord['baseline'],
) {
  if (baseline.text !== undefined) return { text: baseline.text, version: baseline.version };
  const disk = (
    state.drafts.find((d) => same(d.target, target) && d.disk.version === baseline.version) ??
    state.drafts.find((d) => d.disk.version === baseline.version)
  )?.disk;
  return disk && { ...disk };
}
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
 * One client's recovery: the drafts and editor state it publishes, and the intents for the saves
 * and operations it has sent to the file host. An outcome from the host, the host's status
 * queries or its operation feed is applied to the recovery in one local transaction.
 */
export class WorkspaceRecovery {
  private readonly activeSaves = new Map<string, string>();
  private readonly activeOperations = new Map<string, string>();
  private readonly store: ClientStore;
  private readonly host: HostPorts;
  private readonly installationId: string;
  private readonly hostWaitMs: number;
  constructor(store: ClientStore, host: HostPorts, installationId: string, hostWaitMs = 5000) {
    this.hostWaitMs = hostWaitMs;
    this.store = store;
    this.host = host;
    this.installationId = installationId;
  }

  getPublication(clientId: string) {
    return this.store.publication(clientId);
  }
  getRecoveryPublication(input: CommandInput<'getRecoveryPublication'>) {
    identifier(input.clientId);
    identifier(input.requestId);
    return this.store.recoveryPublication(input.clientId, input.requestId)?.receipt ?? null;
  }
  readRecoveries(): Recoveries {
    return this.store.readRecoveries();
  }
  isCheckoutActive(checkoutId: string) {
    return (
      [...this.activeSaves.values()].includes(checkoutId) ||
      [...this.activeOperations.values()].includes(checkoutId)
    );
  }

  // Saves
  startSave(id: string, checkoutId: string) {
    this.activeSaves.set(id, checkoutId);
  }
  finishSave(id: string) {
    this.activeSaves.delete(id);
  }
  reserveSave(id: string, record: SaveRecord) {
    return this.store.reserveSave(id, record);
  }
  discardSave(id: string) {
    this.store.deleteSave(id);
  }
  getSaveRecord(id: string) {
    return this.store.readSave(id);
  }
  /** Saves that have no outcome and are not running now, in one checkout (without their text). */
  getPendingSaves(target: CheckoutTarget) {
    return this.store
      .all<StoredSave>(
        'save-records',
        unresolvedSaves + " AND json_extract(body, '$.request.target.checkout.checkoutId') = ?",
        [target.checkoutId],
      )
      .filter((r) => !this.activeSaves.has(saveKey(r.request)));
  }
  /**
   * The text a draft held when the save began: the draft's recorded baseline, which the recovery
   * already holds (so only its version is given), else the file on the host.
   */
  async getBaseline(
    input: CommandInput<'saveFile'>,
    signal: AbortSignal,
  ): Promise<SaveRecord['baseline']> {
    const draft = this.store
      .readRecovery(input.clientId)
      ?.state.drafts.find((d) => same(d.target, input.target));
    if (draft && draft.disk.version === input.expectedVersion)
      return { version: draft.disk.version };
    return this.host.readFile(input.target, signal);
  }
  /**
   * Answers a repeated save request. One whose outcome is not yet recorded is asked of the host,
   * and an outcome it reports is applied as a load would; it is never sent again.
   */
  async replaySave(
    id: string,
    input: CommandInput<'saveFile'>,
    record: SaveRecord,
    signal: AbortSignal,
  ): Promise<SaveResult> {
    if (!same(record.input, input))
      fail('Conflict', 'Save request ID already belongs to a different payload or target.');
    if ((record.state === 'sent' || record.state === 'restored') && !this.activeSaves.has(id)) {
      const notStarted = new Set<string>();
      const status = await this.host
        .saveStatus({ clientId: input.clientId, requestId: input.requestId }, signal)
        .catch(() => undefined);
      if (status && this.applySaveStatus(record, status, notStarted)) {
        // A save whose text did not reach the disk has its text restored with its whole group.
        const restore = record.result?.kind !== 'saved';
        if (restore) await this.followRestoredCheckouts([record], signal);
        try {
          this.publishSaves([record], restore, notStarted);
        } catch (error) {
          if (record.result?.kind !== 'saved')
            return fail(
              'Persistence',
              'Admitted Save recovery publication pending; previous valid snapshot retained. ' +
                errorText(error),
            );
          await this.acknowledgeSaves([], signal);
          return {
            ...record.result,
            persistencePending: true,
            message: 'Saved to disk; recovery publication pending. ' + errorText(error),
          };
        }
        await this.acknowledgeSaves([record], signal);
      }
    }
    if (record.result) return record.result;
    if (record.state === 'done')
      return fail(
        'Unavailable',
        'The save never reached the host; its text was kept as a draft. Save it again as a new request.',
      );
    return fail(
      'Uncertain',
      'Interrupted save retained its intent. Inspect disk and recovered draft before a new deliberate save.',
    );
  }
  /** Takes a host's save status into the record; returns whether it is an outcome. */
  private applySaveStatus(record: SaveRecord, status: SaveStatus, notStarted: Set<string>) {
    if (status.kind === 'saved') {
      // The host names the version it saved; the text is the request's.
      if (status.version !== hash(record.input.text)) {
        record.message = 'The host reports a different text saved; inspect disk.';
        return false;
      }
      const disk = { text: record.input.text, version: status.version };
      record.result = { kind: 'saved', disk, recoveryChanges: [] };
    } else if (status.kind === 'conflict') record.result = { kind: 'conflict', disk: status.disk };
    else if (status.kind === 'not-started') notStarted.add(saveKey(record.input));
    else {
      if (status.message !== undefined) record.message = status.message;
      return false;
    }
    return true;
  }
  /** Tells the host settled saves need no more replay; a failure is retried at the next load. */
  async acknowledgeSaves(
    records: { state: SaveRecord['state']; input: { clientId: string; requestId: string } }[],
    signal: AbortSignal,
  ) {
    await forEachConcurrently(
      records.filter((record) => record.state === 'settled'),
      async (record) => {
        const { clientId, requestId } = record.input;
        try {
          await this.host.acknowledgeSave({ clientId, requestId }, signal);
          this.store.markSaveDone(saveKey(record.input));
          record.state = 'done';
        } catch {
          /* The host keeps the entry until the next acknowledgement. */
        }
      },
    );
  }

  // Operations
  startOperation(id: string, checkoutId: string) {
    this.activeOperations.set(id, checkoutId);
  }
  finishOperation(id: string) {
    this.activeOperations.delete(id);
  }
  isOperationActive(id: string) {
    return this.activeOperations.has(id);
  }
  reserveOperation(id: string, record: OperationRecord) {
    return this.store.reserve('operations', id, record);
  }
  discardOperation(id: string) {
    this.store.delete('operations', id);
  }
  getOperation(id: string) {
    return this.store.get<OperationRecord>('operations', id);
  }
  private putOperation(id: string, record: OperationRecord) {
    record.open = isOpen(record);
    this.store.put('operations', id, record);
  }
  /** Operation records with something left to do, optionally in one checkout. */
  private getOpenOperations(target?: CheckoutTarget) {
    return target
      ? this.store.all<OperationRecord>(
          'operations',
          openOperations + " AND json_extract(body, '$.input.checkout.checkoutId') = ?",
          [target.checkoutId],
        )
      : this.store.all<OperationRecord>('operations', openOperations);
  }
  /** Revisions of every local recovery that names the checkout, as the operation begins. */
  getPublicationRevisions(checkout: CheckoutTarget, clientId: string, recoveries: Recoveries) {
    const revisions: Record<string, number> = {
      [clientId]: recoveries.readable.find((r) => r.client === clientId)?.revision ?? 0,
    };
    // Another client's unreadable recovery is reported when that client loads.
    for (const { client, revision, state } of recoveries.readable)
      if (state.checkouts.some((c) => same(c, checkout))) revisions[client] = revision;
    return revisions;
  }
  /** Where a local record touches: its sources and destinations, or its items when reported by the feed. */
  footprint(record: OperationRecord) {
    const input = record.input;
    if (record.remote)
      return record.result.items.flatMap((item) =>
        item.destination === undefined ? [item.source] : [item.source, item.destination],
      );
    const sources = input.sources.map((s) => s.target.path);
    if (input.destination === undefined) return sources;
    return [
      ...sources,
      ...(sources.length > 1
        ? sources.map((p) => join(input.destination!, basename(p)))
        : [input.destination]),
    ];
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
  /** Refuses to start over work whose outcome this client has not settled. */
  assertSettled(target: CheckoutTarget, paths: string[], clientId: string) {
    if (
      this.getUnsettledOperations(target, clientId).some((r) =>
        overlaps(paths, this.footprint(r)),
      ) ||
      this.getPendingSaves(target).some((r) => overlaps(paths, [r.request.target.path]))
    )
      fail(
        'Uncertain',
        'An operation awaits recovery publication or inspection. Query its status; do not repeat the mutation.',
      );
  }
  /** Refuses when any local recovery holds a draft that `conflicts` with in the checkout. */
  assertDestinationAvailable(
    target: CheckoutTarget,
    conflicts: (draftPath: string) => boolean,
    { readable, unreadable }: Recoveries,
  ) {
    // An unreadable recovery may hold a draft here.
    ensure(
      !unreadable.length,
      'Recovery of ' +
        unreadable[0]?.client +
        ' is unreadable and may hold drafts at the destination.',
    );
    for (const { state } of readable)
      ensure(
        !state.drafts.some(
          (d) => d.target.checkout.checkoutId === target.checkoutId && conflicts(d.target.path),
        ),
        'Destination has recovery drafts. Preserve them before replacement.',
      );
  }
  /** Takes the host's items and outcome into the client's record, ahead of publishing it. */
  adoptHostResult(record: OperationRecord, host: HostOperationResult) {
    record.result = {
      ...record.result,
      items: host.items,
      outcome: host.outcome,
    };
    if (host.message === undefined) delete record.result.message;
    else record.result.message = host.message;
  }
  async replayOperation(
    id: string,
    input: WorkspaceOperation,
    record: OperationRecord,
    signal: AbortSignal,
  ) {
    if (!same(record.input, input))
      fail('Conflict', 'Operation ID already belongs to another payload/client/checkout.');
    if (this.activeOperations.has(id)) return { result: record.result, missing: false };
    if (record.publicationError) this.publishOperation(id, record);
    // `missing`: the host has no record of a request that was left unanswered, so it may be sent.
    const missing =
      !record.remote &&
      record.result.outcome === 'uncertain' &&
      (await this.resolveOperation(id, record, signal)) === 'missing' &&
      record.result.items.length === 0;
    return { result: record.result, missing };
  }
  /** Asks the host what became of an operation this client sent, and applies what it reports. */
  async resolveOperation(
    id: string,
    record: OperationRecord,
    signal: AbortSignal,
  ): Promise<'found' | 'missing' | 'unavailable'> {
    let host: HostOperationResult | null;
    try {
      host = await this.host.operationStatus(
        { clientId: record.input.clientId, id: record.input.id },
        signal,
      );
    } catch {
      return 'unavailable';
    }
    if (!host) return 'missing';
    this.adoptHostResult(record, host);
    this.publishOperation(id, record);
    return 'found';
  }
  /** One operation's result, after asking the host about it if its outcome is unknown. */
  async getOperationStatus(input: CommandInput<'operationStatus'>, signal: AbortSignal) {
    identifier(input.clientId);
    identifier(input.id);
    const id = key(input.clientId, input.id),
      record = this.getOperation(id);
    if (!record) return null;
    if (!this.activeOperations.has(id) && !this.isCheckoutActive(record.input.checkout.checkoutId))
      if (!record.remote && record.result.outcome === 'uncertain')
        await this.resolveOperation(id, record, signal);
      else if (record.publicationError) this.publishOperation(id, record);
    return record.result;
  }
  /** Returns whether the host should now be told this client's own operation is settled. */
  acknowledgeOperation(input: CommandInput<'acknowledgeOperation'>) {
    identifier(input.clientId);
    identifier(input.operationClientId);
    identifier(input.id);
    const id = key(input.operationClientId, input.id),
      record = this.getOperation(id);
    if (!record || record.acknowledgedBy.includes(input.clientId)) return false;
    const observation = this.store.readRecovery(input.clientId);
    if (
      input.clientId !== input.operationClientId &&
      !observation?.state.checkouts.some((c) => same(c, record.input.checkout))
    )
      fail('Unauthorized', 'Observer has not opened this exact checkout.');
    if (
      record.publicationError ||
      record.result.items.some(
        (item) =>
          item.outcome === 'completed' && !(record.publishedItems ?? []).includes(canonical(item)),
      )
    )
      fail(
        'Persistence',
        'Known operation recovery publication is pending. Preserve the prior valid snapshot before acknowledgement.',
      );
    if (record.result.outcome === 'uncertain')
      fail(
        'Uncertain',
        'Uncertain operation evidence cannot be acknowledged away. Inspect the affected paths.',
      );
    if (
      this.store.publication(input.clientId) <=
      (record.publicationRevisions[input.clientId] ?? observation?.revision ?? 0)
    )
      fail('Persistence', 'Publish reconciled recovery before acknowledging this operation.');
    this.putOperation(id, {
      ...record,
      acknowledgedBy: [...record.acknowledgedBy, input.clientId],
    });
    return !record.remote && input.clientId === input.operationClientId;
  }
  markOperationAcknowledged(id: string) {
    const record = this.getOperation(id);
    if (record) this.putOperation(id, { ...record, hostAcknowledged: true });
  }

  persistRecovery = async (input: CommandInput<'persistRecovery'>, signal: AbortSignal) => {
    identifier(input.clientId);
    identifier(input.requestId);
    ensure(
      Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
      'Invalid recovery revision.',
    );
    recovery(input.state, input.clientId);
    if (signal.aborted) fail('Cancelled', 'Recovery publication cancelled before commit.');
    const digest = hash(canonical(input)),
      previous = this.store.replayPublication(input, digest);
    if (previous) return previous;
    // A checkout the client already recovered was approved, and its feed followed, when it was added.
    const retained = this.store.readRecovery(input.clientId)?.state;
    const added = input.state.checkouts.filter(
      (target) => !retained?.checkouts.some((c) => same(c, target)),
    );
    for (const target of added) await this.host.verifyCheckout(target, signal);
    if (added.length) await this.followCheckouts(added, signal);
    if (signal.aborted) fail('Cancelled', 'Recovery publication cancelled before commit.');
    const state = input.state;
    for (const record of this.getOpenOperations()) {
      if (record.result.outcome !== 'uncertain') continue;
      for (const draft of retained?.drafts ?? [])
        if (
          same(draft.target.checkout, record.input.checkout) &&
          record.input.sources.some((s) => affected(draft.target.path, s.target.path)) &&
          !state.drafts.some((d) => same(d.target, draft.target))
        )
          fail(
            'Persistence',
            'An uncertain operation still owns this recovery draft. Inspect/reconcile the original paths before discarding it.',
          );
    }
    return this.store.persist(input, digest);
  };
  /**
   * Starts following the operation feed of checkouts entering the recovery at the host's present
   * position, so moves made after this are applied however long before the next load. A checkout
   * another local recovery already names keeps its position. A host that cannot list it leaves it
   * to the next feed sync.
   */
  private async followCheckouts(targets: CheckoutTarget[], signal: AbortSignal) {
    const { readable } = this.store.readRecoveries();
    for (const target of targets) {
      const followed =
        this.store.get<FeedCursor>('feed-cursors', feedKey(target)) &&
        readable.some((r) =>
          r.state.checkouts.some(
            (c) => c.hostId === target.hostId && c.checkoutId === target.checkoutId,
          ),
        );
      if (followed) continue;
      try {
        const feed = await this.host.listOperations({ checkout: target, after: null }, signal);
        this.store.put('feed-cursors', feedKey(target), {
          sequence: feed.through,
          epoch: feed.epoch,
        });
      } catch {
        // The next feed sync starts it, marking the checkout's history as incomplete.
        this.store.delete('feed-cursors', feedKey(target));
      }
    }
  }
  /**
   * Starts following the feed of checkouts a save's restored text may bring into the recovery, so
   * they are not later reported as having an unknown history. A host that cannot answer leaves
   * that to the next feed sync.
   */
  private async followRestoredCheckouts(records: SaveRecord[], signal: AbortSignal) {
    const targets = new Map(
      records.map((r) => [feedKey(r.input.target.checkout), r.input.target.checkout]),
    );
    await forEachConcurrently([...targets], async ([id, target]) => {
      if (this.store.get<FeedCursor>('feed-cursors', id)) return;
      try {
        const feed = await this.host.listOperations({ checkout: target, after: null }, signal);
        this.store.put('feed-cursors', id, { sequence: feed.through, epoch: feed.epoch });
      } catch {
        /* The next feed sync starts it and reports what it could not know. */
      }
    });
  }
  /** Marks a checkout's history incomplete: its drafts may be at paths a missed move left behind. */
  private markGap(target: CheckoutTarget) {
    this.store.put('feed-gaps', feedKey(target), {
      hostId: target.hostId,
      checkoutId: target.checkoutId,
    });
  }
  /**
   * Applies an operation's completed items to every local recovery that names its checkout, and
   * records it, in one transaction. A failure is kept with the record (when the store can still
   * be written) and retried at the next load or repeat; the host also keeps the outcome until it
   * is acknowledged.
   */
  publishOperation(id: string, record: OperationRecord) {
    try {
      const [merged] = this.store.transaction(() => this.applyOperations([{ id, record }]));
      delete record.publicationError;
      Object.assign(record, merged.updated);
    } catch (error) {
      this.recordPublicationFailure(id, record, error);
    }
  }
  private recordPublicationFailure(id: string, record: OperationRecord, error: unknown) {
    record.publicationError =
      'Recovery publication pending; previous valid snapshot retained. ' + errorText(error);
    record.result.message = record.publicationError;
    try {
      const committed = this.getOperation(id);
      record.result.recoveryChanges = dedupeChanges([
        ...(committed?.result.recoveryChanges ?? []),
        ...record.result.recoveryChanges,
      ]);
      record.publishedItems = [
        ...new Set([...(committed?.publishedItems ?? []), ...(record.publishedItems ?? [])]),
      ];
      this.putOperation(id, record);
    } catch {
      /* The host still holds the outcome; the next load or repeat asks it again. */
    }
  }
  /** Merges each record with what is stored and applies new items; the caller owns the transaction. */
  private applyOperations(entries: { id: string; record: OperationRecord }[]) {
    const merged = entries.map(({ id, record }) => this.mergeOperation(id, record));
    const changed = merged.filter((m) => m.changed);
    if (!changed.length) return merged;
    const { readable, unreadable } = this.store.readRecoveries();
    const applying = changed.filter((m) => m.fresh.length);
    // An unreadable client recovery is skipped here, so its draft may stay at a moved path:
    // the checkout's history is marked incomplete (every load reports the row).
    if (unreadable.length) for (const m of applying) this.markGap(m.updated.input.checkout);
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
        for (const target of collisions.values()) this.markGap(target);
        if (JSON.stringify(state) !== body) {
          recovery(state, client);
          this.store.writeInternalRecovery(client, revision, state);
          const change = { clientId: client, previousRevision: revision, revision: revision + 1 };
          for (const m of fresh) m.updated.result.recoveryChanges.push(change);
          revision++;
        }
      }
      for (const m of relevant) m.updated.publicationRevisions[client] = revision;
    }
    for (const m of changed) {
      m.updated.result.recoveryChanges = dedupeChanges(m.updated.result.recoveryChanges);
      this.putOperation(m.id, m.updated);
    }
    return merged;
  }
  private mergeOperation(id: string, record: OperationRecord): MergedOperation {
    const committed = this.getOperation(id);
    if (committed && !same(committed.input, record.input))
      fail('Conflict', 'Operation identity changed before recovery publication.');
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
    else if (
      originals.length !== expected ||
      originals.some((item) => item.outcome === 'uncertain')
    )
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
      publicationRevisions: {
        ...record.publicationRevisions,
        ...committed?.publicationRevisions,
      },
      acknowledgedBy: [
        ...new Set([...(committed?.acknowledgedBy ?? []), ...record.acknowledgedBy]),
      ],
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
  /**
   * Applies saves' outcomes to the client's recovery in one transaction. When restoring, the text
   * of every save whose text did not reach the disk is put back as a draft over its baseline, for
   * the client's whole group of unresolved saves at once, but only while no client publication
   * came after the save began (a later one is the client's own newer word). `notStarted` names
   * saves the host never admitted.
   */
  publishSaves(
    records: SaveRecord[],
    restore = false,
    notStarted: ReadonlySet<string> = new Set(),
  ) {
    if (!records.length) return;
    const clientId = records[0].input.clientId;
    ensure(
      records.every((record) => record.input.clientId === clientId),
      'A Save publication group belongs to one client.',
    );
    this.store.transaction(() => {
      if (restore) {
        const group = new Map(
          this.store
            .readSaves(unresolvedSaves + " AND json_extract(body, '$.request.clientId') = ?", [
              clientId,
            ])
            .map((r) => [saveKey(r.input), r]),
        );
        for (const record of records) group.set(saveKey(record.input), record);
        if ([...group.keys()].some((id) => this.activeSaves.has(id)))
          fail(
            'Persistence',
            'A Save in the complete recovery group is still running. Retry recovery after it settles.',
          );
        records = [...group.values()];
      }
      const stored = this.store.readRecovery(clientId),
        revision = stored?.revision ?? 0,
        publication = this.store.publication(clientId),
        state = stored?.state ?? emptyRecovery(clientId);
      let changed = false;
      // Baselines this publication replaces in drafts, which a save may still have begun from.
      const replaced: FileDocument[] = [];
      const updates = records.map((record) => {
        const id = saveKey(record.input),
          committed = this.store.get<StoredSave>('save-records', id);
        if (!committed || !same(committed.request, toStoredSave(record).request))
          return fail('Conflict', 'Save identity changed before recovery publication.');
        // The stored record says how far the save got; its text is the one it was reserved with.
        const base = fromStoredSave(committed, record.input.text, record.baseline.text);
        if (base.state === 'settled' || base.state === 'done')
          return { id, record, committed, updated: base, changed: false };
        const result: SaveResult | undefined =
          record.result?.kind === 'saved'
            ? {
                kind: 'saved',
                disk: record.result.disk,
                recoveryChanges: record.result.recoveryChanges,
              }
            : record.result;
        const restores =
          restore &&
          base.state === 'sent' &&
          result?.kind !== 'saved' &&
          base.recoveryPublication === publication;
        let drafted = false;
        if (restores) {
          const disk = findBaseline(state, record.input.target, base.baseline);
          if (!disk)
            return fail(
              'Persistence',
              'The text a Save began from is no longer in the recovery; its text is kept. Inspect disk.',
            );
          if (!state.checkouts.some((c) => same(c, record.input.target.checkout))) {
            state.checkouts.push(record.input.target.checkout);
            drafted = true;
          }
          const existing = state.drafts.find((d) => same(d.target, record.input.target));
          if (!existing) {
            state.drafts.push({ target: record.input.target, text: record.input.text, disk });
            drafted = true;
          } else if (
            existing.text !== record.input.text ||
            existing.disk.version !== disk.version
          ) {
            existing.text = record.input.text;
            if (existing.disk.version !== disk.version) replaced.push(existing.disk);
            existing.disk = disk;
            drafted = true;
          }
        }
        if (result?.kind === 'saved')
          for (const draft of state.drafts)
            if (
              same(draft.target, record.input.target) &&
              draft.disk.version !== result.disk.version
            ) {
              replaced.push(draft.disk);
              draft.disk = result.disk;
              drafted = true;
            }
        changed ||= drafted;
        let next: SaveRecord['state'] = restores ? 'restored' : base.state;
        if (result) next = 'settled';
        else if (notStarted.has(id)) next = 'done';
        const updated: SaveRecord = {
          ...base,
          state: next,
          ...(result ? { result } : {}),
          ...(record.message === undefined ? {} : { message: record.message }),
        };
        return { id, record, committed, updated, changed: drafted };
      });
      if (changed) {
        recovery(state, clientId);
        this.store.writeInternalRecovery(clientId, revision, state);
      }
      const settling = updates.filter((u) => u.updated.state !== 'sent').map((u) => u.id);
      for (const disk of replaced) this.store.keepBaseline(clientId, disk, settling);
      for (const entry of updates) {
        if (changed && entry.changed && entry.updated.result?.kind === 'saved')
          entry.updated.result = {
            ...entry.updated.result,
            recoveryChanges: [
              ...entry.updated.result.recoveryChanges,
              { clientId, previousRevision: revision, revision: revision + 1 },
            ],
          };
        if (!same(entry.committed, toStoredSave(entry.updated)))
          this.store.writeSave(entry.id, entry.updated);
      }
      for (const { record, updated } of updates) Object.assign(record, updated);
    });
  }

  /**
   * Resolves what the host knows of every save and operation this client left open: a settled
   * outcome is applied, a request the host never admitted is restored as a draft, and anything
   * still unclear is kept with its text. Returns, per save, why its restoration is still pending.
   */
  async recoverEvidence(signal: AbortSignal, openIds?: Set<string>) {
    const notes = new Map<string, string>();
    const groups = new Map<string, SaveRecord[]>();
    for (const record of this.store.readSaves(unresolvedSaves))
      groups.set(record.input.clientId, [...(groups.get(record.input.clientId) ?? []), record]);
    await forEachConcurrently([...groups.values()], async (records) => {
      if (records.some((record) => this.isCheckoutActive(record.input.target.checkout.checkoutId)))
        return;
      const notStarted = new Set<string>();
      await forEachConcurrently(
        records.filter((r) => !openIds || openIds.has(r.input.target.checkout.checkoutId)),
        async (record) => {
          const { clientId, requestId } = record.input;
          try {
            const status = await this.host.saveStatus({ clientId, requestId }, signal);
            this.applySaveStatus(record, status, notStarted);
          } catch {
            /* Restore admitted text without guessing an unavailable host's outcome. */
          }
        },
      );
      await this.followRestoredCheckouts(records, signal);
      try {
        this.publishSaves(records, true, notStarted);
      } catch (error) {
        for (const record of records)
          notes.set(
            saveKey(record.input),
            'Admitted Save recovery publication pending; previous valid snapshot retained. ' +
              errorText(error),
          );
      }
    });
    await forEachConcurrently(this.getOpenOperations(), async (record) => {
      const id = operationKey(record);
      if (this.isCheckoutActive(record.input.checkout.checkoutId) || this.activeOperations.has(id))
        return;
      if (!record.remote && record.result.outcome === 'uncertain')
        await this.resolveOperation(id, record, signal);
      else if (record.publicationError) this.publishOperation(id, record);
    });
    await this.acknowledgeSaves(
      this.store
        .all<StoredSave>(
          'save-records',
          pendingSaves + " AND json_extract(body, '$.state') = 'settled'",
        )
        .map((r) => ({ state: r.state, input: r.request })),
      signal,
    );
    await forEachConcurrently(
      this.getOpenOperations().filter(
        (r) =>
          !r.remote &&
          !r.hostAcknowledged &&
          r.result.outcome !== 'uncertain' &&
          r.acknowledgedBy.includes(r.input.clientId),
      ),
      async (record) => {
        try {
          await this.host.acknowledgeOperation(
            { clientId: record.input.clientId, id: record.input.id },
            signal,
          );
          this.markOperationAcknowledged(operationKey(record));
        } catch {
          /* The host keeps the entry until the next acknowledgement. */
        }
      },
    );
    return notes;
  }

  /**
   * Applies completed moves, copies and Trash that other installations' clients made in the local
   * recoveries' checkouts since each checkout's position. A checkout whose history cannot be listed
   * keeps its position and is listed again on the next load. Returns messages for what failed.
   */
  async syncFeed(recoveries: StoredRecovery[], signal: AbortSignal) {
    const targets = new Map<string, CheckoutTarget>();
    for (const { state } of recoveries)
      for (const target of state.checkouts) targets.set(feedKey(target), target);
    const errors: string[] = [];
    await forEachConcurrently([...targets.values()], async (target) => {
      try {
        await this.syncCheckoutFeed(target, signal);
      } catch (error) {
        // A host that ran out of time is reported once by the load.
        if (!signal.aborted)
          errors.push('Operation history unavailable for ' + target.root + ': ' + errorText(error));
      }
    });
    return errors;
  }
  private async syncCheckoutFeed(target: CheckoutTarget, signal: AbortSignal) {
    const id = feedKey(target);
    const restart = async () => {
      // What came before the present is unknowable: drafts there are reported until resolved.
      const feed = await this.host.listOperations({ checkout: target, after: null }, signal);
      this.store.transaction(() => {
        this.markGap(target);
        this.store.put('feed-cursors', id, { sequence: feed.through, epoch: feed.epoch });
      });
    };
    let cursor = this.store.get<FeedCursor>('feed-cursors', id);
    // A checkout that entered a recovery without being followed (such as by a restored save).
    if (!cursor) return restart();
    for (;;) {
      const feed = await this.host.listOperations(
        { checkout: target, after: cursor.sequence },
        signal,
      );
      // A recreated host store restarts its sequence.
      if (feed.epoch !== cursor.epoch) return restart();
      this.applyFeedPage(target, cursor, feed);
      if (!feed.more) return;
      cursor = { sequence: feed.through, epoch: feed.epoch };
    }
  }
  /**
   * Applies one page of a checkout's feed and advances its position in one transaction. A page
   * that cannot be applied to the recovery (one too large for it, say) is kept with its error, to
   * be retried at each load like an operation of this client's, and the position still advances.
   */
  private applyFeedPage(target: CheckoutTarget, cursor: FeedCursor, feed: OperationFeed) {
    const records = this.readFeedRecords(feed.operations);
    const advance = () => {
      if (feed.floor > cursor.sequence) this.markGap(target);
      this.store.put('feed-cursors', feedKey(target), {
        sequence: feed.through,
        epoch: feed.epoch,
      });
    };
    try {
      this.store.transaction(() => {
        if (records.length) this.applyOperations(structuredClone(records));
        advance();
      });
    } catch (error) {
      this.store.transaction(() => {
        for (const { id, record } of records) this.recordPublicationFailure(id, record, error);
        advance();
      });
    }
  }
  /** Other installations' feed entries as remote operation records, one per operation. */
  private readFeedRecords(entries: OperationFeedEntry[]) {
    const records = new Map<string, OperationRecord>();
    for (const entry of entries) {
      // This installation applies its own results as they return.
      if (entry.installationId === this.installationId) continue;
      const id = key(entry.clientId, entry.id);
      let record = records.get(id) ?? this.getOperation(id);
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

  async loadRecovery(clientId: string, signal: AbortSignal) {
    identifier(clientId);
    const recoveries = this.store.readRecoveries();
    // This client's own recovery must read; another's that does not is reported.
    if (recoveries.unreadable.some((r) => r.client === clientId)) throw invalidStored();
    const before = recoveries.readable.find((r) => r.client === clientId);
    const errors = recoveries.unreadable.map(
      ({ client, error }) => 'Recovery of ' + client + ' is unreadable: ' + error,
    );
    // A host that is slow to answer (such as a daemon still starting) is given `hostWaitMs` for all
    // its phases together. What it did not answer is retried on the next load, and local work
    // (drafting unsettled saves) needs no host.
    const hostSignal = AbortSignal.any([signal, AbortSignal.timeout(this.hostWaitMs)]);
    const withHost = async (phase: () => Promise<string[] | void>) => {
      try {
        errors.push(...((await phase()) ?? []));
      } catch (error) {
        if (signal.aborted) throw error;
        if (!hostSignal.aborted) errors.push(errorText(error));
      }
    };
    await withHost(() => this.syncFeed(recoveries.readable, hostSignal));
    let notes = new Map<string, string>();
    await withHost(async () => {
      notes = await this.recoverEvidence(hostSignal, new Set(before?.state.openCheckoutIds ?? []));
    });
    const stored = this.store.readRecovery(clientId),
      state = stored?.state ?? emptyRecovery(clientId);
    await forEachConcurrently(
      state.checkouts.filter((c) => state.openCheckoutIds.includes(c.checkoutId)),
      async (target) => {
        try {
          if (!hostSignal.aborted) await this.host.verifyCheckout(target, hostSignal);
        } catch (error) {
          if (!hostSignal.aborted) errors.push(target.root + ': ' + errorText(error));
        }
      },
    );
    signal.throwIfAborted();
    if (hostSignal.aborted)
      errors.push(
        'The local host did not answer in time; files are checked again on the next load.',
      );
    const relevant = this.getOpenOperations().filter(
      (r) =>
        !r.acknowledgedBy.includes(clientId) &&
        (r.input.clientId === clientId || state.checkouts.some((c) => same(c, r.input.checkout))),
    );
    for (const record of relevant)
      if (record.publicationRevisions[clientId] === undefined) {
        record.publicationRevisions[clientId] = stored?.revision ?? 0;
        this.putOperation(operationKey(record), record);
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
    for (const record of this.store.all<StoredSave>(
      'save-records',
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
    errors.push(...this.getFeedGapErrors(state));
    return { revision: stored?.revision ?? 0, state, errors, operations };
  }
  /** A gap's mark stays while any local recovery still holds a draft in its checkout. */
  private getFeedGapErrors(state: EditorRecovery) {
    const gaps = this.store.all<{ hostId: string; checkoutId: string }>('feed-gaps');
    if (!gaps.length) return [];
    const errors: string[] = [];
    const { readable, unreadable } = this.store.readRecoveries();
    for (const gap of gaps) {
      // An unreadable recovery may hold a draft in any gapped checkout: its marks stay (the load
      // reports the unreadable row).
      const held =
        unreadable.length > 0 ||
        readable.some((r) =>
          r.state.drafts.some((d) => d.target.checkout.checkoutId === gap.checkoutId),
        );
      if (!held) this.store.delete('feed-gaps', key(gap.hostId, gap.checkoutId));
      else if (state.drafts.some((d) => d.target.checkout.checkoutId === gap.checkoutId))
        errors.push(
          'Operation history for ' +
            gap.checkoutId +
            ' is incomplete: drafts stay at their last known paths and need attention.',
        );
    }
    return errors;
  }
}
