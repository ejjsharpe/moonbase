import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import { DaemonLockError } from './daemon-errors.ts';
import { preparePrivateFile } from './private-files.ts';

/** Why opening the lock failed: another daemon holds it, its file holds something else, or else. */
const lockProblem = (error: unknown): DaemonLockError['problem'] => {
  const code = (error as { errcode?: unknown } | undefined)?.errcode;
  const message = String((error as Error | undefined)?.message);
  // SQLITE_BUSY or SQLITE_LOCKED: another process holds the lock.
  if (code === 5 || code === 6 || /locked|busy/i.test(message)) return 'held';
  // SQLITE_NOTADB: the lock file holds something else, which only its owner can clear up.
  if (code === 26 || /not a database/i.test(message)) return 'damaged';
  return 'failed';
};

/** Bun finalizes a connection it can no longer reach, which would drop the lock early. */
const heldLocks = new Set<DatabaseSync>();

/**
 * Holds `daemon.lock`, one daemon per data directory, until the scope closes. SQLite's exclusive
 * locking mode holds an operating-system file lock for as long as the connection is open, and the
 * system drops it when the process dies, so a crash never leaves a stale lock behind.
 */
export const acquireDaemonLock = (directory: string) =>
  Effect.gen(function* () {
    const path = join(directory, 'daemon.lock');
    // SQLite follows symlinks and keeps the mode it finds, so the file is made and checked first.
    yield* preparePrivateFile(path);
    yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          let database: DatabaseSync | undefined;
          try {
            database = new DatabaseSync(path, { timeout: 0 });
            database.exec('PRAGMA locking_mode=EXCLUSIVE');
            database.exec('PRAGMA journal_mode=MEMORY');
            // The first write takes the exclusive lock, which exclusive locking mode keeps.
            database.exec(
              'BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS daemon (pid INTEGER); COMMIT',
            );
          } catch (error) {
            try {
              database?.close();
            } catch {}
            throw error;
          }
          heldLocks.add(database);
          return database;
        },
        catch: (error) => new DaemonLockError({ problem: lockProblem(error) }),
      }),
      (database) =>
        Effect.sync(() => {
          if (heldLocks.delete(database)) database.close();
        }),
    );
  });
