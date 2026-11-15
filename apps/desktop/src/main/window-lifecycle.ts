import { normalizeApplicationError } from '@moonbase/effect';
import { randomUUID } from 'node:crypto';
import type { App, BrowserWindow, Dialog } from 'electron';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { DesktopChatBackends } from './chat/chat-backends.ts';
import { boundApplicationError } from '../ipc/ipc-errors.ts';
import type { WindowAction } from '../ipc/window-rpcs.ts';

/** What the window's document answers a `quit` or `dispose` request with. */
export type QuitAnswer = { id: string; consent: boolean; cleanupError?: ApplicationError };

/**
 * The window's Quit handshake and document lifetime: it asks the document to prepare Quit and to
 * dispose (`sendAction`), releases a replaced document's IPC (`ipc`) and chat sessions, and quits
 * once every owner is released.
 */
export function installWindowLifecycle({
  app,
  window,
  dialog,
  sendAction,
  ipc,
  chatBackends,
  releaseRoot,
  releaseTransport,
}: {
  app: Pick<App, 'on' | 'quit' | 'exit'>;
  window: BrowserWindow;
  dialog: Pick<Dialog, 'showMessageBox'>;
  /** Delivers an action to the documents watching for them. */
  sendAction(action: WindowAction): void;
  /** The window's IPC: a document's connections and what they hold, then all of it. */
  ipc: { releaseDocument(): Promise<void>; dispose(): Promise<void> };
  chatBackends: Pick<DesktopChatBackends, 'getSessions' | 'releaseDocument'>;
  releaseRoot(): Promise<void>;
  releaseTransport(): void;
}) {
  let documentId = randomUUID();
  const backgroundFailures: unknown[] = [];
  /**
   * The latest document cleanup failures, as sent: each watch hears of them all again, since one
   * that ended may have missed them, and the document takes each id once.
   */
  const failureReports: Extract<WindowAction, { action: 'cleanup-error' }>[] = [];
  const pendingCleanup = new Set<Promise<void>>();
  const reportCleanup = (cleanup: Promise<void>) => {
    const reported = cleanup.catch((error) => {
      if (backgroundFailures.length < 8) backgroundFailures.push(error);
      const report = {
        action: 'cleanup-error' as const,
        id: randomUUID(),
        error: boundApplicationError(normalizeApplicationError(error)),
      };
      failureReports.push(report);
      if (failureReports.length > 64) failureReports.shift();
      if (rendererReady && !window.isDestroyed()) sendAction(report);
      console.error('Document cleanup failed:', normalizeApplicationError(error).message);
    });
    pendingCleanup.add(reported);
    void reported.then(() => pendingCleanup.delete(reported));
  };
  let quit: { id: string; stage: 'preserve' | 'dispose' } | undefined,
    exiting = false,
    rendererReady = false,
    quitRequested = false,
    terminating = false;
  function show() {
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
  }
  async function finishQuit() {
    if (terminating) return;
    terminating = true;
    rendererReady = false;
    await Promise.all(pendingCleanup);
    const failures: unknown[] = backgroundFailures.splice(0);
    for (const cleanup of [
      ...chatBackends.getSessions().map((session) => () => session.dispose()),
      () => ipc.dispose(),
      releaseRoot,
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (failures.length) {
        const detail = failures.map((error) => normalizeApplicationError(error).message).join('\n');
        console.error('Quit cleanup failed:', detail);
        await dialog.showMessageBox(window, {
          type: 'error',
          message: 'Moonbase could not finish cleanup.',
          detail:
            'Preserved recovery remains available on next launch. Moonbase will now quit.\n' +
            detail,
          buttons: ['Quit Moonbase'],
        });
      }
    } finally {
      exiting = true;
      releaseTransport();
      window.destroy();
      if (failures.length) app.exit(1);
      else app.quit();
    }
  }
  function requestQuit() {
    if (terminating) return;
    quitRequested = true;
    show();
    if (!rendererReady) return;
    if (!quit) {
      quit = { id: randomUUID(), stage: 'preserve' };
      sendAction({ action: 'quit', id: quit.id });
    }
  }
  /**
   * The document watches for actions: it is ready for Quit and to hear of cleanup failures. A
   * watch that replaced one whose connection ended may have missed the pending request, so it is
   * asked again; the document takes each request once.
   */
  function markReady() {
    rendererReady = true;
    for (const report of failureReports) sendAction(report);
    if (quit) sendAction({ action: quit.stage === 'preserve' ? 'quit' : 'dispose', id: quit.id });
    else if (quitRequested) requestQuit();
  }
  async function answerQuit(answer: QuitAnswer) {
    const owner = documentId,
      intent = quit;
    try {
      if (!quit || answer.id !== quit.id) return;
      if (answer.cleanupError !== undefined) {
        if (quit.stage !== 'dispose') {
          quit = undefined;
          show();
          console.error('Quit failed: a cleanup failure answers only disposal.');
          return;
        }
        if (backgroundFailures.length < 8) backgroundFailures.push(answer.cleanupError);
      }
      if (quit.stage === 'dispose' && !answer.consent) {
        console.error('Invalid disposal answer: disposal cannot return to the live workbench.');
        return;
      }
      if (!answer.consent) {
        quit = undefined;
        quitRequested = false;
        show();
        return;
      }
      // Local agents keep running in the daemon, so Quit asks nothing more of them.
      if (quit.stage === 'preserve') {
        quit = { id: randomUUID(), stage: 'dispose' };
        sendAction({ action: 'dispose', id: quit.id });
        return;
      }
      await finishQuit();
    } catch (error) {
      if (owner !== documentId || intent !== quit) return;
      if (quit?.stage === 'dispose') {
        console.error('Invalid disposal acknowledgment:', normalizeApplicationError(error).message);
        return;
      }
      quit = undefined;
      show();
      console.error('Quit failed:', normalizeApplicationError(error).message);
    }
  }
  window.on('close', (event) => {
    if (!exiting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
    if (!isMainFrame) return;
    documentId = randomUUID();
    rendererReady = false;
    // A replacement document must prepare its own application before acknowledging Quit.
    quit = undefined;
    reportCleanup(ipc.releaseDocument());
    reportCleanup(chatBackends.releaseDocument());
  });
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (terminating || exiting) return;
    documentId = randomUUID();
    reportCleanup(ipc.releaseDocument());
    reportCleanup(chatBackends.releaseDocument());
    rendererReady = false;
    quit = undefined;
    quitRequested = false;
    console.error('Workbench renderer exited:', details.reason);
    const owner = documentId;
    const recovery = await dialog.showMessageBox(window, {
      type: 'error',
      message: 'The workbench stopped unexpectedly.',
      detail:
        'Recover the workbench from its last persisted state, or quit. Recent changes may not have been preserved.',
      buttons: ['Recover workbench', 'Quit Moonbase'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (owner !== documentId || terminating || exiting) return;
    if (recovery.response === 0) {
      quitRequested = false;
      show();
      window.webContents.reload();
    } else await finishQuit();
  });
  app.on('before-quit', (event) => {
    if (!exiting) {
      event.preventDefault();
      requestQuit();
    }
  });
  app.on('activate', show);
  app.on('second-instance', show);

  window.once('ready-to-show', show);
  return {
    show,
    requestQuit,
    reportCleanup,
    markReady,
    answerQuit,
    isQuitting: () => !!quit || terminating,
  };
}
export type WindowLifecycle = ReturnType<typeof installWindowLifecycle>;
