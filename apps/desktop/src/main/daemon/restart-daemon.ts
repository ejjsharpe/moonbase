import type { BrowserWindow, Dialog } from 'electron';
import { Effect } from 'effect';
import { showDialog } from '../native-actions.ts';
import type { LocalDaemon } from './local-daemon.ts';

/**
 * The Restart daemon action: after the user confirms, stops the local daemon with `SIGTERM` (one
 * of an older protocol included) and starts this app's at once, connecting to it; its runs resume
 * there. A failure is reported, never thrown.
 */
export const restartDaemon = ({
  daemon,
  dialog,
  window,
}: {
  daemon: Pick<LocalDaemon['Service'], 'restart'>;
  dialog: Pick<Dialog, 'showMessageBox' | 'showErrorBox'>;
  window: BrowserWindow;
}) =>
  Effect.gen(function* () {
    const { response } = yield* showDialog(() =>
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
    yield* daemon.restart.pipe(
      Effect.catch(({ message }) =>
        showDialog(async () => dialog.showErrorBox('Moonbase daemon', message)),
      ),
    );
  });
