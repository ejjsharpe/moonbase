import { DatabaseSync } from 'node:sqlite';
import { chmodSync, constants, closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ensure, fail } from './validation.ts';
import { ApplicationError } from '@moonbase/application/client';

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
      ensure(application === 1296193363 || (application === 0 && tables.length === 0), 'This is not a Moonbase workspace store. Existing data retained.');
      this.db.exec('PRAGMA application_id=1296193363; CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bucket,key)); CREATE TABLE IF NOT EXISTS recovery (client TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);');
      chmodSync(file, 0o600);
      const identity = this.get<string>('meta', 'host');
      ensure(!identity || identity === hostId, 'Workspace store belongs to a different host.');
      if (!identity) this.put('meta', 'host', hostId);
    } catch (error) { this.db.close(); throw error; }
  }
  get<T>(bucket: string, key: string): T | null {
    const row = this.db.prepare('SELECT body FROM records WHERE bucket=? AND key=?').get(bucket, key);
    return row ? JSON.parse(row.body as string) as T : null;
  }
  all<T>(bucket: string): T[] { return this.db.prepare('SELECT body FROM records WHERE bucket=? ORDER BY rowid').all(bucket).map(r => JSON.parse(r.body as string) as T); }
  put(bucket: string, key: string, value: unknown) {
    try { this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET body=excluded.body').run(bucket, key, JSON.stringify(value)); }
    catch (error) { throw new ApplicationError({code: 'Persistence', message: 'Workspace journal publication failed; retain drafts and retry. ' + ApplicationError.fromUnknown(error).message}); }
  }
  reserve<T>(bucket: string, key: string, value: T): T | null {
    try {
      const result = this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,key) DO NOTHING').run(bucket, key, JSON.stringify(value));
      return Number(result.changes) === 0 ? this.get<T>(bucket, key) : null;
    } catch (error) { throw new ApplicationError({code: 'Persistence', message: 'Workspace request reservation failed; no mutation admitted. ' + ApplicationError.fromUnknown(error).message}); }
  }
  readRecovery(client: string): { revision: number; state: unknown } | null {
    const row = this.db.prepare('SELECT revision, body FROM recovery WHERE client=?').get(client);
    return row ? { revision: Number(row.revision), state: JSON.parse(row.body as string) } : null;
  }
  persist(client: string, expected: number, state: unknown) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const revision = this.readRecovery(client)?.revision ?? 0;
      if (revision !== expected) fail('Conflict', 'Recovery changed in another window. Reload before publishing.');
      this.db.prepare('INSERT INTO recovery VALUES(?,?,?) ON CONFLICT(client) DO UPDATE SET revision=excluded.revision, body=excluded.body').run(client, revision + 1, JSON.stringify(state));
      this.db.exec('COMMIT'); return revision + 1;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
