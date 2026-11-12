import { useCallback, useSyncExternalStore } from 'react';

// Read once from local storage, then kept here, so a choice storage refuses still lasts the session.
const values = new Map<string, boolean>();
const listeners = new Set<() => void>();

function readToggle(key: string) {
  let value = values.get(key);
  if (value === undefined) {
    try {
      value = localStorage.getItem(key) === 'true';
    } catch {
      value = false;
    }
    values.set(key, value);
  }
  return value;
}

function writeToggle(key: string, value: boolean) {
  values.set(key, value);
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // The choice lasts this session only.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A remembered on/off choice, kept in this renderer's local storage. */
export function useStoredToggle(key: string) {
  const on = useSyncExternalStore(subscribe, () => readToggle(key));
  const toggle = useCallback(() => writeToggle(key, !readToggle(key)), [key]);
  const setOn = useCallback((value: boolean) => writeToggle(key, value), [key]);
  return [on, toggle, setOn] as const;
}
