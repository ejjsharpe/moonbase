import { basename, join } from 'node:path';
import {
  emptyRecovery,
  type CheckoutTarget,
  type CommandInput,
  type EditorRecovery,
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
  parseRecovery,
  savedRevision,
  type OperationRecord,
  type SaveRecord,
} from './client-schema.ts';
import { type ClientStore, pendingSaves } from './client-store.ts';
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

export function reconcile(state: EditorRecovery, records: OperationRecord[]) {
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
      if (kind === 'copy') {
        // oxlint-disable-next-line no-useless-spread -- Copies append to state.drafts; iterate only the original drafts.
        for (const draft of [...state.drafts])
          if (
            matches(draft.target) &&
            !state.drafts.some(
              (d) =>
                same(d.target.checkout, draft.target.checkout) &&
                d.target.path === move(draft.target.path),
            )
          )
            state.drafts.push({
              ...draft,
              target: { ...draft.target, path: move(draft.target.path) },
            });
        continue;
      }
      // Trash never proves permission to discard another client's dirty work.
      if (kind === 'move') {
        state.drafts = state.drafts.map((d) =>
          matches(d.target) ? { ...d, target: { ...d.target, path: move(d.target.path) } } : d,
        );
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

const attentionPredicate = `json_extract(body, '$.result.outcome') IS NOT 'completed'
      OR json_extract(body, '$.publicationError') IS NOT NULL
      OR json_extract(body, '$.publishedItems') IS NULL
      OR EXISTS (
        SELECT 1 FROM json_each(body, '$.result.items') i
        WHERE json_extract(i.value, '$.outcome') = 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM json_each(body, '$.publishedItems') p
            WHERE json_extract(p.value, '$.source') IS json_extract(i.value, '$.source')
              AND json_extract(p.value, '$.destination') IS json_extract(i.value, '$.destination')
              AND json_extract(p.value, '$.outcome') IS json_extract(i.value, '$.outcome')
              AND json_extract(p.value, '$.message') IS json_extract(i.value, '$.message')
          )
      )`;

/**
 * One client's recovery: the drafts and editor state it publishes, and the intents for the saves
 * and operations it has sent to the file host. An outcome from the host, the host's status
 * queries or its operation feed is applied to the recovery in one local transaction.
 */
export class WorkspaceRecovery {
  private readonly volatileSaves = new Map<string, SaveRecord>();
  private readonly activeSaves = new Map<string, string>();
  private readonly volatileOperations = new Map<string, OperationRecord>();
  private readonly activeOperations = new Map<string, string>();
  private readonly store: ClientStore;
  private readonly host: HostPorts;
  private readonly installationId: string;
  constructor(store: ClientStore, host: HostPorts, installationId: string) {
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
    return this.store.reserve('saves', id, record);
  }
  retainSave(id: string, record: SaveRecord) {
    this.volatileSaves.set(id, record);
  }
  discardSave(id: string) {
    this.store.delete('saves', id);
  }
  getSaveRecord(id: string) {
    return this.volatileSaves.get(id) ?? this.store.get<SaveRecord>('saves', id);
  }
  private getSaveRecords(clientId?: string) {
    const records = new Map(
      this.store
        .all<SaveRecord>(
          'saves',
          pendingSaves + (clientId ? " AND json_extract(body, '$.input.clientId') = ?" : ''),
          clientId ? [clientId] : [],
        )
        .map((record) => [key(record.input.clientId, record.input.requestId), record]),
    );
    for (const [id, record] of this.volatileSaves) records.set(id, record);
    return [...records.values()];
  }
  /** Saves that have no outcome and are not running now, in one checkout. */
  getPendingSaves(target: CheckoutTarget) {
    return this.store
      .all<SaveRecord>(
        'saves',
        pendingSaves +
          " AND json_extract(body, '$.result') IS NULL AND json_extract(body, '$.notStarted') IS NOT 1 AND json_extract(body, '$.input.target.checkout.checkoutId') = ?",
        [target.checkoutId],
      )
      .filter((r) => !this.activeSaves.has(key(r.input.clientId, r.input.requestId)));
  }
  /** The text a draft held when the save began: its recorded baseline, else the file on the host. */
  async getBaseline(input: CommandInput<'saveFile'>, signal: AbortSignal) {
    const draft = (
      this.store.readRecovery(input.clientId)?.state as EditorRecovery | undefined
    )?.drafts.find((d) => same(d.target, input.target));
    if (draft && draft.disk.version === input.expectedVersion) return draft.disk;
    return this.host.readFile(input.target, signal);
  }
  replaySave(id: string, input: CommandInput<'saveFile'>, record: SaveRecord): SaveResult {
    if (!same(record.input, input))
      fail('Conflict', 'Save request ID already belongs to a different payload or target.');
    if (record.result) {
      if (this.volatileSaves.has(id) || record.restorePending) {
        try {
          this.publishSaves([record]);
        } catch (error) {
          if (record.result.kind !== 'saved')
            return fail(
              'Persistence',
              'Admitted Save recovery publication pending; previous valid snapshot retained. ' +
                errorText(error),
            );
          record.result = {
            ...record.result,
            persistencePending: true,
            message: 'Saved to disk; recovery publication pending. ' + errorText(error),
          };
        }
      }
      return record.result;
    }
    return fail(
      'Uncertain',
      'Interrupted save retained its intent. Inspect disk and recovered draft before a new deliberate save.',
    );
  }
  /** Tells the host a settled save needs no more replay; a failure is retried at the next load. */
  async acknowledgeSaves(records: SaveRecord[], signal: AbortSignal) {
    for (const record of records) {
      if (!record.result || !record.published || record.hostAcknowledged) continue;
      const { clientId, requestId } = record.input;
      try {
        await this.host.acknowledgeSave({ clientId, requestId }, signal);
        const id = key(clientId, requestId);
        const stored = this.store.get<SaveRecord>('saves', id);
        if (stored && stored.published) {
          this.store.put('saves', id, { ...stored, hostAcknowledged: true });
          record.hostAcknowledged = true;
        }
      } catch {
        /* The host keeps the entry until the next acknowledgement. */
      }
    }
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
    return this.volatileOperations.get(id) ?? this.store.get<OperationRecord>('operations', id);
  }
  private getOperations(predicate = '1', parameters: string[] = []) {
    const records = new Map(
      this.store
        .all<OperationRecord>('operations', predicate, parameters)
        .map((r) => [key(r.input.clientId, r.input.id), r]),
    );
    for (const [id, record] of this.volatileOperations) records.set(id, record);
    return [...records.values()];
  }
  /** Revisions of every local recovery that names the checkout, as the operation begins. */
  getPublicationRevisions(checkout: CheckoutTarget, clientId?: string) {
    const revisions: Record<string, number> = clientId
      ? { [clientId]: this.store.readRecovery(clientId)?.revision ?? 0 }
      : {};
    for (const row of this.store.db.prepare('SELECT client, revision, body FROM recovery').all())
      if (parseRecovery(row.body, row.client as string).checkouts.some((c) => same(c, checkout)))
        revisions[row.client as string] = savedRevision(row.revision);
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
    return this.getOperations(
      "json_extract(body, '$.input.checkout.checkoutId') = ? AND (json_extract(body, '$.result.outcome') = 'uncertain' OR NOT EXISTS (SELECT 1 FROM json_each(body, '$.acknowledgedBy') WHERE value = ?))",
      [target.checkoutId, clientId],
    ).filter(
      (r) =>
        !this.activeOperations.has(key(r.input.clientId, r.input.id)) &&
        r.input.checkout.checkoutId === target.checkoutId &&
        (!r.acknowledgedBy.includes(clientId) || r.result.outcome === 'uncertain'),
    );
  }
  /**
   * A checkout's operation records that are not settled for every purpose: uncertain, with a
   * recovery publication still failing, or not yet acknowledged by the client that made them.
   */
  getUnsettledCheckoutOperations(target: CheckoutTarget) {
    return this.getOperations("json_extract(body, '$.input.checkout.checkoutId') = ?", [
      target.checkoutId,
    ]).filter(
      (r) =>
        !this.activeOperations.has(key(r.input.clientId, r.input.id)) &&
        r.input.checkout.checkoutId === target.checkoutId &&
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
      this.getPendingSaves(target).some((r) => overlaps(paths, [r.input.target.path]))
    )
      fail(
        'Uncertain',
        'An operation awaits recovery publication or inspection. Query its status; do not repeat the mutation.',
      );
  }
  assertDestinationAvailable(target: CheckoutTarget, conflicts: (draftPath: string) => boolean) {
    for (const row of this.store.db.prepare('SELECT client, body FROM recovery').all()) {
      const state = parseRecovery(row.body, row.client as string);
      ensure(
        !state.drafts.some(
          (d) => d.target.checkout.checkoutId === target.checkoutId && conflicts(d.target.path),
        ),
        'Destination has recovery drafts. Preserve them before replacement.',
      );
    }
  }
  /** Takes the host's items and outcome into the client's record, ahead of publishing it. */
  adoptHostResult(record: OperationRecord, host: HostOperationResult) {
    record.result = { ...record.result, items: host.items, outcome: host.outcome };
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
    if (this.volatileOperations.has(id)) {
      try {
        this.publishOperation(id, record);
      } catch (error) {
        this.retainPublication(id, record, error);
      }
    }
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
    try {
      this.publishOperation(id, record);
    } catch (error) {
      this.retainPublication(id, record, error);
    }
    return 'found';
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
      !(observation?.state as EditorRecovery | undefined)?.checkouts.some((c) =>
        same(c, record.input.checkout),
      )
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
    this.store.put('operations', id, {
      ...record,
      acknowledgedBy: [...record.acknowledgedBy, input.clientId],
    });
    this.volatileOperations.delete(id);
    return !record.remote && input.clientId === input.operationClientId;
  }
  markOperationAcknowledged(id: string) {
    const record = this.store.get<OperationRecord>('operations', id);
    if (record) this.store.put('operations', id, { ...record, hostAcknowledged: true });
  }
  /** Operations this client issued, acknowledged here, that the host may still be keeping. */
  getUnacknowledgedAtHost() {
    return this.getOperations(
      "json_extract(body, '$.hostAcknowledged') IS NOT 1 AND json_extract(body, '$.remote') IS NOT 1",
    ).filter(
      (r) =>
        !r.remote &&
        !r.hostAcknowledged &&
        r.result.outcome !== 'uncertain' &&
        r.acknowledgedBy.includes(r.input.clientId),
    );
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
    // A checkout the client already recovered was approved when it was added.
    const known = (this.store.readRecovery(input.clientId)?.state as EditorRecovery | undefined)
      ?.checkouts;
    for (const target of input.state.checkouts)
      if (!known?.some((c) => same(c, target))) await this.host.verifyCheckout(target, signal);
    if (signal.aborted) fail('Cancelled', 'Recovery publication cancelled before commit.');
    const state = structuredClone(input.state);
    const retained = this.store.readRecovery(input.clientId)?.state as EditorRecovery | undefined;
    for (const record of this.getOperations(
      "json_extract(body, '$.result.outcome') = 'uncertain'",
    ).filter((r) => r.result.outcome === 'uncertain')) {
      for (const draft of retained?.drafts ?? [])
        if (
          same(draft.target.checkout, record.input.checkout) &&
          record.input.sources.some((s) => affected(draft.target.path, s.target.path))
        )
          if (!state.drafts.some((d) => same(d.target, draft.target)))
            fail(
              'Persistence',
              'An uncertain operation still owns this recovery draft. Inspect/reconcile the original paths before discarding it.',
            );
    }
    return this.store.persist(input, digest);
  };
  retainPublication(id: string, record: OperationRecord, error: unknown) {
    const committed = this.store.get<OperationRecord>('operations', id);
    record.result.recoveryChanges = [
      ...new Map(
        [...(committed?.result.recoveryChanges ?? []), ...record.result.recoveryChanges].map(
          (change) => [canonical(change), change],
        ),
      ).values(),
    ];
    record.publicationError =
      'Recovery publication pending; previous valid snapshot retained. ' + errorText(error);
    record.result.message = record.publicationError;
    this.volatileOperations.set(id, record);
  }
  /**
   * Applies an operation's completed items to every local recovery that names its checkout, and
   * records the operation, in one transaction.
   */
  publishOperation(id: string, record: OperationRecord) {
    this.store.transaction(() => {
      const committed = this.store.get<OperationRecord>('operations', id);
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
      const changed =
        !committed ||
        !same(committed.result.items, mergedItems) ||
        committed.result.outcome !== outcome ||
        fresh.length > 0;
      if (!changed) {
        delete record.publicationError;
        Object.assign(record, committed);
        this.volatileOperations.delete(id);
        return;
      }
      const changes: OperationResult['recoveryChanges'] = [];
      const publicationRevisions = {
        ...record.publicationRevisions,
        ...committed?.publicationRevisions,
      };
      for (const row of this.store.db
        .prepare('SELECT client, revision, body FROM recovery')
        .all()) {
        const clientId = row.client as string,
          state = parseRecovery(row.body, clientId);
        if (
          clientId !== record.input.clientId &&
          !state.checkouts.some((c) => same(c, record.input.checkout))
        )
          continue;
        let revision = savedRevision(row.revision);
        if (fresh.length)
          reconcile(state, [{ ...record, result: { ...record.result, items: fresh } }]);
        recovery(state, clientId);
        if (JSON.stringify(state) !== row.body) {
          this.store.writeInternalRecovery(clientId, revision, state);
          changes.push({ clientId, previousRevision: revision, revision: revision + 1 });
          revision++;
        }
        publicationRevisions[clientId] = revision;
      }
      const retained = [
        ...new Map(
          [
            ...(committed?.result.recoveryChanges ?? []),
            ...record.result.recoveryChanges,
            ...changes,
          ].map((change) => [canonical(change), change]),
        ).values(),
      ];
      const updated: OperationRecord = {
        ...record,
        publicationRevisions,
        acknowledgedBy: [
          ...new Set([...(committed?.acknowledgedBy ?? []), ...record.acknowledgedBy]),
        ],
        publishedItems: [...published, ...fresh.map(canonical)],
        result: { ...record.result, items: mergedItems, outcome, recoveryChanges: retained },
      };
      delete updated.publicationError;
      if (
        updated.result.outcome !== 'uncertain' &&
        (record.publicationError || committed?.result.outcome === 'uncertain')
      )
        delete updated.result.message;
      this.store.put('operations', id, updated);
      delete record.publicationError;
      Object.assign(record, updated);
      this.volatileOperations.delete(id);
    });
  }
  /** Applies a save's outcome (or, when restoring, its text) to the client's recovery. */
  publishSaves(records: SaveRecord[], restore = false) {
    if (!records.length) return;
    const clientId = records[0].input.clientId;
    ensure(
      records.every((record) => record.input.clientId === clientId),
      'A Save publication group belongs to one client.',
    );
    this.store.transaction(() => {
      if (
        restore ||
        records.some(
          (r) =>
            r.restorePending ||
            this.store.get<SaveRecord>('saves', key(clientId, r.input.requestId))?.restorePending,
        )
      ) {
        const group = new Map(
          this.getSaveRecords(clientId)
            .filter((r) => r.input.clientId === clientId && (!r.published || r.restorePending))
            .map((r) => [key(clientId, r.input.requestId), r]),
        );
        for (const record of records) group.set(key(clientId, record.input.requestId), record);
        records = [...group.values()];
        restore = true;
        if ([...group.keys()].some((id) => this.activeSaves.has(id)))
          fail(
            'Persistence',
            'A Save in the complete recovery group is still running. Retry recovery after it settles.',
          );
      }
      const stored = this.store.readRecovery(clientId),
        revision = stored?.revision ?? 0;
      const publication = this.store.publication(clientId);
      const state = (stored?.state ?? emptyRecovery(clientId)) as EditorRecovery,
        before = JSON.stringify(state);
      const updates = records.map((record) => {
        const id = key(clientId, record.input.requestId),
          committed = this.store.get<SaveRecord>('saves', id);
        if (committed && !same(committed.input, record.input))
          fail('Conflict', 'Save identity changed before recovery publication.');
        const knownResult = committed?.published ? committed.result : record.result;
        const result: SaveResult | undefined =
          knownResult?.kind === 'saved'
            ? {
                kind: 'saved',
                disk: knownResult.disk,
                recoveryChanges: knownResult.recoveryChanges,
              }
            : knownResult;
        const wantsRestore = restore || record.restorePending || committed?.restorePending;
        const intent = committed ?? record,
          hasFence = intent.recoveryPublication !== undefined;
        const restored = !!(
          wantsRestore &&
          !committed?.recoveryRestored &&
          record.baseline &&
          hasFence &&
          intent.recoveryPublication === publication
        );
        const entryBefore = JSON.stringify(state);
        if (restored) {
          if (!state.checkouts.some((c) => same(c, record.input.target.checkout)))
            state.checkouts.push(record.input.target.checkout);
          const existing = state.drafts.find((d) => same(d.target, record.input.target));
          if (existing) {
            existing.text = record.input.text;
            existing.disk = record.baseline!;
          } else
            state.drafts.push({
              target: record.input.target,
              text: record.input.text,
              disk: record.baseline!,
            });
        }
        if (hasFence && !committed?.published && result?.kind === 'saved')
          for (const draft of state.drafts)
            if (same(draft.target, record.input.target)) draft.disk = result.disk;
        const updated: SaveRecord = {
          ...record,
          result,
          published: !!result || !!record.notStarted,
          recoveryRestored: !!committed?.recoveryRestored || restored,
          restorePending: !!wantsRestore && !committed?.recoveryRestored && !restored,
        };
        return { id, record, committed, updated, changed: entryBefore !== JSON.stringify(state) };
      });
      recovery(state, clientId);
      const changed = JSON.stringify(state) !== before;
      if (changed) this.store.writeInternalRecovery(clientId, revision, state);
      for (const entry of updates) {
        if (changed && entry.changed && entry.updated.result?.kind === 'saved')
          entry.updated.result = {
            ...entry.updated.result,
            recoveryChanges: [
              ...entry.updated.result.recoveryChanges,
              { clientId, previousRevision: revision, revision: revision + 1 },
            ],
          };
        if (!same(entry.committed, entry.updated)) this.store.put('saves', entry.id, entry.updated);
      }
      for (const { id, record, updated } of updates) {
        Object.assign(record, updated);
        this.volatileSaves.delete(id);
      }
    });
  }

  /**
   * Resolves what the host knows of every save and operation this client left open: a settled
   * outcome is applied, a request the host never admitted is restored as a draft, and anything
   * still unclear is kept with its text.
   */
  async recoverEvidence(signal: AbortSignal, openIds?: Set<string>) {
    const groups = new Map<string, SaveRecord[]>();
    for (const record of this.getSaveRecords()) {
      if (record.published && !record.restorePending) continue;
      const records = groups.get(record.input.clientId) ?? [];
      records.push(record);
      groups.set(record.input.clientId, records);
    }
    for (const records of groups.values()) {
      if (records.some((record) => this.isCheckoutActive(record.input.target.checkout.checkoutId)))
        continue;
      for (const record of records)
        if (
          !record.result &&
          !record.notStarted &&
          (!openIds || openIds.has(record.input.target.checkout.checkoutId))
        ) {
          try {
            const status = await this.host.saveStatus(
              { clientId: record.input.clientId, requestId: record.input.requestId },
              signal,
            );
            if (status.kind === 'saved')
              record.result = { kind: 'saved', disk: status.disk, recoveryChanges: [] };
            else if (status.kind === 'conflict')
              record.result = { kind: 'conflict', disk: status.disk };
            else if (status.kind === 'not-started') record.notStarted = true;
            else if (status.message !== undefined) record.message = status.message;
          } catch {
            /* Restore admitted text without guessing an unavailable host's outcome. */
          }
        }
      try {
        this.publishSaves(records, true);
      } catch (error) {
        for (const record of records) {
          record.restorePending = !record.recoveryRestored;
          record.message =
            'Admitted Save recovery publication pending; previous valid snapshot retained. ' +
            errorText(error);
          this.volatileSaves.set(key(record.input.clientId, record.input.requestId), record);
        }
      }
      await this.acknowledgeSaves(records, signal);
    }
    for (const record of this.getOperations(attentionPredicate)) {
      const id = key(record.input.clientId, record.input.id);
      if (this.isCheckoutActive(record.input.checkout.checkoutId) || this.activeOperations.has(id))
        continue;
      if (!record.remote && record.result.outcome === 'uncertain') {
        if ((await this.resolveOperation(id, record, signal)) !== 'found') continue;
      } else if (record.publicationError || this.volatileOperations.has(id)) {
        try {
          this.publishOperation(id, record);
        } catch (error) {
          this.retainPublication(id, record, error);
        }
      }
    }
    for (const record of this.getUnacknowledgedAtHost()) {
      const id = key(record.input.clientId, record.input.id);
      try {
        await this.host.acknowledgeOperation(
          { clientId: record.input.clientId, id: record.input.id },
          signal,
        );
        this.markOperationAcknowledged(id);
      } catch {
        /* The host keeps the entry until the next acknowledgement. */
      }
    }
  }

  /**
   * Applies completed moves, copies and Trash that other installations' clients made in this
   * client's checkouts since the last time. A gap past the host's retention leaves drafts at their
   * old paths and marks them. Returns messages for what could not be read.
   */
  async syncFeed(signal: AbortSignal) {
    const errors: string[] = [];
    const checkouts = new Map<string, CheckoutTarget>();
    for (const row of this.store.db.prepare('SELECT client, body FROM recovery').all())
      for (const target of parseRecovery(row.body, row.client as string).checkouts)
        checkouts.set(target.checkoutId, target);
    const byHost = new Map<string, CheckoutTarget[]>();
    for (const target of checkouts.values())
      byHost.set(target.hostId, [...(byHost.get(target.hostId) ?? []), target]);
    for (const [hostId, targets] of byHost) {
      try {
        await this.syncHostFeed(hostId, targets, signal);
      } catch (error) {
        errors.push('Operation history unavailable: ' + errorText(error));
      }
    }
    return errors;
  }
  private async syncHostFeed(hostId: string, targets: CheckoutTarget[], signal: AbortSignal) {
    const cursor = this.store.get<{ sequence: number }>('cursors', hostId);
    if (!cursor) {
      // Nothing earlier concerns this client: begin at the host's present position.
      const feed = await this.host.listOperations({ checkout: targets[0], after: null }, signal);
      this.store.put('cursors', hostId, { sequence: feed.through });
      return;
    }
    const entries: OperationFeedEntry[] = [];
    let through = Number.POSITIVE_INFINITY;
    for (const checkout of targets) {
      let after = cursor.sequence;
      for (;;) {
        const feed = await this.host.listOperations({ checkout, after }, signal);
        if (feed.floor > cursor.sequence)
          this.store.put('gaps', key(hostId, checkout.checkoutId), {
            since: cursor.sequence,
            checkoutId: checkout.checkoutId,
          });
        entries.push(...feed.operations);
        if (!feed.more) {
          through = Math.min(through, feed.through);
          break;
        }
        after = feed.through;
      }
    }
    if (!Number.isFinite(through) || through <= cursor.sequence) return;
    entries.sort((a, b) => a.sequence - b.sequence);
    for (const entry of entries) {
      if (entry.sequence > through) break;
      // This installation applies its own results as they return.
      if (entry.installationId !== this.installationId) this.applyFeedEntry(entry);
    }
    this.store.put('cursors', hostId, { sequence: through });
  }
  private applyFeedEntry(entry: OperationFeedEntry) {
    const id = key(entry.clientId, entry.id);
    const existing = this.getOperation(id);
    if (existing && !existing.remote) return;
    const record: OperationRecord = existing ?? {
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
      publicationRevisions: this.getPublicationRevisions(entry.checkout),
      acknowledgedBy: [],
    };
    const known = new Set(record.result.items.map((item) => canonical(item)));
    record.result.items = [
      ...record.result.items,
      ...entry.items.filter((item) => !known.has(canonical(item))),
    ];
    try {
      this.publishOperation(id, record);
    } catch (error) {
      this.retainPublication(id, record, error);
    }
  }

  async loadRecovery(clientId: string, signal: AbortSignal) {
    identifier(clientId);
    const before = this.store.readRecovery(clientId);
    if (before) recovery(before.state as EditorRecovery, clientId);
    const errors: string[] = await this.syncFeed(signal);
    await this.recoverEvidence(
      signal,
      new Set((before?.state as EditorRecovery | undefined)?.openCheckoutIds ?? []),
    );
    const stored = this.store.readRecovery(clientId),
      state = (stored?.state ?? emptyRecovery(clientId)) as EditorRecovery;
    recovery(state, clientId);
    for (const target of state.checkouts.filter((c) =>
      state.openCheckoutIds.includes(c.checkoutId),
    )) {
      try {
        await this.host.verifyCheckout(target, signal);
      } catch (error) {
        errors.push(target.root + ': ' + errorText(error));
      }
    }
    const relevant = this.getOperations(
      "NOT EXISTS (SELECT 1 FROM json_each(body, '$.acknowledgedBy') WHERE value = ?) AND (json_extract(body, '$.input.clientId') = ? OR json_extract(body, '$.input.checkout.checkoutId') IN (SELECT value FROM json_each(?)))",
      [clientId, clientId, JSON.stringify(state.checkouts.map((c) => c.checkoutId))],
    ).filter(
      (r) =>
        !r.acknowledgedBy.includes(clientId) &&
        (r.input.clientId === clientId || state.checkouts.some((c) => same(c, r.input.checkout))),
    );
    for (const record of relevant)
      if (record.publicationRevisions[clientId] === undefined) {
        record.publicationRevisions[clientId] = stored?.revision ?? 0;
        this.store.put('operations', key(record.input.clientId, record.input.id), record);
      }
    const operations = relevant.map((r) => r.result);
    for (const record of relevant)
      if (record.publicationError) errors.push(record.publicationError);
    for (const operation of operations)
      if (operation.outcome === 'uncertain')
        errors.push(
          'Uncertain operation ' +
            operation.id +
            ': ' +
            (operation.message ??
              'inspect original, destination, staging and Finder Trash; drafts retained.'),
        );
    for (const record of this.getSaveRecords(clientId))
      if (
        record.input.clientId === clientId &&
        ((!record.result && !record.notStarted) ||
          (record.restorePending && !record.recoveryRestored))
      ) {
        errors.push(
          (record.result ? 'Save restoration pending ' : 'Uncertain save ') +
            record.input.requestId +
            ' for ' +
            record.input.target.path +
            ': inspect disk; journal text retained.' +
            (record.message ? ' ' + record.message : '') +
            (record.recoveryPublication === undefined
              ? ' Earlier Save ordering is unknown: no command-start publication fence. Keep the published draft and inspect retained journal text before deliberate reconciliation.'
              : ''),
        );
      }
    errors.push(...this.getFeedGapErrors(state));
    return { revision: stored?.revision ?? 0, state, errors, operations };
  }
  /** A gap's mark stays while any local recovery still holds a draft in its checkout. */
  private getFeedGapErrors(state: EditorRecovery) {
    const errors: string[] = [];
    for (const row of this.store.db
      .prepare("SELECT key, body FROM records WHERE bucket='gaps'")
      .all()) {
      const gap = this.store.parse<{ since: number; checkoutId: string }>('gaps', row.body);
      const holders = [...this.store.db.prepare('SELECT client, body FROM recovery').all()].filter(
        (r) =>
          parseRecovery(r.body, r.client as string).drafts.some(
            (d) => d.target.checkout.checkoutId === gap.checkoutId,
          ),
      );
      if (!holders.length) this.store.delete('gaps', row.key as string);
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
