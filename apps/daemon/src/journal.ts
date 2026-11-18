import { closeSync, constants, fstatSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Logger } from 'effect';
import { DataDirectoryError } from './daemon-errors.ts';
import { isPrivate, openPrivateDirectory } from './private-files.ts';

/** Only these fields reach the journal, so no token, credential, request body or chat text can. */
export type JournalRecord = {
  event: string;
  mode?: 'local' | 'host';
  pid?: number;
  version?: string;
  port?: number;
  reason?: string;
  error?: string;
  message?: string;
};
const fields = ['event', 'mode', 'pid', 'version', 'port', 'reason', 'error', 'message'] as const;

/** A journal entry as it is logged: anything else logged never reaches the journal. */
class JournalEntry {
  constructor(readonly record: JournalRecord) {}
}

/** Writes one record to the daemon's journal, when its `DaemonJournal` logger is installed. */
export const journal = (record: JournalRecord) => Effect.log(new JournalEntry(record));

/** One journal line: the time, then the record's own fields, in order. */
const formatLine = (record: JournalRecord, date: Date) => {
  const kept: Record<string, unknown> = { time: date.toISOString() };
  for (const field of fields) if (record[field] !== undefined) kept[field] = record[field];
  return Buffer.from(JSON.stringify(kept) + '\n');
};

/**
 * The daemon's journal: a logger that appends each `journal` record to `logs/daemon.log` as a JSON
 * line, and drops anything else logged. Past `maxBytes` the file rotates to `daemon.1.log` and
 * older files shift up to `daemon.<keep>.log`, so the logs stay within `(keep + 1) * maxBytes`.
 * The file is opened without following a link and must be private; writing never fails the
 * daemon, and a line that can't be written is skipped. The file closes with the layer.
 */
export const DaemonJournal = (
  directory: string,
  { maxBytes = 1024 * 1024, keep = 3 }: { maxBytes?: number; keep?: number } = {},
) =>
  Logger.layer([
    Effect.gen(function* () {
      const folder = yield* openPrivateDirectory(join(directory, 'logs'));
      const path = join(folder, 'daemon.log');
      const rotated = (index: number) => join(folder, `daemon.${index}.log`);
      // Logging is synchronous, so the file is written with `node:fs` calls that are too.
      const file = { descriptor: undefined as number | undefined, size: 0 };
      const openFile = () => {
        let opened: number;
        try {
          opened = openSync(
            path,
            constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
            0o600,
          );
        } catch {
          throw new DataDirectoryError({ problem: 'unsafe' });
        }
        const info = fstatSync(opened);
        if (!info.isFile() || !isPrivate(info)) {
          closeSync(opened);
          throw new DataDirectoryError({ problem: 'unsafe' });
        }
        file.descriptor = opened;
        file.size = info.size;
      };
      const closeFile = () => {
        if (file.descriptor === undefined) return;
        closeSync(file.descriptor);
        file.descriptor = undefined;
      };
      const rotate = () => {
        closeFile();
        for (let index = keep - 1; index >= 1; index--)
          try {
            renameSync(rotated(index), rotated(index + 1));
          } catch {}
        try {
          renameSync(path, rotated(1));
        } catch {}
        openFile();
      };
      yield* Effect.acquireRelease(
        Effect.try({
          try: openFile,
          catch: (error) =>
            error instanceof DataDirectoryError
              ? error
              : new DataDirectoryError({ problem: 'unsafe' }),
        }),
        () => Effect.sync(closeFile),
      );
      return Logger.make(({ message, date }) => {
        for (const entry of Array.isArray(message) ? message : [message]) {
          if (!(entry instanceof JournalEntry)) continue;
          const line = formatLine(entry.record, date);
          try {
            if (file.size + line.length > maxBytes && file.size > 0) rotate();
            if (file.descriptor === undefined) return;
            writeSync(file.descriptor, line);
            file.size += line.length;
          } catch {}
        }
      });
    }),
  ]);
