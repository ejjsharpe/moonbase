// JSON/structuredClone restore ordinary objects, so every dynamic key stays an own property.
export const readOwn = <A>(
  record: Readonly<Record<string, A>> | undefined,
  key: string,
): A | undefined => (record && Object.hasOwn(record, key) ? record[key] : undefined);
export function writeOwn<A>(record: Record<string, A>, key: string, value: A): A {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return value;
}
