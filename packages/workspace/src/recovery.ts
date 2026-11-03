import { normalizeApplicationError } from '@moonbase/effect';
import {
  type SaveRecordSchema,
  type OperationRecordSchema,
  parseRecovery,
  savedRevision,
} from './schema.ts';
import { type Store, pendingSaves } from './store.ts';
import {
  emptyRecovery,
  type SaveResult,
  type CommandInput,
  type OperationResult,
  type WorkspaceOperation,
  type EditorRecovery,
  type CheckoutTarget,
} from '@moonbase/contracts/workspace';
import {
  identifier,
  canonical,
  same,
  recovery,
  ensure,
  fail,
  textDocument,
  hash,
} from './validation.ts';
import { type Directory } from './filesystem.ts';
import { basename, join } from 'node:path';
export const key = (clientId: string, id: string) => hash(canonical([clientId, id]));
export const affected = (p: string, source: string) => p === source || p.startsWith(source + '/');
export const isOriginalResult = (
  kind: WorkspaceOperation['kind'],
  item: OperationResult['items'][number],
) => kind === 'trash' || item.destination !== undefined;
export const errorText = (error: unknown) => normalizeApplicationError(error).message;
export type SaveRecord = typeof SaveRecordSchema.Type;
export type OperationRecord = typeof OperationRecordSchema.Type;
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
export class WorkspaceRecovery {
  private readonly volatileSaves = new Map<string, SaveRecord>();
  private readonly activeSaves = new Set<string>();
  private readonly volatileOperations = new Map<string, OperationRecord>();
  private readonly store: Store;
  private readonly directory: (target: CheckoutTarget) => Promise<Directory>;
  private readonly isCheckoutActive: (checkoutId: string) => boolean;
  private readonly approveCheckout: (target: CheckoutTarget) => void;
  constructor(
    store: Store,
    directory: (target: CheckoutTarget) => Promise<Directory>,
    isCheckoutActive: (checkoutId: string) => boolean,
    approveCheckout: (target: CheckoutTarget) => void,
  ) {
    this.store = store;
    this.directory = directory;
    this.isCheckoutActive = isCheckoutActive;
    this.approveCheckout = approveCheckout;
  }

