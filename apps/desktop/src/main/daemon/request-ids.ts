import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Request IDs of host operations whose outcome is unknown, kept across reloads and restarts until
 * the caller learns the outcome and deletes them.
 */
export type RequestIds = {
  get(key: string): string | undefined;
  put(key: string, requestId: string): void;
  delete(key: string): void;
};

/** A small profile-local file, rewritten whole and atomically; it holds only unresolved requests. */
export function createFileRequestIds(file: string): RequestIds {
  const read = (): Record<string, string> => {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    } catch {
      return {};
    }
  };
  const write = (ids: Record<string, string>) => {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(ids), { mode: 0o600 });
    renameSync(temporary, file);
  };
  return {
    get: (key) => read()[key],
    put: (key, requestId) => {
      const ids = read();
      if (ids[key] === requestId) return;
      write({ ...ids, [key]: requestId });
    },
    delete: (key) => {
      const ids = read();
      if (!(key in ids)) return;
      delete ids[key];
      write(ids);
    },
  };
}
