import { normalizeApplicationError } from '@moonbase/effect';
import { randomUUID } from 'node:crypto';
import type { App, BrowserWindow, Dialog, IpcMain, IpcMainEvent } from 'electron';
import { ApplicationError } from '@moonbase/contracts/errors';
import { decodeApplicationErrorDTO } from '@moonbase/contracts/error-schema';
import type { EditorSession } from '../session.ts';
import type { DesktopChatBackends } from './chat-backends.ts';
import { channels, errorDTO, keys, record, requestId } from '../wire.ts';

export function installWindowLifecycle({
  app,
  window,
  dialog,
  ipcMain,
  requireTrusted,
  editorSession,
  chatBackends,
  releaseRoot,
  releaseTransport,
}: {
  app: Pick<App, 'on' | 'quit' | 'exit'>;
  window: BrowserWindow;
  dialog: Pick<Dialog, 'showMessageBox'>;
  ipcMain: Pick<IpcMain, 'on' | 'removeListener'>;
  requireTrusted(event: IpcMainEvent): void;
  editorSession: Pick<EditorSession, 'releaseDocument' | 'dispose'>;
  chatBackends: Pick<DesktopChatBackends, 'getSessions' | 'releaseDocument'>;
  releaseRoot(): Promise<void>;
  releaseTransport(): void;
}) {
  let documentId = randomUUID();
  const backgroundFailures: unknown[] = [];
  const pendingCleanup = new Set<Promise<void>>();
  const reportCleanup = (cleanup: Promise<void>) => {
    const reported = cleanup.catch((error) => {
      if (backgroundFailures.length < 8) backgroundFailures.push(error);
      if (rendererReady && !window.isDestroyed())
        window.webContents.send(channels.action, 'cleanup-error', randomUUID(), {
          ...errorDTO(error),
          message: normalizeApplicationError(error).message.slice(0, 512),
        });
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
      () => editorSession.dispose(),
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
      ipcMain.removeListener(channels.quit, acknowledgeQuit);
      ipcMain.removeListener(channels.ready, markReady);
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
      window.webContents.send(channels.action, 'quit', quit.id);
    }
  }
  function markReady(event: IpcMainEvent) {
    try {
      requireTrusted(event);
      rendererReady = true;
      for (const error of backgroundFailures)
        window.webContents.send(channels.action, 'cleanup-error', randomUUID(), {
          ...errorDTO(error),
          message: normalizeApplicationError(error).message.slice(0, 512),
        });
      if (quitRequested) requestQuit();
    } catch (error) {
      console.error(normalizeApplicationError(error).message);
    }
  }
  async function acknowledgeQuit(event: IpcMainEvent, value: unknown) {
    try {
      requireTrusted(event);
    } catch (error) {
      console.error(normalizeApplicationError(error).message);
      return;
    }
    const owner = documentId,
      intent = quit;
    try {
      const v = record(value);
      keys(v, ['id', 'consent', 'cleanupError'], ['id', 'consent']);
      requestId(v.id);
      if (!quit || v.id !== quit.id) return;
      if (typeof v.consent !== 'boolean')
        throw new ApplicationError({ code: 'Unauthorized', message: 'No matching Quit request.' });
      if (v.cleanupError !== undefined) {
        if (quit.stage !== 'dispose')
          throw new ApplicationError({
            code: 'InvalidInput',
            message: 'Cleanup acknowledgment requires disposal.',
          });
        const dto = decodeApplicationErrorDTO(v.cleanupError);
        const error = new ApplicationError(dto);
        if (error.message.length > 512)
          throw new ApplicationError({
            code: 'InvalidInput',
            message: 'Malformed cleanup acknowledgment.',
          });
        if (backgroundFailures.length < 8) backgroundFailures.push(error);
      }
      if (quit.stage === 'dispose' && !v.consent)
        throw new ApplicationError({
          code: 'InvalidInput',
          message: 'Disposal cannot return to the live workbench.',
        });
      if (!v.consent) {
        quit = undefined;
        quitRequested = false;
        show();
        return;
      }
      // Local agents keep running in the daemon, so Quit asks nothing more of them.
      if (quit.stage === 'preserve') {
        quit = { id: randomUUID(), stage: 'dispose' };
        window.webContents.send(channels.action, 'dispose', quit.id);
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
  ipcMain.on(channels.ready, markReady);
  ipcMain.on(channels.quit, acknowledgeQuit);
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
    reportCleanup(editorSession.releaseDocument());
    reportCleanup(chatBackends.releaseDocument());
  });
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (terminating || exiting) return;
    documentId = randomUUID();
    reportCleanup(editorSession.releaseDocument());
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
  return { show, requestQuit, reportCleanup, isQuitting: () => !!quit || terminating };
}
export type WindowLifecycle = ReturnType<typeof installWindowLifecycle>;
