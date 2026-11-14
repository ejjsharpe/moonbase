import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import {
  ApplicationError,
  type CommandInput,
  type EditorRecovery,
  type FileDocument,
  type RecoveryPublication,
} from '@moonbase/contracts/workspace';
import { normalizeApplicationError } from '@moonbase/effect';
import { Store } from '../store.ts';
import { canonical, errorText, hash, key, text, textDocument } from '../validation.ts';
import { fail } from '@moonbase/contracts/errors';
import {
  type SaveRecord,
  type StoredSave,
  clientDecoders,
  fromStoredSave,
  ensureStorable,
  parseRecovery,
  savedRevision,
  toStoredSave,
} from './client-schema.ts';
import { invalidStored } from '../store.ts';

// shortcut: settled save and operation records and publication receipts still grow on disk; compact
// them only with proven replay and recovery compatibility. The file host's journal does compact.
/** Saves with something left to do; a partial index keeps settled history out of every read. */
export const pendingSaves = "json_extract(body, '$.state') IN ('sent', 'restored', 'settled')";
/** Operations with something left to do (see `OperationRecord.open`), indexed the same way. */
export const openOperations = "json_extract(body, '$.open') = 1";

type PublicationRecord = { digest: string; receipt: RecoveryPublication };
export type StoredRecovery = {
  client: string;
  revision: number;
  body: string;
  state: EditorRecovery;
};

