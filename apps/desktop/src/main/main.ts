import { normalizeApplicationError } from '@moonbase/effect';
import { toWireError } from '@moonbase/contracts/workspace-host-errors';
import { runApplicationEffect } from '@moonbase/application/chat/promises';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  net,
  protocol,
  session,
  shell,
} from 'electron';
import { Cause, Effect, Exit, ManagedRuntime, PubSub, Scope } from 'effect';
import { WorkspaceService } from '@moonbase/contracts/services';
import { readInstallationId, WorkspaceRecoveryLive } from '@moonbase/workspace';
import { acquireDaemonChat, createLocalDaemonClient } from './daemon/local-daemon-client.ts';
import { mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApplicationError } from '@moonbase/contracts/errors';
import { readConfiguration } from './chat/config.ts';
import { acquireRemoteChat } from './chat/remote.ts';
import { toLegacyApplicationError, type DesktopIpcError } from '../ipc/ipc-errors.ts';
import type { WindowAction } from '../ipc/window-rpcs.ts';
import { respondTranscriptImage, transcriptImagePath } from './chat/transcript-native.ts';
import { createNativeActions } from './native-actions.ts';
import { createChatBackends } from './chat/chat-backends.ts';
import { createFileRequestIds } from './request-ids.ts';
import { createDaemonWorkspaceHost } from './daemon/workspace-host.ts';
import { findDaemonCommand, type DaemonCommand } from './daemon/daemon-command.ts';
import {
  createLocalDaemon,
  findDaemonDirectory,
  readDaemonSession,
  restartDaemon,
} from './daemon/local-daemon.ts';
import { installWindowLifecycle, type WindowLifecycle } from './window-lifecycle.ts';
import type { IpcInterception } from './ipc/admission.ts';
import { makeDocumentHandlers } from './ipc/document-handlers.ts';
import { EditorApprovals } from './ipc/editor-approvals.ts';
import { createTrustedDocumentCheck, installIpcConnect } from './ipc/ipc-connect.ts';
import { makeIpcServer } from './ipc/ipc-server.ts';

const directory = fileURLToPath(new URL('.', import.meta.url));
/** The packaged daemon bundle's build identifier, which `scripts/build.mjs` defines. */
declare const MOONBASE_DAEMON_BUILD: string | undefined;
/** A request's outcome as an unpackaged test entry sees and replaces it. */
type TestIpcReply =
  | { ok: true; value: unknown }
  | { ok: false; error: ApplicationError; interrupted?: boolean };
/** An unpackaged test entry's view of each IPC request: it may observe, hold or replace it. */
type TestIpcHook = (
  request: { tag: string; payload: unknown },
  proceed: () => Promise<TestIpcReply>,
) => Promise<TestIpcReply>;

/** An unpackaged test entry's view of each action main sends the document. */
type TestWindowAction = (action: WindowAction, send: (action: WindowAction) => void) => void;

