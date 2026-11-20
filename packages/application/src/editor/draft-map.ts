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

/**
 * A map a change may mutate, whose entries are copied the first time the change reads them, so a
 * change copies only the entries it touches; the rest stay the state's own.
 */
export class DraftMap<K, V> extends Map<K, V> {
  readonly #previous: ReadonlyMap<K, V>;
  readonly #copy: (value: V) => V;
  readonly #touched = new Set<K>();
  constructor(previous: ReadonlyMap<K, V>, copy: (value: V) => V) {
    super();
    this.#previous = previous;
    this.#copy = copy;
    for (const [key, value] of previous) Map.prototype.set.call(this, key, value);
  }
  override get(key: K) {
    const value = super.get(key);
    if (value === undefined || this.#touched.has(key)) return value;
    const copy = this.#copy(value);
    this.set(key, copy);
    return copy;
  }
  override set(key: K, value: V) {
    this.#touched.add(key);
    return super.set(key, value);
  }
  override *entries(): MapIterator<[K, V]> {
    // Copying an entry replaces an existing key, which leaves the iteration as it was.
    for (const key of this.keys()) yield [key, this.get(key)!];
  }
  override *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }
  override [Symbol.iterator]() {
    return this.entries();
  }
  override forEach(f: (value: V, key: K, map: Map<K, V>) => void) {
    for (const [key, value] of this.entries()) f(value, key, this);
  }
  /**
   * The map as state again: an entry the change touched but left equal is the previous one, and a
   * map the change left as it was is the previous map.
   */
  settle(): Map<K, V> {
    const settled = new Map<K, V>();
    let same = this.size === this.#previous.size;
    const previous = [...this.#previous];
    let index = 0;
    for (const [key, value] of Map.prototype.entries.call(this) as MapIterator<[K, V]>) {
      const shared =
        this.#touched.has(key) && this.#previous.has(key)
          ? shareEqual(this.#previous.get(key)!, value)
          : value;
      settled.set(key, shared);
      const [previousKey, previousValue] = previous[index++] ?? [];
      same &&= previousKey === key && previousValue === shared;
    }
    return same ? (this.#previous as Map<K, V>) : settled;
  }
}

/** A drafted map as state again; one the change replaced is taken as it is. */
export const settleMap = <K, V>(map: Map<K, V>): Map<K, V> =>
  map instanceof DraftMap ? map.settle() : map;
