import { randomUUID } from 'node:crypto';
import { Cause, Effect } from 'effect';
import type {
  CheckoutTarget,
  CommandInput,
  FileDocument,
  SaveResult,
} from '@moonbase/contracts/workspace';
import { emptyRecoveryState, type RecoveryState } from '@moonbase/contracts/recovery';
import type { SaveStatus } from '@moonbase/contracts/workspace-host';
import {
  InvalidRecoveryRequestError,
  RecoveryConflictError,
  RecoveryPublicationError,
  SaveNotSentError,
} from '@moonbase/contracts/workspace-errors';
import { WorkspaceConflictError } from '@moonbase/contracts/workspace-host-errors';
import { UncertainError } from '@moonbase/contracts/errors';
import { attempt, type WorkspaceFailure } from '../attempt.ts';
import { errorText, hash, same } from '../validation.ts';
import { fromStoredSave, toStoredSave, type SaveRecord, type StoredSave } from './client-schema.ts';
import { followRestoredCheckouts } from './feed-sync.ts';
import { saveKey, unresolvedSaves, type RecoveryContext } from './recovery-context.ts';

/**
 * The text a save began from: kept with the save when it was read from the host, else a draft's
 * baseline in the recovery, which holds it while no publication came after the save began (only
 * then is a save restored). Internal writes move and copy drafts but keep their baseline, and
 * versions are content hashes, so any draft's baseline with that version is the same text.
 */
function findBaseline(
  state: RecoveryState,
  target: { checkout: CheckoutTarget; path: string },
  baseline: SaveRecord['baseline'],
) {
  if (baseline.text !== undefined) return { text: baseline.text, version: baseline.version };
  const drafted = state.buffers.filter((b) => b.draft?.disk.version === baseline.version);
  const disk = (drafted.find((b) => same(b.target, target)) ?? drafted[0])?.draft?.disk;
  return disk && { ...disk };
}

/**
 * The text a draft held when the save began: the draft's recorded baseline, which the recovery
 * already holds (so only its version is given), else the file on the host.
 */
export const getBaseline = (
  context: RecoveryContext,
  input: CommandInput<'saveFile'>,
): Effect.Effect<SaveRecord['baseline'], WorkspaceFailure> =>
  Effect.gen(function* () {
    const draft = (yield* attempt(() =>
      context.store.readRecovery(input.clientId),
    ))?.state.buffers.find((b) => same(b.target, input.target))?.draft;
    if (draft && draft.disk.version === input.expectedVersion)
      return { version: draft.disk.version };
    return yield* context.host.readFile(input.target);
  });