/** The test entry's hook as the IPC admission's interception; a reply it keeps keeps its exit. */
function toInterception(hook: TestIpcHook): IpcInterception {
  const exits = new WeakMap<TestIpcReply, Exit.Exit<unknown, unknown>>();
  const toReply = (exit: Exit.Exit<unknown, unknown>): TestIpcReply => {
    let reply: TestIpcReply;
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
    if (Exit.isSuccess(exit)) reply = { ok: true, value: exit.value };
    else if (failure?._tag === 'Some')
      reply = { ok: false, error: toLegacyApplicationError(failure.value as DesktopIpcError) };
    else
      reply = {
        ok: false,
        error: new ApplicationError({ code: 'Cancelled', message: 'Command cancelled' }),
        interrupted: true,
      };
    exits.set(reply, exit);
    return reply;
  };
  return (request, handler) =>
    Effect.flatMap(Effect.context<never>(), (context) =>
      Effect.tryPromise({
        try: (signal) =>
          hook(request, () =>
            Effect.runPromiseExitWith(context)(handler, { signal }).then(toReply),
          ),
        catch: normalizeApplicationError,
      }),
    ).pipe(
      Effect.flatMap((reply) => {
        const exit = exits.get(reply);
        if (exit) return exit;
        return reply.ok
          ? Effect.succeed(reply.value)
          : Effect.fail(new ApplicationError(reply.error));
      }),
    );
}

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
  // Files, Git, search and local chat are served by the profile's daemon, which outlives the app;
  // main finds or starts it on demand and binds clients to it in a scope of the root. This process
  // keeps only this installation's recovery store (drafts and editor state), so the window opens
  // and drafts are kept without the daemon.
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
  // Acquired only once a request needs it, by which time the root runtime below exists.
  const local = createLocalDaemonClient(() =>
    acquireDaemonChat(runtime, { daemon, openUrl: (url) => shell.openExternal(url) }),
  );
  // The recovery store keeps this installation's identity to the daemon's file host.
  const installationId = readInstallationId(join(userData, 'workspace-v1'));
  const host = createDaemonWorkspaceHost(local);
  const runtime = ManagedRuntime.make(
    WorkspaceRecoveryLive(
      {
        dataDirectory: join(userData, 'workspace-v1'),
        installationId,
      },
      host,
    ),
  );
  const workspace = await runtime.runPromise(Effect.map(WorkspaceService, (service) => service));
  // Local and remote chat clients are acquired in separate scopes of this root.
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

  const native = createNativeActions({
    window,
    dialog,
    clipboard,
    shell,
    // Picker and clipboard paths are native; a drop's paths come from the renderer (webUtils), so
    // the daemon's reserved-path check on every import is the authority.
    capture: async (input) =>
      (
        await runApplicationEffect(
          runtime,
          host.captureImports(input).pipe(Effect.mapError(toWireError)),
        )
      ).references,
    // Releasing never starts a daemon: references of one that is not running expire on their own.
    release: async (input) => {
      const running = daemon.isRunning() ? local.peek()?.workspace : null;
      if (running)
        await runApplicationEffect(
          runtime,
          running.releaseImports(input).pipe(Effect.mapError(toWireError)),
        );
    },
  });
  const approvals = new EditorApprovals();
  // The window lifecycle, installed below; a report before then only reaches the log.
  const late: { lifecycle?: WindowLifecycle } = {};
  const reportCleanup = (error: unknown) => {
    if (late.lifecycle) late.lifecycle.reportCleanup(Promise.reject(error));
    else console.error('Cleanup failed:', normalizeApplicationError(error).message);
  };
  const chatBackends = createChatBackends({
    transcript: {
      writeText: async (text) => {
        await clipboard.writeText(text);
      },
      openExternal: (url) => shell.openExternal(url),
    },
    runtime,
    // Reached in the background below, so the window doesn't wait for the daemon.
    local,
    installationId,
    requestIds: createFileRequestIds(join(userData, 'workspace-v1', 'chat-requests.json')),
    adoptCheckout: (target) => approvals.adoptCheckout(target),
    remote,
    reportCleanup,
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
      return respondTranscriptImage(request, csp, (token) => {
        const found = chatBackends.findTranscriptImage(token);
        // Electron's protocol API is Promise-based; the read runs on main's runtime from here.
        return (
          found && {
            image: found.image,
            read: (signal) => runApplicationEffect(runtime, found.read, { signal }),
          }
        );
      });
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
  // Built synchronously: Quit may arrive any time after the window exists, and the lifecycle
  // below must be installed before it can.
  const actions = runtime.runSync(PubSub.unbounded<WindowAction>());
  const testIpc = app.isPackaged
    ? undefined
    : (globalThis as { moonbaseTestIpc?: TestIpcHook }).moonbaseTestIpc;
  const ipc = runtime.runSync(
    Scope.provide(
      makeIpcServer(
        makeDocumentHandlers({
          editor: {
            workspace,
            native,
            approvals,
            // Reveal in Finder applies only to files on this Mac, which are the local daemon's.
            localHostId: async () =>
              (await readDaemonSession(daemonDirectory).catch(() => undefined))?.host.hostId,
            reportCleanup,
          },
          chat: {
            backends: chatBackends,
            isQuitting: () => late.lifecycle?.isQuitting() ?? false,
            reportCleanup,
          },
          actions,
          lifecycle: () => late.lifecycle!,
          ...(testIpc ? { intercept: toInterception(testIpc) } : {}),
        }),
      ),
      Scope.forkUnsafe(runtime.scope, 'parallel'),
    ),
  );
  const uninstallIpcConnect = installIpcConnect({
    ipcMain,
    isTrusted: createTrustedDocumentCheck(window, appURL),
    connect: ipc.connect,
    openChannel: () => new MessageChannelMain(),
  });
  const lifecycle = (late.lifecycle = installWindowLifecycle({
    app,
    window,
    dialog,
    sendAction: (action) => {
      const publish = (next: WindowAction) => void PubSub.publishUnsafe(actions, next);
      // An unpackaged test entry may hold or reorder what main asks of the document.
      const test = app.isPackaged
        ? undefined
        : (globalThis as { moonbaseTestWindowAction?: TestWindowAction }).moonbaseTestWindowAction;
      if (test) test(action, publish);
      else publish(action);
    },
    ipc: {
      releaseDocument: () => runApplicationEffect(runtime, ipc.releaseDocument),
      dispose: () => runApplicationEffect(runtime, ipc.dispose),
    },
    chatBackends,
    releaseRoot: () => runApplicationEffect(runtime, runtime.disposeEffect),
    releaseTransport: () => {
      uninstallIpcConnect();
      protocol.unhandle('moonbase');
    },
  }));
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
                start: () => runApplicationEffect(runtime, local.connect()),
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
