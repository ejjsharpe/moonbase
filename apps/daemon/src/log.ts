import { closeSync, constants, fstatSync, openSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { openPrivateDirectory, unsafe } from './data-directory.ts';
import { isPrivateTo } from '@moonbase/contracts/files';

/** Only these fields reach the log, so no token, credential, request body or chat text can. */
export type LogRecord = {
  event: string;
  mode?: 'local' | 'host';
  pid?: number;
  version?: string;
  port?: number;
  reason?: string;
  code?: string;
  message?: string;
};
export type DaemonLog = { write(record: LogRecord): void; close(): void };

const fields = ['event', 'mode', 'pid', 'version', 'port', 'reason', 'code', 'message'] as const;

/**
 * Appends JSON lines to `logs/daemon.log`. Past `maxBytes` the file rotates to `daemon.1.log`
 * and older files shift up to `daemon.<keep>.log`, so the logs stay within `(keep + 1) * maxBytes`.
 * Writing never fails the daemon; a log that can't be written is skipped.
 */
export async function openDaemonLog(
  directory: string,
  { maxBytes = 1024 * 1024, keep = 3 }: { maxBytes?: number; keep?: number } = {},
): Promise<DaemonLog> {
  const folder = await openPrivateDirectory(join(directory, 'logs'));
  const path = join(folder, 'daemon.log');
  const rotated = (index: number) => join(folder, `daemon.${index}.log`);
  let descriptor: number | undefined,
    size = 0;
  const openFile = () => {
    let opened: number;
    try {
      opened = openSync(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw unsafe();
    }
    const info = fstatSync(opened);
    if (!info.isFile() || !isPrivateTo(info, process.getuid?.())) {
      closeSync(opened);
      throw unsafe();
    }
    descriptor = opened;
    size = info.size;
  };
  const closeFile = () => {
    if (descriptor === undefined) return;
    closeSync(descriptor);
    descriptor = undefined;
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
  openFile();
  return {
    write(record) {
      const kept: Record<string, unknown> = { time: new Date().toISOString() };
      for (const field of fields) if (record[field] !== undefined) kept[field] = record[field];
      const line = Buffer.from(JSON.stringify(kept) + '\n');
      try {
        if (size + line.length > maxBytes && size > 0) rotate();
        if (descriptor === undefined) return;
        writeSync(descriptor, line);
        size += line.length;
      } catch {}
    },
    close: closeFile,
  };
}