/** Takes a host's save status into the record; returns whether it is an outcome. */
export function applySaveStatus(record: SaveRecord, status: SaveStatus, notStarted: Set<string>) {
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

/**
 * Answers a repeated save request. One whose outcome is not yet recorded is asked of the host,
 * and an outcome it reports is applied as a load would; it is never sent again.
 */
export const replaySave = (
  context: RecoveryContext,
  id: string,
  input: CommandInput<'saveFile'>,
  record: SaveRecord,
): Effect.Effect<SaveResult, WorkspaceFailure> =>
  Effect.gen(function* () {
    if (!same(record.input, input))
      return yield* new WorkspaceConflictError({ conflict: 'save-payload' });
    if ((record.state === 'sent' || record.state === 'restored') && !context.activeSaves.has(id)) {
      const notStarted = new Set<string>();
      const status = yield* Effect.option(
        context.host.saveStatus({ clientId: input.clientId, requestId: input.requestId }),
      );
      if (status._tag === 'Some' && applySaveStatus(record, status.value, notStarted)) {
        // A save whose text did not reach the disk has its text restored with its whole group.
        const restore = record.result?.kind !== 'saved';
        if (restore) yield* followRestoredCheckouts(context, [record]);
        const published = yield* Effect.exit(publishSaves(context, [record], restore, notStarted));
        if (published._tag === 'Failure') {
          const failure = errorText(Cause.squash(published.cause));
          if (record.result?.kind !== 'saved')
            return yield* new RecoveryPublicationError({ pending: 'save', detail: failure });
          yield* acknowledgeSaves(context, []);
          return {
            ...record.result,
            persistencePending: true,
            message: 'Saved to disk; recovery publication pending. ' + failure,
          };
        }
        yield* acknowledgeSaves(context, [record]);
      }
    }
    if (record.result) return record.result;
    if (record.state === 'done') return yield* new SaveNotSentError();
    return yield* new UncertainError({ operation: 'Save', target: input.target });
  });

/** Tells the host settled saves need no more replay; a failure is retried at the next load. */
export const acknowledgeSaves = (
  context: RecoveryContext,
  records: { state: SaveRecord['state']; input: { clientId: string; requestId: string } }[],
) =>
  Effect.forEach(
    records.filter((record) => record.state === 'settled'),
    (record) =>
      context.host
        .acknowledgeSave({ clientId: record.input.clientId, requestId: record.input.requestId })
        .pipe(
          Effect.andThen(attempt(() => context.store.markSaveDone(saveKey(record.input)))),
          Effect.map(() => {
            record.state = 'done';
          }),
          // The host keeps the entry until the next acknowledgement.
          Effect.ignore,
        ),
    { concurrency: 8, discard: true },
  );

/**
 * Applies saves' outcomes to the client's recovery in one transaction. When restoring, the text
 * of every save whose text did not reach the disk is put back as a draft over its baseline, for
 * the client's whole group of unresolved saves at once, but only while no client publication
 * came after the save began (a later one is the client's own newer word). `notStarted` names
 * saves the host never admitted.
 */
export const publishSaves = (
  context: RecoveryContext,
  records: SaveRecord[],
  restore = false,
  notStarted: ReadonlySet<string> = new Set(),
): Effect.Effect<void, WorkspaceFailure> => {
  if (!records.length) return Effect.void;
  const clientId = records[0].input.clientId;
  if (!records.every((record) => record.input.clientId === clientId))
    return Effect.fail(new InvalidRecoveryRequestError({ problem: 'save-group' }));
  const { store } = context;
  return store
    .transaction(() => {
      if (restore) {
        const group = new Map(
          store
            .readSaves(unresolvedSaves + " AND json_extract(body, '$.request.clientId') = ?", [
              clientId,
            ])
            .map((r) => [saveKey(r.input), r]),
        );
        for (const record of records) group.set(saveKey(record.input), record);
        if ([...group.keys()].some((id) => context.activeSaves.has(id)))
          throw new RecoveryPublicationError({ pending: 'save-running' });
        records = [...group.values()];
      }
      const stored = store.readRecovery(clientId),
        revision = stored?.revision ?? 0,
        publication = store.publication(clientId),
        state = stored?.state ?? emptyRecoveryState(clientId);
      let changed = false;
      // Baselines this publication replaces in drafts, which a save may still have begun from.
      const replaced: FileDocument[] = [];
      const updates = records.map((record) => {
        const id = saveKey(record.input),
          committed = store.get<StoredSave>('saves', id);
        if (!committed || !same(committed.request, toStoredSave(record).request))
          throw new RecoveryConflictError({ conflict: 'save-identity' });
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
          if (!disk) throw new RecoveryPublicationError({ pending: 'baseline-missing' });
          if (!state.checkouts.some((c) => same(c, record.input.target.checkout))) {
            state.checkouts.push(record.input.target.checkout);
            drafted = true;
          }
          // The buffer open at the save's path takes the text back; one is opened if none is.
          let buffer = state.buffers.find((b) => same(b.target, record.input.target));
          if (!buffer)
            state.buffers.push((buffer = { id: randomUUID(), target: record.input.target }));
          const existing = buffer.draft;
          if (!existing) {
            buffer.draft = { text: record.input.text, disk };
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
          for (const { target, draft } of state.buffers)
            if (
              draft &&
              same(target, record.input.target) &&
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
      if (changed) store.writeInternalRecovery(clientId, revision, state);
      const settling = updates.filter((u) => u.updated.state !== 'sent').map((u) => u.id);
      for (const disk of replaced) store.keepBaseline(clientId, disk, settling);
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
          store.writeSave(entry.id, entry.updated);
      }
      return updates;
    })
    .pipe(
      // Only a committed publication changes the records the caller holds.
      Effect.map((updates) => {
        for (const { record, updated } of updates) Object.assign(record, updated);
      }),
    );
};
