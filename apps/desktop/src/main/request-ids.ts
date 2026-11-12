import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How long a request ID is kept for a repeat; the host remembers an outcome for much longer. */
export const requestIdLifetimeMs = 10 * 60_000;

/** Request IDs of host operations whose outcome is unknown, kept across reloads and restarts. */
export type RequestIds = {
  /** The ID kept for the key, unless it is older than `requestIdLifetimeMs`. */
  get(key: string): string | undefined;
  put(key: string, requestId: string): void;
  delete(key: string): void;
};

type Entry = { requestId: string; at: number };

/** An entry from the future (the clock moved back) is expired too. */
const isLive = (entry: Entry, now: number) => {
  const age = now - entry.at;
  return age >= 0 && age < requestIdLifetimeMs;
};

export function createMemoryRequestIds(now: () => number = Date.now): RequestIds {
  const ids = new Map<string, Entry>();
  return {
    get: (key) => {
      const entry = ids.get(key);
      if (entry && !isLive(entry, now())) ids.delete(key);
      return ids.get(key)?.requestId;
    },
    put: (key, requestId) => {
      // Reusing an ID leaves its window where it started.
      if (ids.get(key)?.requestId !== requestId) ids.set(key, { requestId, at: now() });
    },
    delete: (key) => void ids.delete(key),
  };
}

/** A small profile-local file, rewritten whole and atomically; it holds only unresolved requests. */
export function createFileRequestIds(file: string, now: () => number = Date.now): RequestIds {
  const read = (): Record<string, Entry> => {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, Entry] =>
            typeof entry[1]?.requestId === 'string' &&
            typeof entry[1]?.at === 'number' &&
            isLive(entry[1], now()),
        ),
      );
    } catch {
      return {};
    }
  };
  const write = (ids: Record<string, Entry>) => {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(ids), { mode: 0o600 });
    renameSync(temporary, file);
  };
  return {
    get: (key) => read()[key]?.requestId,
    put: (key, requestId) => {
      const ids = read();
      if (ids[key]?.requestId === requestId) return;
      write({ ...ids, [key]: { requestId, at: now() } });
    },
    delete: (key) => {
      const ids = read();
      if (!(key in ids)) return;
      delete ids[key];
      write(ids);
    },
  };
}