  getPublication(clientId: string) {
    return this.store.publication(clientId);
  }
  getRecoveryPublication(input: CommandInput<'getRecoveryPublication'>) {
    identifier(input.clientId);
    identifier(input.requestId);
    return this.store.recoveryPublication(input.clientId, input.requestId)?.receipt ?? null;
  }
  async getOperationStatus(input: CommandInput<'operationStatus'>) {
    identifier(input.clientId);
    identifier(input.id);
    await this.recoverEvidence();
    return this.getOperation(key(input.clientId, input.id))?.result ?? null;
  }
  reserveSave(id: string, record: SaveRecord) {
    return this.store.reserve('saves', id, record);
  }
  startSave(id: string) {
    this.activeSaves.add(id);
  }
  finishSave(id: string) {
    this.activeSaves.delete(id);
  }
  retainSave(id: string, record: SaveRecord) {
    this.volatileSaves.set(id, record);
  }
  reserveOperation(id: string, record: OperationRecord) {
    return this.store.reserve('operations', id, record);
  }
  writeOperation(id: string, record: OperationRecord) {
    this.store.put('operations', id, record);
  }
  retainOperation(id: string, record: OperationRecord) {
    this.volatileOperations.set(id, record);
  }
  getPublicationRevisions(input: WorkspaceOperation) {
    const revisions: Record<string, number> = {
      [input.clientId]: this.store.readRecovery(input.clientId)?.revision ?? 0,
    };
    for (const row of this.store.db.prepare('SELECT client, revision, body FROM recovery').all())
      if (
        parseRecovery(row.body, row.client as string).checkouts.some((c) => same(c, input.checkout))
      )
        revisions[row.client as string] = savedRevision(row.revision);
    return revisions;
  }
  getUnsettledOperations(target: CheckoutTarget, clientId: string) {
    return this.getOperations(
      "json_extract(body, '$.input.checkout.checkoutId') = ? AND (json_extract(body, '$.result.outcome') = 'uncertain' OR NOT EXISTS (SELECT 1 FROM json_each(body, '$.acknowledgedBy') WHERE value = ?))",
      [target.checkoutId, clientId],
    );
  }
  getPendingSaves(target: CheckoutTarget) {
    return this.store.all<SaveRecord>(
      'saves',
      pendingSaves +
        " AND json_extract(body, '$.result') IS NULL AND json_extract(body, '$.input.target.checkout.checkoutId') = ?",
      [target.checkoutId],
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
  replayOperation(id: string, input: WorkspaceOperation, record: OperationRecord) {
    if (!same(record.input, input))
      fail('Conflict', 'Operation ID already belongs to another payload/client/checkout.');
    if (this.volatileOperations.has(id)) {
      try {
        this.publishOperation(id, record);
      } catch (error) {
        this.retainPublication(id, record, error);
      }
    }
    return record.result;
  }

  acknowledgeOperation(input: CommandInput<'acknowledgeOperation'>) {
    identifier(input.clientId);
    identifier(input.operationClientId);
    identifier(input.id);
    const id = key(input.operationClientId, input.id),
      record = this.getOperation(id);
    if (!record || record.acknowledgedBy.includes(input.clientId)) return;
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
  }
  persistRecovery(input: CommandInput<'persistRecovery'>, signal: AbortSignal) {
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
    for (const target of input.state.checkouts) this.approveCheckout(target);
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
  }
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
  publishOperation(id: string, record: OperationRecord) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
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
      if (originals.length !== expected || originals.some((item) => item.outcome === 'uncertain'))
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
        this.store.db.exec('COMMIT');
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
      this.store.db.exec('COMMIT');
      delete record.publicationError;
      Object.assign(record, updated);
      this.volatileOperations.delete(id);
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  publishSaves(records: SaveRecord[], restore = false) {
    if (!records.length) return;
    const clientId = records[0].input.clientId;
    ensure(
      records.every((record) => record.input.clientId === clientId),
      'A Save publication group belongs to one client.',
    );
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
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
            .filter(
              (r) =>
                r.input.clientId === clientId && r.started && (!r.published || r.restorePending),
            )
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
          published: !!result,
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
      this.store.db.exec('COMMIT');
      for (const { id, record, updated } of updates) {
        Object.assign(record, updated);
        this.volatileSaves.delete(id);
      }
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }
  async recoverEvidence(openIds?: Set<string>) {
    const groups = new Map<string, SaveRecord[]>();
    for (const record of this.getSaveRecords()) {
      if (!record.started || (record.published && !record.restorePending)) continue;
      const records = groups.get(record.input.clientId) ?? [];
      records.push(record);
      groups.set(record.input.clientId, records);
    }
    for (const records of groups.values()) {
      if (records.some((record) => this.isCheckoutActive(record.input.target.checkout.checkoutId)))
        continue;
      for (const record of records)
        if (!record.result && (!openIds || openIds.has(record.input.target.checkout.checkoutId))) {
          try {
            const disk = await (
              await this.directory(record.input.target.checkout)
            ).read(record.input.target.path);
            if (disk.version === textDocument(record.input.text).version)
              record.result = { kind: 'saved', disk, recoveryChanges: [] };
            else if (disk.version === record.input.expectedVersion)
              record.result = { kind: 'conflict', disk };
          } catch {
            /* Restore admitted text without guessing an unavailable disk outcome. */
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
    }
    for (const record of this.getOperations(
      `json_extract(body, '$.result.outcome') IS NOT 'completed'
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
      )`,
    )) {
      if (this.isCheckoutActive(record.input.checkout.checkoutId)) continue;
      const items = record.result.items.filter((item) => isOriginalResult(record.input.kind, item));
      if (
        items.length ===
          (record.input.sources.length || record.input.nativeReferences?.length || 1) &&
        items.every((item) => item.outcome !== 'uncertain')
      ) {
        const outcome = items.every((item) => item.outcome === 'completed')
          ? 'completed'
          : 'failed';
        const id = key(record.input.clientId, record.input.id);
        if (
          record.result.outcome !== outcome ||
          record.result.items.some(
            (item) =>
              item.outcome === 'completed' &&
              !(record.publishedItems ?? []).includes(canonical(item)),
          ) ||
          this.volatileOperations.has(id)
        ) {
          record.result.outcome = outcome;
          try {
            this.publishOperation(id, record);
          } catch (error) {
            this.retainPublication(id, record, error);
          }
        }
      }
      if (
        record.result.outcome !== 'uncertain' ||
        this.isCheckoutActive(record.input.checkout.checkoutId)
      )
        continue;
      const kind = record.input.kind;
      if (kind !== 'move' || (openIds && !openIds.has(record.input.checkout.checkoutId))) continue;
      let directory: Directory;
      try {
        directory = await this.directory(record.input.checkout);
      } catch {
        continue;
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
      if (
        record.result.items.length >= record.input.sources.length &&
        !record.result.items.some((i) => i.outcome === 'uncertain')
      )
        record.result.outcome = record.result.items.every((i) => i.outcome === 'completed')
          ? 'completed'
          : 'failed';
      const id = key(record.input.clientId, record.input.id);
      try {
        this.publishOperation(id, record);
      } catch (error) {
        this.retainPublication(id, record, error);
      }
    }
  }

  async loadRecovery(clientId: string) {
    identifier(clientId);
    const before = this.store.readRecovery(clientId);
    if (before) recovery(before.state as EditorRecovery, clientId);
    await this.recoverEvidence(
      new Set((before?.state as EditorRecovery | undefined)?.openCheckoutIds ?? []),
    );
    const stored = this.store.readRecovery(clientId),
      state = (stored?.state ?? emptyRecovery(clientId)) as EditorRecovery;
    recovery(state, clientId);
    const errors: string[] = [];
    for (const target of state.checkouts.filter((c) =>
      state.openCheckoutIds.includes(c.checkoutId),
    )) {
      try {
        await this.directory(target);
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
        (!record.result || (record.restorePending && !record.recoveryRestored))
      ) {
        errors.push(
          (record.result ? 'Save restoration pending ' : 'Uncertain save ') +
            record.input.requestId +
            ' for ' +
            record.input.target.path +
            ': inspect disk and staging ' +
            record.temporary +
            '; journal text retained.' +
            (record.message ? ' ' + record.message : '') +
            (record.recoveryPublication === undefined
              ? ' Earlier Save ordering is unknown: no command-start publication fence. Keep the published draft and inspect retained journal text before deliberate reconciliation.'
              : ''),
        );
      }
    return { revision: stored?.revision ?? 0, state, errors, operations };
  }
}
