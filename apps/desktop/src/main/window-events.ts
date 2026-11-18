import type { App, BrowserWindow, Dialog, Event } from 'electron';
import { Effect, FiberHandle, FiberSet } from 'effect';
import { listen } from './electron-listener.ts';
import { WindowLifecycle } from './window-lifecycle.ts';

export type WindowEventsOptions = {
  app: Pick<App, 'on' | 'removeListener'>;
  window: BrowserWindow;
  dialog: Pick<Dialog, 'showMessageBox'>;
  /** Releases the window's document: its connections, requests, watches and what they hold. */
  releaseDocument: Effect.Effect<void, unknown>;
};

/**
 * The window's and app's events while the scope is open: closing the window hides it, activation
 * shows it, Quit asks the document first, a replaced document is released, and a crashed renderer
 * asks the user to recover the workbench or quit.
 */
export const installWindowEvents = ({
  app,
  window,
  dialog,
  releaseDocument,
}: WindowEventsOptions) =>
  Effect.gen(function* () {
    const lifecycle = yield* WindowLifecycle;
    const run = yield* FiberSet.makeRuntime();
    /** The prompt after a crash; a later document's arrival ends it unanswered. */
    const crashPrompt = yield* FiberHandle.make();
    const contents = window.webContents;
    // Until Quit releases these, a closed window only hides and Quit asks the document first.
    yield* listen(window, 'close', (event: Event) => {
      event.preventDefault();
      window.hide();
    });
    yield* listen(app, 'before-quit', (event: Event) => {
      event.preventDefault();
      run(lifecycle.requestQuit);
    });
    yield* listen(app, 'activate', () => run(lifecycle.show));
    yield* listen(app, 'second-instance', () => run(lifecycle.show));
    yield* listen(window, 'ready-to-show', () => run(lifecycle.show));
    yield* listen(
      contents,
      'did-frame-navigate',
      (_event: Event, _url: string, _code: number, _status: string, isMainFrame: boolean) => {
        if (!isMainFrame) return;
        run(
          Effect.gen(function* () {
            yield* FiberHandle.clear(crashPrompt);
            yield* lifecycle.replaceDocument;
            yield* lifecycle.runCleanup(releaseDocument);
          }),
        );
      },
    );
    const promptAfterCrash = Effect.gen(function* () {
      const recovery = yield* Effect.promise(() =>
        dialog.showMessageBox(window, {
          type: 'error',
          message: 'The workbench stopped unexpectedly.',
          detail:
            'Recover the workbench from its last persisted state, or quit. Recent changes may not have been preserved.',
          buttons: ['Recover workbench', 'Quit Moonbase'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        }),
      );
      if (recovery.response !== 0) return yield* lifecycle.finishQuit;
      if (!(yield* lifecycle.recoverDocument)) return;
      yield* lifecycle.show;
      yield* Effect.sync(() => contents.reload());
    });
    yield* listen(contents, 'render-process-gone', (_event: Event, details: { reason: string }) =>
      run(
        Effect.gen(function* () {
          if (!(yield* lifecycle.crashDocument)) return;
          yield* lifecycle.runCleanup(releaseDocument);
          yield* Effect.logError('Workbench renderer exited:', details.reason);
          yield* FiberHandle.run(crashPrompt, promptAfterCrash);
        }),
      ),
    );
  });
