import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Request IDs of host operations whose outcome is unknown, kept across reloads and restarts. */
export type RequestIds = {
  get(key: string): string | undefined;
  put(key: string, requestId: string): void;
  delete(key: string): void;
};

export function createMemoryRequestIds(): RequestIds {
  const ids = new Map<string, string>();
  return {
    get: (key) => ids.get(key),
    put: (key, requestId) => void ids.set(key, requestId),
    delete: (key) => void ids.delete(key),
  };
}

/** A small profile-local file, rewritten whole and atomically; it holds only unresolved requests. */
export function createFileRequestIds(file: string): RequestIds {
  const read = (): Record<string, string> => {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, string>)
        : {};
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
    put: (key, requestId) => write({ ...read(), [key]: requestId }),
    delete: (key) => {
      const ids = read();
      if (!(key in ids)) return;
      delete ids[key];
      write(ids);
    },
  };
}
