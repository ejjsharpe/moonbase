import { Equal } from 'effect';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/**
 * `next`, sharing what equals `previous`: `previous` itself when the two are equal, else, for a
 * plain object, each field that is. A change that copied a value keeps the identity of what it
 * left as it was, so atoms reading that part notify no one.
 */
export function shareEqual<A>(previous: A, next: A): A {
  if (Equal.equals(previous, next)) return previous;
  if (!isPlainObject(previous) || !isPlainObject(next)) return next;
  const shared: Record<string, unknown> = { ...next };
  for (const key of Object.keys(next))
    if (Object.prototype.hasOwnProperty.call(previous, key))
      shared[key] = shareEqual(previous[key], next[key]);
  return shared as A;
}
