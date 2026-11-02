import { normalizeApplicationError } from '@moonbase/application/effect-client';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { chmodSync, constants, closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { canonical, ensure, fail, hash } from './validation.ts';
import { invalidStored, parseRecord, parseRecovery } from './schema.ts';
import {
  ApplicationError,
  type CommandInput,
  type RecoveryPublication,
} from '@moonbase/application/client';

// shortcut: immutable receipts still grow on disk; compact only with proven replay and recovery compatibility.
export const pendingSaves =
  "(json_extract(body, '$.result') IS NULL OR json_extract(body, '$.published') IS NOT 1 OR json_extract(body, '$.restorePending') = 1) AND NOT (json_extract(body, '$.started') IS 0 AND json_extract(body, '$.result') IS NOT NULL AND json_extract(body, '$.restorePending') IS NOT 1)";

type PublicationRecord = { digest: string; receipt: RecoveryPublication };

/** Independent editor-only namespace. No legacy schemas, stores or migrations. */
export class Store {
  readonly directory: string;
  readonly db: DatabaseSync;
  constructor(directory: string, hostId: string) {
    ensure(isAbsolute(directory), 'Choose an explicit absolute Moonbase workspace data directory.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory);
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    closeSync(fd);
    const file = join(directory, 'moonbase-workspace-v1.sqlite');
    const databaseFile = openSync(file, constants.O_CREAT | constants.O_RDWR | 0x20000000, 0o600);
    closeSync(databaseFile);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const application = this.db.prepare('PRAGMA application_id').get()!.application_id;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      ensure(
        application === 1296193363 || (application === 0 && tables.length === 0),
        'This is not a Moonbase workspace store. Existing data retained.',
      );
      this.db.exec(
        'PRAGMA application_id=1296193363; CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bucket,key)); CREATE TABLE IF NOT EXISTS recovery (client TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);',
      );
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS pending_saves_v2 ON records(bucket) WHERE bucket='saves' AND ${pendingSaves}; DROP INDEX IF EXISTS pending_saves;`,
      );
      chmodSync(file, 0o600);
      const identity = this.get<string>('meta', 'host');
      ensure(!identity || identity === hostId, 'Workspace store belongs to a different host.');
      if (!identity) this.put('meta', 'host', hostId);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get<T>(bucket: string, key: string): T | null {
    const row = this.db
      .prepare('SELECT body FROM records WHERE bucket=? AND key=?')
      .get(bucket, key);
    return row ? parseRecord<T>(bucket, row.body as string) : null;
  }
  all<T>(bucket: string, predicate = '1', parameters: SQLInputValue[] = []): T[] {
    return this.db
      .prepare(`SELECT body FROM records WHERE bucket=? AND (${predicate}) ORDER BY rowid`)
      .all(bucket, ...parameters)
      .map((r) => parseRecord<T>(bucket, r.body as string));
  }
  put(bucket: string, key: string, value: unknown) {
    try {
      this.get(bucket, key);
      this.db
        .prepare(
          'INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET body=excluded.body',
        )
        .run(bucket, key, JSON.stringify(value));
    } catch (error) {
      throw new ApplicationError({
        code: 'Persistence',
        message:
          'Workspace journal publication failed; retain drafts and retry. ' +
          normalizeApplicationError(error).message,
      });
    }
  }
  reserve<T>(bucket: string, key: string, value: T): T | null {
    try {
      const result = this.db
        .prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,key) DO NOTHING')
        .run(bucket, key, JSON.stringify(value));
      return Number(result.changes) === 0 ? this.get<T>(bucket, key) : null;
    } catch (error) {
      throw new ApplicationError({
        code: 'Persistence',
        message:
          'Workspace request reservation failed; no mutation admitted. ' +
          normalizeApplicationError(error).message,
      });
    }
  }
  readRecovery(client: string): { revision: number; state: unknown } | null {
    const row = this.db.prepare('SELECT revision, body FROM recovery WHERE client=?').get(client);
    if (!row) return null;
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw invalidStored();
    return { revision, state: parseRecovery(row.body as string, client) };
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
      const currentRevision = row ? Number(row.revision) : -1;
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
  /** Caller owns the transaction; module facts advance CAS without impersonating a client publication. */
  writeInternalRecovery(client: string, revision: number, state: unknown) {
    this.readRecovery(client);
    this.db
      .prepare(
        'INSERT INTO recovery VALUES(?,?,?) ON CONFLICT(client) DO UPDATE SET revision=excluded.revision, body=excluded.body',
      )
      .run(client, revision + 1, JSON.stringify(state));
  }
  persist(input: CommandInput<'persistRecovery'>, digest: string): RecoveryPublication {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.replayPublication(input, digest);
      if (previous) {
        this.db.exec('COMMIT');
        return previous;
      }
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
      this.db
        .prepare(
          'INSERT INTO recovery VALUES(?,?,?) ON CONFLICT(client) DO UPDATE SET revision=excluded.revision, body=excluded.body',
        )
        .run(client, revision + 1, JSON.stringify(state));
      this.put('publications', client, revision + 1);
      this.put('recovery-publications', hash(canonical([client, requestId])), { digest, receipt });
      this.db.exec('COMMIT');
      return receipt;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private closed = false;
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
