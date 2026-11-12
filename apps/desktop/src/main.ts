import {
  normalizeApplicationError,
  runApplicationEffect,
} from '@moonbase/application/runtime/effect-client';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  shell,
} from 'electron';
import { Effect, ManagedRuntime } from 'effect';
import { WorkspaceService, type WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { readInstallationId, WorkspaceRecoveryLive } from '@moonbase/workspace';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { acquireDaemonChat } from './chat/daemon.ts';
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EditorSession } from './session.ts';
import { channels } from './wire.ts';
import { readConfiguration } from './chat/config.ts';
import { acquireRemoteChat } from './chat/remote.ts';
import { channels as chatChannels } from './chat/wire.ts';
import { respondTranscriptImage, transcriptImagePath } from './chat/transcript-native.ts';
import { createNativeActions } from './main/native-actions.ts';
import { createChatBackends } from './main/chat-backends.ts';
import { createFileRequestIds } from './main/request-ids.ts';
import { createDaemonWorkspaceHost } from './main/workspace-host.ts';
import { findDaemonCommand, type DaemonCommand } from './main/daemon-command.ts';
import {
  createLocalDaemon,
  findDaemonDirectory,
  olderDaemonMessage,
  readDaemonSession,
  restartDaemon,
} from './main/local-daemon.ts';
import { createTrustedDocumentGuard, installCommandIpc } from './main/ipc.ts';
import { installWindowLifecycle } from './main/window-lifecycle.ts';

const directory = fileURLToPath(new URL('.', import.meta.url));
/** The packaged daemon bundle's build identifier, which `scripts/build.mjs` defines. */
declare const MOONBASE_DAEMON_BUILD: string | undefined;

