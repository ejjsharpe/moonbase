import { createHash } from 'node:crypto';

/** The SHA-256 hex digest of a value's JSON, used to bind cursors and compare sources. */
export const hashJson = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
