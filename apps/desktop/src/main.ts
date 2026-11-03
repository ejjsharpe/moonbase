import { decodeApplicationErrorDTO } from '@moonbase/contracts/error-schema';
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
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { Context, ManagedRuntime, Effect, Layer, Scope } from 'effect';
import { WorkspaceLive, WorkspaceNative } from '@moonbase/workspace';
import {
  makeEditorClient,
  bindChatClient,
  bindConnectionClient,
  bindProviderSetupClient,
} from '@moonbase/application/runtime/clients';
import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import { ChatService, ConnectionService } from '@moonbase/contracts/services';
import { acquireLocalChat } from './chat/local.ts';
import type { Reply, DesktopChatTarget } from './chat/wire.ts';
import { randomUUID } from 'node:crypto';
import { realpathSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { EditorSession } from './session.ts';
import { channels, errorDTO, keys, record, requestId } from './wire.ts';

import { RemoteChatLive } from '@moonbase/pi-runtime/remote';
import { SshLive } from '@moonbase/ssh';
import { readConfiguration } from './chat/config.ts';
import { ChatIpcSession } from './chat/session.ts';
import {
  channels as chatChannels,
  record as chatRecord,
  fields,
  errorDTO as chatError,
} from './chat/wire.ts';

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
  let localResult = await acquireLocalChat(runtime, userData, (url) =>
    shell.openExternal(url),
  ).then(
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
  let local = localResult.backend;
  let localRetry: Promise<void> | undefined;
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
  const rendererRoot = join(directory, 'renderer');
  protocol.handle('moonbase', async (request) => {
    const url = new URL(request.url);
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
  const window = new BrowserWindow({
    title: 'Moonbase',
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
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === appURL;
  const requireTrusted = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    if (!trusted(event))
      throw new ApplicationError({
        code: 'Unauthorized',
        message: 'Untrusted renderer frame/document.',
      });
  };
  const native = {
    async chooseCheckout() {
      const result = await dialog.showOpenDialog(window, {
        title: 'Open a Git checkout',
        properties: ['openDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async imports(
      checkout: CheckoutTarget,
      kind: 'picker' | 'clipboard',
      paths?: string[],
      signal?: AbortSignal,
    ) {
      if (!paths && kind === 'picker') {
        const result = await dialog.showOpenDialog(window, {
          title: 'Import files into ' + checkout.root,
          properties: ['openFile', 'openDirectory', 'multiSelections'],
        });
        if (result.canceled) return [];
        paths = result.filePaths;
      }
      if (kind === 'clipboard') {
        const consent = await dialog.showMessageBox(window, {
          type: 'question',
          message: 'Import clipboard files?',
          detail: 'Copy files from Finder, then confirm import into ' + checkout.root,
          buttons: ['Cancel', 'Import files'],
          defaultId: 0,
          cancelId: 0,
        });
        if (consent.response !== 1) return [];
        const items = await clipboard.read();
        const item = items.find((item) =>
          item.types.some((type) => type.includes('NSFilenamesPboardType')),
        );
        const format = item?.types.find((type) => type.includes('NSFilenamesPboardType'));
        const payload = item && format ? await item.getType(format) : undefined;
        const bytes =
          payload && 'arrayBuffer' in payload
            ? Buffer.from(await payload.arrayBuffer())
            : Buffer.alloc(0);
        if (!bytes.length)
          throw new ApplicationError({
            code: 'InvalidInput',
            message: 'Clipboard contains no Finder files.',
          });
        const parsed: unknown = JSON.parse(
          execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
            input: bytes,
            maxBuffer: 2 ** 20,
          }).toString(),
        );
        if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== 'string'))
          throw new ApplicationError({
            code: 'InvalidInput',
            message: 'Invalid Finder file list.',
          });
        paths = parsed;
      }
      if (signal?.aborted)
        throw new ApplicationError({ code: 'Cancelled', message: 'Native request cancelled.' });
      if (!paths?.length) return [];
      return runApplicationEffect(
        runtime,
        Effect.flatMap(WorkspaceNative, (service) =>
          service.capture({ checkout, clientId: 'desktop-primary', paths }),
        ),
      );
    },
    release(input: { checkout: CheckoutTarget; clientId: string; references: string[] }) {
      return runApplicationEffect(
        runtime,
        Effect.flatMap(WorkspaceNative, (service) => service.release(input)),
      );
    },
  };
  const editorSession = new EditorSession(runtime, client, native, (id, value) => {
    if (!window.isDestroyed()) window.webContents.send(channels.event, id, value);
  });
  ipcMain.handle(channels.call, async (event, value: unknown) => {
    try {
      requireTrusted(event);
      const v = record(value);
      keys(v, ['method', 'input', 'id']);
      return await editorSession.call(v.method, v.input, v.id);
    } catch (error) {
      return { ok: false, error: errorDTO(error) };
    }
  });
  ipcMain.handle(channels.cancel, async (event, id: unknown) => {
    try {
      requireTrusted(event);
      const reply = await editorSession.cancel(id);
      if (!reply.ok) reportCleanup(Promise.reject(new ApplicationError(reply.error)));
      return reply;
    } catch (e) {
      return { ok: false, error: errorDTO(e) };
    }
  });
  const sessions = new Map<string, ChatIpcSession>();
  let documentId = randomUUID();
  const emitChat = (backendId: string) => (id: string, result: Reply) => {
    if (!window.isDestroyed()) window.webContents.send(chatChannels.event, id, result, backendId);
  };
  const installChatSessions = () => {
    if (local && !sessions.has('local'))
      sessions.set(
        'local',
        new ChatIpcSession(
          runtime,
          bindChatClient(runtime, local.chat),
          null,
          local.session,
          emitChat('local'),
          {
            providers: bindProviderSetupClient(runtime, local.providers, documentId),
          },
        ),
      );
    if (chatConfiguration && remoteChat && connection && !sessions.has('remote'))
      sessions.set(
        'remote',
        new ChatIpcSession(
          runtime,
          remoteChat,
          connection,
          chatConfiguration.context,
          emitChat('remote'),
        ),
      );
  };
  installChatSessions();
  const targets: DesktopChatTarget[] = [
    {
      id: 'local',
      label: 'Local',
      mode: 'local',
      context: local?.session ?? {
        host: { hostId: 'unavailable-local', storeId: 'unavailable-local' },
        actorId: 'unavailable-local',
      },
    },
    ...(chatConfiguration
      ? [
          {
            id: 'remote',
            label: chatConfiguration.ssh.profile.label,
            mode: 'remote' as const,
            context: chatConfiguration.context,
          },
        ]
      : []),
  ];
  const releaseChatDocument = async () => {
    const owner = documentId;
    const closing = [...sessions.values()].map((session) => session.dispose());
    sessions.clear();
    documentId = randomUUID();
    local?.control.setAdmissionsOpen(true);
    installChatSessions();
    const results = await Promise.allSettled([
      ...closing,
      ...(local ? [runApplicationEffect(runtime, local.providers.releaseOwner(owner))] : []),
    ]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  };
  ipcMain.handle(channels.configured, (event, ...args: unknown[]) => {
    try {
      requireTrusted(event);
      if (args.length !== 1 || args[0] !== null)
        throw new ApplicationError({
          code: 'InvalidInput',
          message: 'Unexpected configuration query input.',
        });
      return { ok: true, value: true };
    } catch (error) {
      return { ok: false, error: errorDTO(error) };
    }
  });
  ipcMain.handle(chatChannels.call, async (event, value: unknown) => {
    try {
      requireTrusted(event);
      const v = chatRecord(value);
      if (v.kind === 'targets') {
        fields(v, ['kind']);
        return { ok: true, value: targets };
      }
      if (typeof v.backendId !== 'string' || !targets.some((target) => target.id === v.backendId))
        throw new ApplicationError({
          code: 'Unauthorized',
          message: 'Choose an installed chat target.',
        });
      const backendId = v.backendId;
      if (backendId === 'local' && !local && v.kind === 'context') {
        localRetry ??= (async () => {
          localResult = await acquireLocalChat(runtime, userData, (url) =>
            shell.openExternal(url),
          ).then(
            (backend) => ({ backend, error: null }),
            () => ({
              backend: null,
              error:
                localResult.error ??
                new ApplicationError({
                  code: 'Unavailable',
                  message:
                    'Local Pi could not initialize. Preserve its files and restart Moonbase.',
                }),
            }),
          );
          local = localResult.backend;
          if (local) {
            targets[0] = { ...targets[0], context: local.session };
            installChatSessions();
          }
        })().finally(() => {
          localRetry = undefined;
        });
        await localRetry;
      }
      if (backendId === 'local' && !local && v.kind !== 'confirm-quit') throw localResult.error;
      if (v.kind === 'context') {
        fields(v, ['kind', 'backendId']);
        return { ok: true, value: targets.find((target) => target.id === backendId)!.context };
      }
      if (v.kind === 'choose-folder') {
        fields(v, ['kind', 'backendId']);
        if (backendId !== 'local' || !local || quit || terminating)
          throw new ApplicationError({
            code: 'Unavailable',
            message: 'Folder selection is unavailable.',
          });
        const owner = documentId;
        const selection = await dialog.showOpenDialog(window, {
          title: 'Choose a local chat working folder',
          properties: ['openDirectory'],
        });
        if (owner !== documentId || selection.canceled || !selection.filePaths[0])
          return { ok: true, value: null };
        return { ok: true, value: await local.approveFolder(selection.filePaths[0]) };
      }
      if (v.kind === 'confirm-quit') {
        fields(v, ['kind', 'backendId']);
        if (backendId !== 'local' || quit?.stage !== 'preserve')
          throw new ApplicationError({
            code: 'Unavailable',
            message: 'No active Quit preparation.',
          });
        return { ok: true, value: await confirmLocalQuit() };
      }
      fields(v, ['kind', 'operation', 'input', 'id', 'backendId']);
      const owner = sessions.get(backendId);
      if (!owner)
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'This chat target is unavailable.',
        });
      return await owner.call(v.kind, v.operation, v.input, v.id);
    } catch (error) {
      return chatError(error);
    }
  });
  ipcMain.handle(chatChannels.cancel, async (event, value: unknown) => {
    try {
      requireTrusted(event);
      const v = chatRecord(value);
      fields(v, ['id', 'backendId']);
      const owner = typeof v.backendId === 'string' ? sessions.get(v.backendId) : undefined;
      if (!owner)
        throw new ApplicationError({ code: 'Unauthorized', message: 'Unknown chat backend.' });
      const reply = await owner.cancel(v.id);
      if (!reply.ok) reportCleanup(Promise.reject(new ApplicationError(reply.error)));
      return reply;
    } catch (error) {
      return chatError(error);
    }
  });
  const backgroundFailures: unknown[] = [];
  const reportCleanup = (cleanup: Promise<void>) => {
    void cleanup.catch((error) => {
      if (backgroundFailures.length < 8) backgroundFailures.push(error);
      if (rendererReady && !window.isDestroyed())
        window.webContents.send(channels.action, 'cleanup-error', randomUUID(), {
          ...errorDTO(error),
          message: normalizeApplicationError(error).message.slice(0, 512),
        });
      console.error('Document cleanup failed:', normalizeApplicationError(error).message);
    });
  };
  let quit: { id: string; stage: 'preserve' | 'dispose'; localConfirmed?: boolean } | undefined,
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
  async function confirmLocalQuit(): Promise<boolean> {
    if (!local || quit?.localConfirmed) return true;
    const owner = documentId,
      intent = quit;
    const current = () => owner === documentId && intent === quit;
    local.control.setAdmissionsOpen(false);
    try {
      const active = await runApplicationEffect(runtime, local.control.hasActiveWork());
      if (!current()) return false;
      const decision = active
        ? await dialog.showMessageBox(window, {
            type: 'question',
            message: 'Local agents are still working.',
            detail:
              'Keep Moonbase open to continue, or quit and release local Pi. Reopening follows saved-task recovery; external tool effects cannot be rolled back. Remote work continues.',
            buttons: ['Keep running', 'Quit'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
        : { response: 1 };
      if (!current()) return false;
      const consent = decision.response === 1;
      if (!consent) local.control.setAdmissionsOpen(true);
      else if (intent) intent.localConfirmed = true;
      return consent;
    } catch (error) {
      if (current()) local.control.setAdmissionsOpen(true);
      throw error;
    }
  }
  async function finishQuit() {
    if (terminating) return;
    terminating = true;
    rendererReady = false;
    const failures: unknown[] = backgroundFailures.splice(0);
    for (const cleanup of [
      ...[...sessions.values()].map((session) => () => session.dispose()),
      () => editorSession.dispose(),
      () => runApplicationEffect(runtime, runtime.disposeEffect),
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
      ipcMain.removeHandler(channels.call);
      ipcMain.removeHandler(channels.cancel);
      ipcMain.removeAllListeners(channels.quit);
      ipcMain.removeAllListeners(channels.ready);
      ipcMain.removeHandler(channels.configured);
      ipcMain.removeHandler(chatChannels.call);
      ipcMain.removeHandler(chatChannels.cancel);
      window.destroy();
      protocol.unhandle('moonbase');
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
  ipcMain.on(channels.ready, (event) => {
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
  });
  ipcMain.on(channels.quit, async (event, value: unknown) => {
    const owner = documentId,
      intent = quit;
    try {
      requireTrusted(event);
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
        backgroundFailures.push(error);
      }
      if (quit.stage === 'dispose' && !v.consent)
        throw new ApplicationError({
          code: 'InvalidInput',
          message: 'Disposal cannot return to the live workbench.',
        });
      if (!v.consent) {
        local?.control.setAdmissionsOpen(true);
        quit = undefined;
        quitRequested = false;
        show();
        return;
      }
      if (quit.stage === 'preserve') {
        const consent = await confirmLocalQuit();
        if (owner !== documentId || intent !== quit) return;
        if (!consent) {
          quit = undefined;
          quitRequested = false;
          show();
          return;
        }
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
      local?.control.setAdmissionsOpen(true);
      quit = undefined;
      show();
      console.error('Quit failed:', normalizeApplicationError(error).message);
    }
  });
  window.on('close', (event) => {
    if (!exiting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  window.webContents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
    if (!isMainFrame) return;
    rendererReady = false;
    // A replacement document must prepare its own application before acknowledging Quit.
    quit = undefined;
    reportCleanup(editorSession.releaseDocument());
    reportCleanup(releaseChatDocument());
  });
  window.webContents.on('render-process-gone', async (_event, details) => {
    if (terminating || exiting) return;
    reportCleanup(editorSession.releaseDocument());
    reportCleanup(releaseChatDocument());
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
    let consent = false;
    if (recovery.response !== 0) {
      try {
        consent = await confirmLocalQuit();
      } catch (error) {
        reportCleanup(Promise.reject(error));
      }
    }
    if (owner !== documentId || terminating || exiting) return;
    if (recovery.response === 0 || !consent) {
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
  window.once('ready-to-show', show);
  await window.loadURL(appURL);
}
void main().catch((error) => {
  console.error(normalizeApplicationError(error).message);
  app.exit(1);
});
