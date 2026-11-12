import { normalizeApplicationError } from '@moonbase/effect';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { chmodSync, constants, closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { ensure } from './validation.ts';

export type Decoders = Record<string, (value: unknown) => unknown>;
export const invalidStored = () =>
  new ApplicationError({
    code: 'Persistence',
    message: 'Invalid workspace saved data. Original data retained; publication blocked.',
  });

/**
 * A private SQLite file of keyed records, each decoded strictly by its bucket. The file host and
 * the client recovery store are separate files built on this.
 */
export class Store {
  readonly directory: string;
  readonly db: DatabaseSync;
  private readonly decoders: Decoders;
  constructor(
    directory: string,
    options: {
      file: string;
      applicationId: number;
      /** Extra schema statements, run after the records table exists. */
      schema: string;
      decoders: Decoders;
    },
  ) {
    ensure(isAbsolute(directory), 'Choose an explicit absolute Moonbase workspace data directory.');
    this.decoders = options.decoders;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory);
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    closeSync(fd);
    const file = join(directory, options.file);
    const databaseFile = openSync(file, constants.O_CREAT | constants.O_RDWR | 0x20000000, 0o600);
    closeSync(databaseFile);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const application = this.db.prepare('PRAGMA application_id').get()!.application_id;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      ensure(
        application === options.applicationId || (application === 0 && tables.length === 0),
        'This is not a Moonbase workspace store. Existing data retained.',
      );
      this.db.exec(
        `PRAGMA application_id=${options.applicationId}; CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(bucket,key));` +
          options.schema,
      );
      chmodSync(file, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  /** Binds the store to one identity the first time and refuses any other afterwards. */
  claim(key: string, value: string, message: string) {
    const identity = this.get<string>('meta', key);
    ensure(!identity || identity === value, message);
    if (!identity) this.put('meta', key, value);
  }
  parse<T>(bucket: string, body: unknown): T {
    try {
      if (typeof body !== 'string') throw Error();
      if (!Object.hasOwn(this.decoders, bucket)) throw Error();
      return this.decoders[bucket](JSON.parse(body)) as T;
    } catch {
      throw invalidStored();
    }
  }
  get<T>(bucket: string, key: string): T | null {
    const row = this.db
      .prepare('SELECT body FROM records WHERE bucket=? AND key=?')
      .get(bucket, key);
    return row ? this.parse<T>(bucket, row.body) : null;
  }
  all<T>(bucket: string, predicate = '1', parameters: SQLInputValue[] = [], limit = -1): T[] {
    return this.db
      .prepare(`SELECT body FROM records WHERE bucket=? AND (${predicate}) ORDER BY rowid LIMIT ?`)
      .all(bucket, ...parameters, limit)
      .map((r) => this.parse<T>(bucket, r.body));
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
  delete(bucket: string, key: string) {
    this.db.prepare('DELETE FROM records WHERE bucket=? AND key=?').run(bucket, key);
  }
  /** Runs `fn` in one write transaction; a throw rolls everything back. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
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
