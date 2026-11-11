import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { preparePrivateFile } from './data-directory.ts';
import { DaemonFailure } from './failure.ts';

/**
 * Takes `daemon.lock`, one daemon per data directory. SQLite's exclusive locking mode holds an
 * operating-system file lock for as long as the connection is open, and the system drops it when
 * the process dies, so a crash never leaves a stale lock behind.
 */
export async function acquireDaemonLock(directory: string): Promise<{ release(): void }> {
  const path = join(directory, 'daemon.lock');
  // SQLite follows symlinks and keeps the mode it finds, so the file is made and checked first.
  await preparePrivateFile(path);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { timeout: 0 });
    database.exec('PRAGMA locking_mode=EXCLUSIVE');
    database.exec('PRAGMA journal_mode=MEMORY');
    // The first write takes the exclusive lock, which exclusive locking mode keeps.
    database.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS daemon (pid INTEGER); COMMIT');
  } catch (error) {
    try {
      database?.close();
    } catch {}
    const code = (error as { errcode?: unknown } | undefined)?.errcode;
    // SQLITE_BUSY or SQLITE_LOCKED: another process holds the lock.
    const busy = code === 5 || code === 6 || /locked|busy/i.test(String((error as Error)?.message));
    throw busy
      ? new DaemonFailure(
          'Conflict',
          'A Moonbase daemon is already running for this data directory.',
        )
      : new DaemonFailure('Persistence', 'The daemon lock could not be taken.');
  }
  const held = database;
  // Bun finalizes a connection it can no longer reach, which would drop the lock early.
  heldLocks.add(held);
  return {
    release() {
      if (!heldLocks.delete(held)) return;
      held.close();
    },
  };
}
const heldLocks = new Set<DatabaseSync>();
