import { Effect, type Scope } from 'effect';

/** What Electron's emitters (`app`, a window, its `webContents`, `ipcMain`) let a listener do. */
export type Emitter = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
};

/** Listens for `event` while the scope is open; closing it removes the listener. */
export const listen = <Args extends unknown[]>(
  emitter: Emitter,
  event: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => void emitter.on(event, listener as never)),
    () => Effect.sync(() => void emitter.removeListener(event, listener as never)),
  );
