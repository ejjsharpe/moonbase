export type ObservationClose = () => Promise<void>;
export type CommandOptions = { signal?: AbortSignal };

/**
 * Compares JSON-shaped values (plain objects, arrays and primitives) by structure, as their JSON
 * encodings would compare: object key order is ignored and `undefined`-valued keys count as absent.
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
    second = b as Record<string, unknown>,
    keys = Object.keys(first).filter((key) => first[key] !== undefined);
  return (
    keys.length === Object.keys(second).filter((key) => second[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(second, key) && areJsonValuesEqual(first[key], second[key]))
  );
}