async function main() {
  const requestedData =
    process.env.MOONBASE_USER_DATA ??
    (app.isPackaged ? join(app.getPath('appData'), 'Moonbase') : undefined);
  if (!requestedData || !isAbsolute(requestedData))
    throw Error('Set MOONBASE_USER_DATA to an explicit new Moonbase user-data directory.');
  mkdirSync(requestedData, { recursive: true, mode: 0o700 });
  const userData = realpathSync(requestedData);
  app.setPath('userData', userData);
  app.setName('Moonbase');
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'moonbase',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
  const appURL = 'moonbase://editor/index.html';
  const csp =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
  await app.whenReady();
  const chatConfiguration =
    process.env.MOONBASE_CHAT_CONFIG === undefined
      ? null
      : await readConfiguration(process.env.MOONBASE_CHAT_CONFIG);
  // Files, Git and search are served by the profile's daemon, which main reaches on demand; this
  // process keeps only this installation's recovery store (drafts and editor state), so the
  // window opens and drafts are kept without the daemon.
  // The recovery store keeps this installation's identity to the daemon's file host.
  const installationId = readInstallationId(join(userData, 'workspace-v1'));
  let reachWorkspace = (): Promise<WorkspaceHostServiceShape> =>
    Promise.reject(new ApplicationError({ code: 'Unavailable', message: 'Moonbase is starting.' }));
  const host = createDaemonWorkspaceHost(() => reachWorkspace());
  const runtime = ManagedRuntime.make(
    WorkspaceRecoveryLive(
      {
        dataDirectory: join(userData, 'workspace-v1'),
        installationId,
      },
      host,
    ),
  );
  const client = makeEditorClient(runtime);
  await runtime.runPromise(Effect.asVoid(WorkspaceService));
  // Local chat runs in this profile's daemon, which outlives the app; main finds or starts it and
  // binds clients to it. Local and remote clients are acquired in separate scopes of this root.
  const daemonDirectory = findDaemonDirectory(userData);
  // Tests of an unpackaged app start the daemon's faux entry instead; a packaged app never does.
  const testDaemonCommand = app.isPackaged
    ? undefined
    : (globalThis as { moonbaseTestDaemonCommand?: (directory: string) => DaemonCommand })
        .moonbaseTestDaemonCommand;
  const daemonCommand: DaemonCommand =
    testDaemonCommand?.(daemonDirectory) ??
    findDaemonCommand(
      {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        bundleDirectory: directory,
        build: typeof MOONBASE_DAEMON_BUILD === 'string' ? MOONBASE_DAEMON_BUILD : 'development',
      },
      daemonDirectory,
      process.env,
    );
  const daemon = createLocalDaemon({ directory: daemonDirectory, command: daemonCommand });
  const acquireLocal = () =>
    acquireDaemonChat(runtime, {
      directory: daemonDirectory,
      command: daemonCommand,
      daemon,
      openUrl: (url) => shell.openExternal(url),
    }).then(
      (backend) => ({ backend, error: null }),
      (error: unknown) => {
        const { code, message } = normalizeApplicationError(error);
        console.error('Local chat is unavailable:', message);
        return {
          backend: null,
          error: new ApplicationError({
            code: 'Unavailable',
            // The daemon's own reason when it is still busy; otherwise the generic one.
            message:
              code === 'Unavailable' && message === olderDaemonMessage
                ? message
                : 'Moonbase could not start or reach its local daemon. Retry; drafts are kept.',
          }),
        };
      },
    );
  const remote = chatConfiguration
    ? await acquireRemoteChat(runtime, chatConfiguration, (url) => shell.openExternal(url))
    : null;
  const window = new BrowserWindow({
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
      preload: join(directory, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  let peekWorkspace = (): WorkspaceHostServiceShape | null => null;
  const requireTrusted = createTrustedDocumentGuard(window, appURL);
  const native = createNativeActions({
    window,
    dialog,
    clipboard,
    shell,
    // Picker and clipboard paths are native; a drop's paths come from the renderer (webUtils), so
    // the daemon's reserved-path check on every import is the authority.
    capture: async (input) =>
      (await runApplicationEffect(runtime, host.captureImports(input))).references,
    // Releasing never starts a daemon: references of one that is not running expire on their own.
    release: async (input) => {
      const running = daemon.isRunning() ? peekWorkspace() : null;
      if (running) await runApplicationEffect(runtime, running.releaseImports(input));
    },
  });
  const editorSession = new EditorSession(
    runtime,
    client,
    native,
    (id, value) => {
      if (!window.isDestroyed()) window.webContents.send(channels.event, id, value);
    },
    // Reveal in Finder applies only to files on this Mac, which are the local daemon's.
    async () => (await readDaemonSession(daemonDirectory).catch(() => undefined))?.host.hostId,
  );
  const chatBackends = createChatBackends({
    transcript: {
      writeText: async (text) => {
        await clipboard.writeText(text);
      },
      openExternal: (url) => shell.openExternal(url),
    },
    runtime,
    // Local chat is acquired in the background below, so the window doesn't wait for the daemon.
    localResult: {
      backend: null,
      error: new ApplicationError({ code: 'Unavailable', message: 'Local chat is starting.' }),
    },
    acquireLocal,
    // A project's checkout or worktree is a folder the daemon lets a chat use, so its docked chat
    // needs no picker; main trusts these for a chat's new worktree.
    isEditorFolder: (path) => editorSession.hasFolder(path),
    installationId,
    requestIds: createFileRequestIds(join(userData, 'workspace-v1', 'chat-requests.json')),
    adoptCheckout: (target) => editorSession.adoptCheckout(target),
    remote,
    emit: (backendId, id, result) => {
      if (!window.isDestroyed()) window.webContents.send(chatChannels.event, id, result, backendId);
    },
    pickFolder: async () => {
      const selection = await dialog.showOpenDialog(window, {
        title: 'Choose a local chat working folder',
        properties: ['openDirectory'],
      });
      return selection.canceled ? null : (selection.filePaths[0] ?? null);
    },
  });
  reachWorkspace = async () => (await chatBackends.getLocalBackend()).workspace;
  peekWorkspace = () => chatBackends.peekLocalWorkspace();
  const rendererRoot = join(directory, 'renderer');
  protocol.handle('moonbase', async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith(transcriptImagePath))
      return respondTranscriptImage(request, csp, chatBackends.findTranscriptImage);
    // Asset cache-busting queries do not grant document/IPC authority.
    const path = resolve(rendererRoot, '.' + decodeURIComponent(url.pathname));
    if (
      url.host !== 'editor' ||
      url.hash ||
      (path !== rendererRoot && !path.startsWith(rendererRoot + sep))
    )
      return new Response('Forbidden', { status: 403 });
    try {
      const response = await net.fetch(pathToFileURL(path).href);
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', csp);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  const lifecycle = installWindowLifecycle({
    app,
    window,
    dialog,
    ipcMain,
    requireTrusted,
    editorSession,
    chatBackends,
    releaseRoot: () => runApplicationEffect(runtime, runtime.disposeEffect),
    releaseTransport: () => {
      uninstallCommandIpc();
      protocol.unhandle('moonbase');
    },
  });
  const uninstallCommandIpc = installCommandIpc({
    ipcMain,
    requireTrusted,
    editorSession,
    chatBackends,
    lifecycle,
  });
  const { show, requestQuit } = lifecycle;
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
          {
            label: 'Restart Daemon…',
            click: () =>
              void restartDaemon({
                daemon,
                confirm: async () =>
                  (
                    await dialog.showMessageBox(window, {
                      type: 'question',
                      message: 'Restart the Moonbase daemon?',
                      detail:
                        'Running agents stop and resume once it is back. Files and chats are unavailable until then.',
                      buttons: ['Cancel', 'Restart'],
                      defaultId: 0,
                      cancelId: 0,
                    })
                  ).response === 1,
                report: (message) => dialog.showErrorBox('Moonbase daemon', message),
              }),
          },
          { type: 'separator' },
          { label: 'Quit Moonbase', accelerator: 'CmdOrCtrl+Q', click: requestQuit },
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
          { label: 'Show workbench', click: show },
          { label: 'Hide workbench', accelerator: 'CmdOrCtrl+Shift+H', click: () => window.hide() },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
  // The editor loads at once; local chat joins this first acquisition, or retries it on failure.
  void chatBackends.getContext('local').catch(() => {});
  await window.loadURL(appURL);
}
void main().catch((error) => {
  console.error(normalizeApplicationError(error).message);
  app.exit(1);
});
