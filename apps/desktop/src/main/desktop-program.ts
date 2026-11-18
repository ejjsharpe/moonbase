import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { app, dialog, protocol } from 'electron';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { StartupError } from './startup-errors.ts';
import { readConfiguration } from './chat/config.ts';
import { DesktopServicesLive } from './desktop-services.ts';
import { IpcServer } from './ipc/ipc-server.ts';
import { appURL, MainWindow, MainWindowLive } from './main-window.ts';
import { readTestHooks } from './test-hooks.ts';
import { prepareUserData } from './user-data.ts';
import { installWindowEvents } from './window-events.ts';
import { collectQuitFailures, makeWindowLifecycle, WindowLifecycle } from './window-lifecycle.ts';

/** The packaged daemon bundle's build identifier, which `scripts/build.mjs` defines. */
declare const MOONBASE_DAEMON_BUILD: string | undefined;
const bundleDirectory = fileURLToPath(new URL('.', import.meta.url));

/**
 * The window from start to Quit. Quit releases the services (each document's work, the chat and
 * daemon clients, the recovery store), then reports what failed to release before the window
 * goes; the result is the exit code.
 */
const runWindow = (options: Omit<Parameters<typeof DesktopServicesLive>[0], 'bundleDirectory'>) =>
  Effect.gen(function* () {
    const window = yield* MainWindow;
    const lifecycle = yield* WindowLifecycle;
    const services = yield* Scope.fork(yield* Effect.scope, 'sequential');
    const ipc = Context.get(
      yield* Layer.buildWithScope(DesktopServicesLive({ ...options, bundleDirectory }), services),
      IpcServer,
    );
    yield* installWindowEvents({ app, window, dialog, releaseDocument: ipc.releaseDocument });
    yield* Effect.tryPromise(() => window.loadURL(appURL));
    yield* lifecycle.awaitQuit;
    const closed = yield* Effect.exit(Scope.close(services, Exit.void));
    const failures = yield* collectQuitFailures(lifecycle, closed);
    if (!failures.length) return 0;
    const detail = failures.join('\n');
    yield* Effect.logError('Quit cleanup failed:', detail);
    yield* Effect.promise(() =>
      dialog.showMessageBox(window, {
        type: 'error',
        message: 'Moonbase could not finish cleanup.',
        detail:
          'Preserved recovery remains available on next launch. Moonbase will now quit.\n' + detail,
        buttons: ['Quit Moonbase'],
      }),
    );
    return 1;
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.effect(
        WindowLifecycle,
        Effect.flatMap(MainWindow, (window) =>
          makeWindowLifecycle({ window, deliver: options.hooks.windowAction }),
        ),
      ).pipe(
        Layer.provideMerge(
          MainWindowLive({
            preload: join(bundleDirectory, 'preload.cjs'),
            devTools: !options.packaged,
          }),
        ),
      ),
    ),
  );

/**
 * Electron main as one program: it prepares the profile, takes the single-instance lock, and runs
 * the window until Quit. Its result is the exit code; 0 quits Electron normally. Electron needs
 * the profile and the `moonbase:` scheme before it is ready, so nothing before `whenReady` waits.
 */
export const desktopProgram = Effect.gen(function* () {
  const userData = yield* prepareUserData(app);
  app.setName('Moonbase');
  if (!app.requestSingleInstanceLock()) return 0;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'moonbase',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
  yield* Effect.promise(() => app.whenReady());
  const configurationPath = process.env.MOONBASE_CHAT_CONFIG;
  const chatConfiguration =
    configurationPath === undefined
      ? null
      : yield* Effect.tryPromise({
          try: () => readConfiguration(configurationPath),
          catch: (error) =>
            error instanceof StartupError
              ? error
              : new StartupError({ problem: 'chat-config-unreadable' }),
        });
  return yield* runWindow({
    userData,
    packaged: app.isPackaged,
    daemonBuild: typeof MOONBASE_DAEMON_BUILD === 'string' ? MOONBASE_DAEMON_BUILD : 'development',
    chatConfiguration,
    hooks: readTestHooks(app.isPackaged),
  }).pipe(Effect.provide(NodeServices.layer));
});
