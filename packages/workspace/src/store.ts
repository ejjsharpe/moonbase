import type { Effect } from 'effect';
import { O_NOFOLLOW_ANY } from './filesystem.ts';
import { attempt, type WorkspaceFailure } from './attempt.ts';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { chmodSync, constants, closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  InvalidRequestError,
  WorkspaceStoreError,
} from '@moonbase/contracts/workspace-host-errors';
import { errorText } from './validation.ts';

export type Decoders = Record<string, (value: unknown) => unknown>;
export const invalidStored = () => new WorkspaceStoreError({ failure: 'invalid-data' });

/**
 * A private SQLite file of keyed records, each decoded strictly by its bucket. The file host and
 * the client recovery store are separate files built on this.
 */
export class Store {
  readonly directory: string;
  readonly db: DatabaseSync;
  private readonly decoders: Decoders;
  private readonly statements = new Map<string, StatementSync>();
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
    if (!isAbsolute(directory)) throw new InvalidRequestError({ problem: 'data-directory' });
    this.decoders = options.decoders;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.directory = realpathSync(directory);
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY);
    closeSync(fd);
    const file = join(directory, options.file);
    const databaseFile = openSync(
      file,
      constants.O_CREAT | constants.O_RDWR | O_NOFOLLOW_ANY,
      0o600,
    );
    closeSync(databaseFile);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const application = this.db.prepare('PRAGMA application_id').get()!.application_id;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (!(application === options.applicationId || (application === 0 && tables.length === 0)))
        throw new InvalidRequestError({ problem: 'not-a-store' });
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
  claim(key: string, value: string, refusal: Error) {
    const identity = this.get<string>('meta', key);
    if (identity && identity !== value) throw refusal;
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
  /** One prepared statement per SQL text, prepared once. */
  statement(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) this.statements.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }
  get<T>(bucket: string, key: string): T | null {
    const row = this.statement('SELECT body FROM records WHERE bucket=? AND key=?').get(
      bucket,
      key,
    );
    return row ? this.parse<T>(bucket, row.body) : null;
  }
  all<T>(bucket: string, predicate = '1', parameters: SQLInputValue[] = [], limit = -1): T[] {
    return this.statement(
      `SELECT body FROM records WHERE bucket=? AND (${predicate}) ORDER BY rowid LIMIT ?`,
    )
      .all(bucket, ...parameters, limit)
      .map((r) => this.parse<T>(bucket, r.body));
  }
  put(bucket: string, key: string, value: unknown) {
    this.write(
      'INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET body=excluded.body',
      [bucket, key, JSON.stringify(value)],
    );
  }
  /** Runs one write; a failure is `Persistence`. */
  write(sql: string, parameters: SQLInputValue[]) {
    try {
      return this.statement(sql).run(...parameters);
    } catch (error) {
      throw new WorkspaceStoreError({ failure: 'publication', detail: errorText(error) });
    }
  }
  reserve<T>(bucket: string, key: string, value: T): T | null {
    try {
      const result = this.statement(
        'INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,key) DO NOTHING',
      ).run(bucket, key, JSON.stringify(value));
      return Number(result.changes) === 0 ? this.get<T>(bucket, key) : null;
    } catch (error) {
      throw new WorkspaceStoreError({ failure: 'reservation', detail: errorText(error) });
    }
  }
  delete(bucket: string, key: string) {
    this.statement('DELETE FROM records WHERE bucket=? AND key=?').run(bucket, key);
  }
  /**
   * Runs `work` in one write transaction: it commits when `work` returns and rolls back when it
   * throws. The transaction opens, runs and ends in one synchronous step, so no other fiber's
   * work on this connection can run inside it.
   */
  transaction<A>(work: () => A): Effect.Effect<A, WorkspaceFailure> {
    return attempt(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const value = work();
        this.db.exec('COMMIT');
        return value;
      } catch (error) {
        // Nothing is open when `COMMIT` itself failed and SQLite undid it.
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    });
  }
  /** Closes the database; its owner's scope does this once. */
  close() {
    this.db.close();
  }
}
