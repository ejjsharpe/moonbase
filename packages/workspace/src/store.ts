import { Effect, Exit, Schema } from 'effect';
import { O_NOFOLLOW_ANY } from './filesystem.ts';
import { attempt, type WorkspaceFailure } from './attempt.ts';
import { asSystemFailure, type SystemFailure } from './system-failures.ts';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { chmodSync, constants, closeSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  InvalidRequestError,
  WorkspaceStoreError,
} from '@moonbase/contracts/workspace-host-errors';
import { errorText } from './validation.ts';

/** Per bucket, the decoder of a stored record's JSON body (see `strictDecoders`). */
export type Decoders = Record<string, (body: unknown) => Exit.Exit<unknown, unknown>>;
export const invalidStored = () => new WorkspaceStoreError({ failure: 'invalid-data' });
/** What a store read or write fails with: the store's own error, or SQLite's as a system failure. */
export type StoreFailure = WorkspaceStoreError | SystemFailure;
const isStoreError = Schema.is(WorkspaceStoreError);
const asStoreFailure = (error: unknown): StoreFailure =>
  isStoreError(error) ? error : asSystemFailure(error);

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
  /**
   * Binds the store to one identity the first time and refuses any other afterwards. Returns the
   * identity it holds; one that holds none takes `value`, or a new one when `value` is undefined.
   */
  claim<E>(
    key: string,
    value: string | undefined,
    refusal: E,
  ): Effect.Effect<string, E | StoreFailure> {
    return this.step(() => {
      const identity = this.get<string>('meta', key);
      if (identity) return identity;
      const claimed = value ?? randomUUID();
      this.put('meta', key, claimed);
      return claimed;
    }).pipe(
      Effect.flatMap((identity) =>
        value !== undefined && identity !== value ? Effect.fail(refusal) : Effect.succeed(identity),
      ),
    );
  }
  /** A stored record's body, decoded by its bucket's decoder; anything else is invalid data. */
  parse<T>(bucket: string, body: unknown): T {
    const decoded = Object.hasOwn(this.decoders, bucket) ? this.decoders[bucket](body) : undefined;
    if (decoded === undefined || Exit.isFailure(decoded)) throw invalidStored();
    return decoded.value as T;
  }
  /**
   * Runs one synchronous step of reads and writes on the store, with no transaction. Nothing
   * else on this connection runs inside it. `work` calls only the store's own methods, so it
   * fails with the store's error, or SQLite's as a system failure.
   */
  step<A>(work: () => A): Effect.Effect<A, StoreFailure> {
    return Effect.try({ try: work, catch: asStoreFailure });
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
