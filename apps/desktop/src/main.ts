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
import { Context, ManagedRuntime, Effect, Layer, Scope } from 'effect';
import { WorkspaceLive, WorkspaceNative } from '@moonbase/workspace';
import {
  makeEditorClient,
  bindChatClient,
  bindConnectionClient,
} from '@moonbase/application/runtime/clients';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { ChatService, ConnectionService } from '@moonbase/contracts/services';
import { acquireLocalChat } from './chat/local.ts';
import { realpathSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EditorSession } from './session.ts';
import { channels } from './wire.ts';

import { RemoteChatLive } from '@moonbase/pi-runtime/remote';
import { SshLive } from '@moonbase/ssh';
import { readConfiguration } from './chat/config.ts';
import { channels as chatChannels } from './chat/wire.ts';
import { respondTranscriptImage, transcriptImagePath } from './chat/transcript-native.ts';
import { createNativeActions } from './main/native-actions.ts';
import { createChatBackends } from './main/chat-backends.ts';
import { createTrustedDocumentGuard, installCommandIpc } from './main/ipc.ts';
import { installWindowLifecycle } from './main/window-lifecycle.ts';

const directory = fileURLToPath(new URL('.', import.meta.url));

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
  const assets = app.isPackaged
    ? join(process.resourcesPath, 'workspace')
    : join(directory, 'workspace');
  const chatConfiguration =
    process.env.MOONBASE_CHAT_CONFIG === undefined
      ? null
      : await readConfiguration(process.env.MOONBASE_CHAT_CONFIG);
  const workspace = WorkspaceLive({
    hostId: 'moonbase-local',
    dataDirectory: join(userData, 'workspace-v1'),
    filesystemHelper: join(assets, 'filesystem'),
    ripgrepExecutable: join(assets, 'ripgrep/rg'),
    gitExecutable: '/usr/bin/git',
  });
  const runtime = ManagedRuntime.make(workspace);
  const client = makeEditorClient(runtime);
  await runtime.runPromise(Effect.asVoid(WorkspaceNative));
  // Local and remote backends are acquired once in separate scopes of this root.
  // Local chat is acquired before the window's editor session, which approves checkouts, exists.
  let isEditorFolder = (_path: string) => false;
  const acquireLocal = () =>
    acquireLocalChat(runtime, userData, (url) => shell.openExternal(url), {
      ripgrepExecutable: join(assets, 'ripgrep/rg'),
      isEditorFolder: (path) => isEditorFolder(path),
    }).then(
      (backend) => ({ backend, error: null }),
      () => ({
        backend: null,
        error: new ApplicationError({
          code: 'Unavailable',
          message:
            'Local Pi could not initialize. Preserve local chat files, check the working folders and restart Moonbase. Editing remains available.',
        }),
      }),
    );
  const localResult = await acquireLocal();
  const remote = chatConfiguration
    ? await runApplicationEffect(
        runtime,
        Layer.buildWithScope(
          RemoteChatLive.pipe(Layer.provideMerge(SshLive(chatConfiguration.ssh))),
          Scope.forkUnsafe(runtime.scope, 'parallel'),
        ),
      )
    : null;
  const remoteChat = remote ? bindChatClient(runtime, Context.get(remote, ChatService)) : null;
  const connection = remote
    ? bindConnectionClient(runtime, Context.get(remote, ConnectionService))
    : null;
  if (connection) await connection.command('getConnection', {});
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

  const requireTrusted = createTrustedDocumentGuard(window, appURL);
  const native = createNativeActions({
    window,
    dialog,
    clipboard,
    capture: (input) =>
      runApplicationEffect(
        runtime,
        Effect.flatMap(WorkspaceNative, (service) => service.capture(input)),
      ),
    release: (input) =>
      runApplicationEffect(
        runtime,
        Effect.flatMap(WorkspaceNative, (service) => service.release(input)),
      ),
  });
  const editorSession = new EditorSession(runtime, client, native, (id, value) => {
    if (!window.isDestroyed()) window.webContents.send(channels.event, id, value);
  });
  isEditorFolder = (path) => editorSession.hasFolder(path);
  const chatBackends = createChatBackends({
    transcript: {
      writeText: async (text) => {
        await clipboard.writeText(text);
      },
      openExternal: (url) => shell.openExternal(url),
    },
    runtime,
    localResult,
    acquireLocal,
    chatConfiguration,
    remoteChat,
    connection,
    emit: (backendId, id, result) => {
      if (!window.isDestroyed()) window.webContents.send(chatChannels.event, id, result, backendId);
    },
    createWorktree: (root, branch, signal) =>
      editorSession.createChatWorktree(root, branch, signal),
    pickFolder: async () => {
      const selection = await dialog.showOpenDialog(window, {
        title: 'Choose a local chat working folder',
        properties: ['openDirectory'],
      });
      return selection.canceled ? null : (selection.filePaths[0] ?? null);
    },
  });
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
  await window.loadURL(appURL);
}
void main().catch((error) => {
  console.error(normalizeApplicationError(error).message);
  app.exit(1);
});
