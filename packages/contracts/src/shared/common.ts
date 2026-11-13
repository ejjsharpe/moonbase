import { fail } from '../errors/schema.ts';

export type ObservationClose = () => Promise<void>;
export type CommandOptions = { signal?: AbortSignal };

/** Reads a plain object, rejecting arrays and, when `keys` is given, any other field. */
export function readObject(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('InvalidInput', 'Expected an object.');
  const record = value as Record<string, unknown>;
  if (keys && Object.keys(record).some((key) => !keys.includes(key)))
    fail('InvalidInput', 'Unexpected fields.');
  return record;
}

/**
 * Compares plain decoded data (objects, arrays, finite primitives) structurally; key order is
 * ignored and `undefined`-valued keys count as absent. Not for class instances, Dates, NaN or
 * cyclic values.
 */
export function areJsonValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!areJsonValuesEqual(a[i], b[i])) return false;
    return true;
  }
  const first = a as Record<string, unknown>,
    second = b as Record<string, unknown>;
  let count = 0;
  for (const key in first) {
    if (!Object.hasOwn(first, key) || first[key] === undefined) continue;
    if (!Object.hasOwn(second, key) || !areJsonValuesEqual(first[key], second[key])) return false;
    count++;
  }
  for (const key in second)
    if (Object.hasOwn(second, key) && second[key] !== undefined && --count < 0) return false;
  return count === 0;
}

/**
 * Serializes plain decoded data with object keys sorted, so values that `areJsonValuesEqual`
 * considers equal get the same key (for Map/Set keys and identities).
 */
export const getJsonKey = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, (item as Record<string, unknown>)[key]]),
        )
      : item,
  );
