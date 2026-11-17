import type { BrowserWindow, Dialog } from 'electron';
import { Effect } from 'effect';
import type { LocalDaemon } from './local-daemon.ts';

/**
 * The Restart daemon action: after the user confirms, stops the local daemon with `SIGTERM` (one
 * of an older protocol included) and starts this app's at once with `start`, which also connects
 * to it; its runs resume there. A failure is reported, never thrown.
 */
export const restartDaemon = ({
  daemon,
  start,
  dialog,
  window,
}: {
  daemon: Pick<LocalDaemon, 'stop'>;
  start: Effect.Effect<unknown, { message: string }>;
  dialog: Pick<Dialog, 'showMessageBox' | 'showErrorBox'>;
  window: BrowserWindow;
}) =>
  Effect.gen(function* () {
    const { response } = yield* Effect.promise(() =>
      dialog.showMessageBox(window, {
        type: 'question',
        message: 'Restart the Moonbase daemon?',
        detail:
          'Running agents stop and resume once it is back. Files and chats are unavailable until then.',
        buttons: ['Cancel', 'Restart'],
        defaultId: 0,
        cancelId: 0,
      }),
    );
    if (response !== 1) return;
    yield* Effect.tryPromise({
      try: () => daemon.stop(),
      catch: (error) => ({
        message: error instanceof Error ? error.message : 'The daemon could not be restarted.',
      }),
    }).pipe(
      Effect.andThen(start),
      Effect.catch(({ message }) => Effect.sync(() => dialog.showErrorBox('Moonbase daemon', message))),
    );
  });