/** One client's recovery, saves and operations, and publication receipts; the file name is stable. */
export class ClientStore extends Store {
  /** This store's identity to a file host, minted the first time and kept in the store. */
  readonly installationId: string;
  constructor(directory: string, installationId?: string) {
    super(directory, {
      file: 'moonbase-workspace-v1.sqlite',
      applicationId: 1296193363,
      // A save's text and its baseline's, apart from its record (`part` is `text` or `baseline`).
      schema: `CREATE TABLE IF NOT EXISTS recovery (client TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS save_texts (id TEXT NOT NULL, part TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(id, part));
        DROP INDEX IF EXISTS pending_saves_v3;
        CREATE INDEX IF NOT EXISTS pending_saves ON records(bucket) WHERE bucket='saves' AND ${pendingSaves};
        CREATE INDEX IF NOT EXISTS open_operations ON records(bucket) WHERE bucket='operations' AND ${openOperations};`,
      decoders: clientDecoders,
    });
    try {
      const claimed = installationId ?? this.get<string>('meta', 'installation') ?? randomUUID();
      this.claim('installation', claimed, 'Workspace store belongs to a different client.');
      this.installationId = claimed;
    } catch (error) {
      this.close();
      throw error;
    }
  }
  /**
   * The recovery body this store last read or wrote for each client, with its state, so a row
   * that has not changed since is not parsed and checked again. A row changed by anything else,
   * or a write that rolled back, no longer matches its body and is parsed afresh.
   */
  private readonly recoveries = new Map<string, { body: string; state: EditorRecovery }>();
  /** A client's recovery state from its stored body; the caller may change what it gets. */
  private decodeRecovery(client: string, body: unknown) {
    const known = this.recoveries.get(client);
    if (known && known.body === body) return structuredClone(known.state);
    const state = parseRecovery(body, client);
    this.recoveries.set(client, { body: body as string, state: structuredClone(state) });
    return state;
  }
  private writeRecovery(client: string, revision: number, state: EditorRecovery) {
    ensureStorable(state, client);
    const body = JSON.stringify(state);
    this.statement(
      'INSERT INTO recovery VALUES(?,?,?) ON CONFLICT(client) DO UPDATE SET revision=excluded.revision, body=excluded.body',
    ).run(client, revision, body);
    this.recoveries.set(client, { body, state: structuredClone(state) });
  }
  readRecovery(client: string): { revision: number; state: EditorRecovery } | null {
    const row = this.statement('SELECT revision, body FROM recovery WHERE client=?').get(client);
    if (!row) return null;
    const revision = savedRevision(row.revision);
    return { revision, state: this.decodeRecovery(client, row.body) };
  }
  /**
   * Every client's stored recovery, parsed once, split into those that read and those that don't,
   * so one unreadable row is skipped (and reported where it matters) and never stalls the others.
   */
  readRecoveries() {
    const readable: StoredRecovery[] = [];
    const unreadable: { client: string; error: string }[] = [];
    for (const row of this.db.prepare('SELECT client, revision, body FROM recovery').all()) {
      const client = row.client as string;
      try {
        readable.push({
          client,
          revision: savedRevision(row.revision),
          body: row.body as string,
          state: this.decodeRecovery(client, row.body),
        });
      } catch (error) {
        unreadable.push({ client, error: errorText(error) });
      }
    }
    return { readable, unreadable };
  }
  publication(client: string): number {
    return this.get<number>('publications', client) ?? 0;
  }
  recoveryPublication(clientId: string, requestId: string) {
    const record = this.get<PublicationRecord>(
      'recovery-publications',
      hash(canonical([clientId, requestId])),
    );
    if (record) {
      const receipt = record.receipt;
      const row = this.db.prepare('SELECT revision FROM recovery WHERE client=?').get(clientId);
      const currentRevision = row ? savedRevision(row.revision) : -1;
      if (
        receipt.clientId !== clientId ||
        receipt.requestId !== requestId ||
        !Number.isSafeInteger(receipt.previousRevision) ||
        !Number.isSafeInteger(receipt.revision) ||
        receipt.revision !== receipt.previousRevision + 1 ||
        !Number.isSafeInteger(currentRevision) ||
        receipt.revision > currentRevision
      )
        throw invalidStored();
    }
    return record;
  }
  replayPublication(
    input: CommandInput<'persistRecovery'>,
    digest: string,
  ): RecoveryPublication | null {
    const previous = this.recoveryPublication(input.clientId, input.requestId);
    if (previous && previous.digest !== digest)
      fail(
        'InvalidInput',
        'Recovery request ID already belongs to a different immutable publication.',
      );
    if (previous && previous.receipt.previousRevision !== input.expectedRevision)
      throw invalidStored();
    return previous?.receipt ?? null;
  }
  /**
   * Writes a state the caller read and checked in the same transaction, advancing the revision
   * without impersonating a client publication.
   */
  writeInternalRecovery(client: string, revision: number, state: EditorRecovery) {
    this.writeRecovery(client, revision + 1, state);
  }
  persist(input: CommandInput<'persistRecovery'>, digest: string): RecoveryPublication {
    return this.transaction(() => {
      const previous = this.replayPublication(input, digest);
      if (previous) return previous;
      const { clientId: client, requestId, expectedRevision: expected, state } = input;
      const revision = this.readRecovery(client)?.revision ?? 0;
      if (revision !== expected)
        fail('Conflict', 'Recovery changed in another window. Reload before publishing.');
      const receipt = {
        clientId: client,
        requestId,
        previousRevision: revision,
        revision: revision + 1,
      };
      this.writeRecovery(client, revision + 1, state);
      this.put('publications', client, revision + 1);
      this.put('recovery-publications', hash(canonical([client, requestId])), { digest, receipt });
      return receipt;
    });
  }
  /**
   * Reserves a save's ID with its record and, in the same transaction, its text and the baseline's
   * when the recovery does not hold it, each written once; returns what already holds the ID.
   * Later changes rewrite only the small record.
   */
  reserveSave(id: string, record: SaveRecord): SaveRecord | null {
    let reserved: boolean;
    try {
      reserved = this.transaction(() => {
        const inserted = this.statement(
          'INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,key) DO NOTHING',
        ).run('saves', id, JSON.stringify(toStoredSave(record)));
        if (Number(inserted.changes) === 0) return false;
        const write = this.statement('INSERT OR REPLACE INTO save_texts VALUES(?,?,?)');
        write.run(id, 'text', record.input.text);
        if (record.baseline.text !== undefined) write.run(id, 'baseline', record.baseline.text);
        return true;
      });
    } catch (error) {
      throw new ApplicationError({
        code: 'Persistence',
        message:
          'Workspace request reservation failed; no mutation admitted. ' +
          normalizeApplicationError(error).message,
      });
    }
    return reserved ? null : this.readSave(id);
  }
  /** A save's record with its text, and its baseline's while the save keeps it. */
  readSave(id: string): SaveRecord | null {
    const stored = this.get<StoredSave>('saves', id);
    return stored && this.withText(id, stored);
  }
  /** The saves whose records match `predicate` (over `body`), with their texts. */
  readSaves(predicate: string, parameters: SQLInputValue[] = []): SaveRecord[] {
    return this.all<StoredSave>('saves', predicate, parameters).map((stored) =>
      this.withText(key(stored.request.clientId, stored.request.requestId), stored),
    );
  }
  private withText(id: string, stored: StoredSave) {
    const parts = new Map(
      this.statement('SELECT part, text FROM save_texts WHERE id=?')
        .all(id)
        .map((row) => [row.part, row.text]),
    );
    const input = parts.get('text'),
      baseline = parts.get('baseline') as string | undefined;
    try {
      text(input);
      if (baseline !== undefined && textDocument(baseline).version !== stored.baseline)
        throw Error();
    } catch {
      throw invalidStored();
    }
    return fromStoredSave(stored, input, baseline);
  }
  /**
   * Writes a save's changed record (never its text). A save that is no longer `sent` will not
   * restore its text, so its baseline's text goes.
   */
  writeSave(id: string, record: SaveRecord) {
    this.put('saves', id, toStoredSave(record));
    if (record.state !== 'sent')
      this.write("DELETE FROM save_texts WHERE id=? AND part='baseline'", [id]);
  }
  /**
   * Keeps `disk` as the baseline's text of the client's `sent` saves that began from it and kept
   * only its version (it was a draft's baseline), but not of `except`: a publication is about to
   * replace it in the recovery, which would then no longer hold it for their restoration.
   */
  keepBaseline(client: string, disk: FileDocument, except: string[]) {
    const saves = this.statement(
      `SELECT key FROM records WHERE bucket='saves' AND ${pendingSaves} AND json_extract(body, '$.state')='sent' AND json_extract(body, '$.request.clientId')=? AND json_extract(body, '$.baseline')=? AND key NOT IN (SELECT value FROM json_each(?))`,
    ).all(client, disk.version, JSON.stringify(except));
    for (const { key: id } of saves)
      this.write("INSERT OR IGNORE INTO save_texts VALUES(?, 'baseline', ?)", [
        id as string,
        disk.text,
      ]);
  }
  /** Marks a settled save as acknowledged by the host. */
  markSaveDone(id: string) {
    this.write(
      "UPDATE records SET body=json_set(body, '$.state', 'done') WHERE bucket='saves' AND key=? AND json_extract(body, '$.state')='settled'",
      [id],
    );
  }
  deleteSave(id: string) {
    this.transaction(() => {
      this.delete('saves', id);
      this.write('DELETE FROM save_texts WHERE id=?', [id]);
    });
  }
}
