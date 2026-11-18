import { BrowserWindow, session, type Event } from 'electron';
import { Context, Effect, Layer } from 'effect';
import { listen } from './electron-listener.ts';

/** The app's own document, the only one main serves IPC to. */
export const appURL = 'moonbase://editor/index.html';

/**
 * The workbench window, sandboxed and unable to navigate, open other windows or attach webviews,
 * with every permission refused; closing the scope destroys it.
 */
export const makeMainWindow = (options: { preload: string; devTools: boolean }) =>
  Effect.gen(function* () {
    const window = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new BrowserWindow({
            title: 'Moonbase',
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 14, y: 14 },
            backgroundColor: '#14151b',
            width: 1280,
            height: 850,
            minWidth: 600,
            minHeight: 480,
            show: false,
            webPreferences: {
              preload: options.preload,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webSecurity: true,
              devTools: options.devTools,
              spellcheck: false,
            },
          }),
      ),
      (window) => Effect.sync(() => window.isDestroyed() || window.destroy()),
    );
    const contents = window.webContents;
    const refuse = (event: Event) => event.preventDefault();
    yield* listen(contents, 'will-navigate', refuse);
    yield* listen(contents, 'will-frame-navigate', refuse);
    yield* listen(contents, 'will-attach-webview', refuse);
    yield* Effect.sync(() => {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
    });
    return window;
  });

/** The workbench window. */
export class MainWindow extends Context.Service<MainWindow, BrowserWindow>()(
  'moonbase/desktop/MainWindow',
) {}
export const MainWindowLive = (options: Parameters<typeof makeMainWindow>[0]) =>
  Layer.effect(MainWindow, makeMainWindow(options));
