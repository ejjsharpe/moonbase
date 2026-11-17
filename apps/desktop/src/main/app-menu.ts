import type { BrowserWindow, Menu as ElectronMenu } from 'electron';
import { Effect, FiberSet } from 'effect';
import { WindowLifecycle } from './window-lifecycle.ts';

/** The application menu; its actions run in the scope, which ends any still running. */
export const installAppMenu = ({
  Menu,
  window,
  restart,
}: {
  Menu: Pick<typeof ElectronMenu, 'setApplicationMenu' | 'buildFromTemplate'>;
  window: BrowserWindow;
  readonly restart: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const lifecycle = yield* WindowLifecycle;
    const run = yield* FiberSet.makeRuntime();
    yield* Effect.sync(() =>
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Moonbase',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { label: 'Restart Daemon…', click: () => run(restart) },
              { type: 'separator' },
              {
                label: 'Quit Moonbase',
                accelerator: 'CmdOrCtrl+Q',
                click: () => run(lifecycle.requestQuit),
              },
            ],
          },
          {
            label: 'Edit',
            submenu: [
              { role: 'undo' },
              { role: 'redo' },
              { type: 'separator' },
              { role: 'cut' },
              { role: 'copy' },
              { role: 'paste' },
              { role: 'selectAll' },
            ],
          },
          {
            label: 'View',
            submenu: [
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { type: 'separator' },
              { label: 'Show workbench', click: () => run(lifecycle.show) },
              {
                label: 'Hide workbench',
                accelerator: 'CmdOrCtrl+Shift+H',
                click: () => window.hide(),
              },
            ],
          },
          { role: 'windowMenu' },
        ]),
      ),
    );
  });
