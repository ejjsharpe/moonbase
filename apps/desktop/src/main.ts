import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, session, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { ManagedRuntime, Effect, Layer } from "effect";
import { WorkspaceLive, WorkspaceNative } from "@moonbase/workspace";
import { makeEditorClient, makeChatClient, makeConnectionClient } from "@moonbase/application/runtime-client";
import { ApplicationError, type CheckoutTarget } from "@moonbase/application/client";
import { randomUUID } from "node:crypto";
import { realpathSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { EditorSession } from "./session.ts";
import { channels, errorDTO, keys, record, requestId } from "./wire.ts";

import { RemoteChatLive } from "@moonbase/pi-runtime/remote";
import { SshLive } from "@moonbase/ssh";
import { readConfiguration } from "@moonbase/chat-probe/native-config";
import { ProofSession } from "@moonbase/chat-probe/native-session";
import { channels as chatChannels, record as chatRecord, fields, errorDTO as chatError } from "@moonbase/chat-probe/bridge";

const directory = fileURLToPath(new URL(".", import.meta.url));

function coordinateQuit({ window, requireTrusted, show, dispose, releaseDocument }: {
  window: BrowserWindow;
  requireTrusted: (event: IpcMainEvent | IpcMainInvokeEvent) => void;
  show: () => void;
  dispose: () => Promise<void>;
  releaseDocument: () => void;
}) {
  let quit: { id: string; stage: "preserve" | "dispose" } | undefined;
  let exiting = false, rendererReady = false, quitRequested = false;
  function requestQuit() {
    quitRequested = true;
    show();
    if (!rendererReady || quit) return;
    quit = { id: randomUUID(), stage: "preserve" };
    window.webContents.send(channels.action, "quit", quit.id);
  }
  ipcMain.on(channels.ready, event => {
    try {
      requireTrusted(event);
      rendererReady = true;
      if (quitRequested) requestQuit();
    } catch (error) { console.error(ApplicationError.fromUnknown(error).message); }
  });
  ipcMain.on(channels.quit, async (event, value: unknown) => {
    try {
      requireTrusted(event);
      const v = record(value);
      keys(v, ["id", "consent"]);
      requestId(v.id);
      if (!quit || v.id !== quit.id || typeof v.consent !== "boolean") throw new ApplicationError({ code: "Unauthorized", message: "No matching Quit request." });
      if (!v.consent) {
        quit = undefined;
        quitRequested = false;
        show();
        return;
      }
      if (quit.stage === "preserve") {
        quit = { id: randomUUID(), stage: "dispose" };
        window.webContents.send(channels.action, "dispose", quit.id);
        return;
      }
      await dispose();
      exiting = true;
      ipcMain.removeHandler(channels.call); ipcMain.removeAllListeners(channels.cancel); ipcMain.removeAllListeners(channels.quit); ipcMain.removeAllListeners(channels.ready);
      ipcMain.removeHandler(channels.configured); ipcMain.removeHandler(chatChannels.call); ipcMain.removeAllListeners(chatChannels.cancel);
      window.destroy(); protocol.unhandle("moonbase"); app.quit();
    } catch (error) { quit = undefined; show(); console.error("Quit failed:", ApplicationError.fromUnknown(error).message); }
  });
  window.on("close", event => { if (!exiting) { event.preventDefault(); window.hide(); } });
  window.webContents.on("render-process-gone", (_event, details) => {
    releaseDocument(); rendererReady = false; quit = undefined; quitRequested = false;
    console.error("Workbench renderer exited:", details.reason);
  });
  app.on("before-quit", event => { if (!exiting) { event.preventDefault(); requestQuit(); } });
  return requestQuit;
}

async function main() {
  const requestedData = process.env.MOONBASE_USER_DATA ?? (app.isPackaged ? join(app.getPath("appData"), "Moonbase") : undefined);
  if (!requestedData || !isAbsolute(requestedData)) throw Error("Set MOONBASE_USER_DATA to an explicit new Moonbase user-data directory.");
  mkdirSync(requestedData, { recursive: true, mode: 0o700 });
  const userData = realpathSync(requestedData); app.setPath("userData", userData);
  app.setName("Moonbase");
  if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
  protocol.registerSchemesAsPrivileged([{ scheme: "moonbase", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
  const appURL = "moonbase://editor/index.html";
  const csp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
  await app.whenReady();
  const assets = app.isPackaged ? join(process.resourcesPath, "workspace") : join(directory, "workspace");
  const chatConfiguration = process.env.MOONBASE_CHAT_CONFIG === undefined ? null : await readConfiguration(process.env.MOONBASE_CHAT_CONFIG);
  const workspace = WorkspaceLive({ hostId: "moonbase-local", dataDirectory: join(userData, "workspace-v1"), filesystemHelper: join(assets, "filesystem"), ripgrepExecutable: join(assets, "ripgrep/rg"), gitExecutable: "/usr/bin/git" });
  // Exactly one of these capability sets is acquired, once for this process.
  const root = chatConfiguration ? (() => {
    const runtime = ManagedRuntime.make(Layer.merge(workspace, RemoteChatLive.pipe(Layer.provideMerge(SshLive(chatConfiguration.ssh)))));
    return { runtime, chat: makeChatClient(runtime), connection: makeConnectionClient(runtime) };
  })() : { runtime: ManagedRuntime.make(workspace), chat: null, connection: null };
  const { runtime, chat, connection } = root;
  const client = makeEditorClient(runtime);
  // Acquire once now so SQLite/runtime incompatibility is visible before showing the editor.
  await runtime.runPromise(Effect.asVoid(WorkspaceNative));
  if (connection) await connection.command("getConnection", {}); // Acquire without connecting.
  const rendererRoot = join(directory, "renderer");
  protocol.handle("moonbase", async request => {
    const url = new URL(request.url);
    // Asset cache-busting queries do not grant document/IPC authority.
    const path = resolve(rendererRoot, "." + decodeURIComponent(url.pathname));
    if (url.host !== "editor" || url.hash || path !== rendererRoot && !path.startsWith(rendererRoot + sep)) return new Response("Forbidden", { status: 403 });
    try {
      const response = await net.fetch(pathToFileURL(path).href);
      const headers = new Headers(response.headers); headers.set("Content-Security-Policy", csp); headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch { return new Response("Not found", { status: 404 }); }
  });
  const window = new BrowserWindow({ title: "Moonbase", width: 1280, height: 850, minWidth: 600, minHeight: 480, show: false,
    webPreferences: { preload: join(directory, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged, spellcheck: false },
  });
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === appURL;
  const requireTrusted = (event: IpcMainEvent | IpcMainInvokeEvent) => { if (!trusted(event)) throw new ApplicationError({ code: "Unauthorized", message: "Untrusted renderer frame/document." }); };
  const native = {
    async chooseCheckout() { const result = await dialog.showOpenDialog(window, { title: "Open a Git checkout", properties: ["openDirectory"] }); return result.canceled ? null : result.filePaths[0] ?? null; },
    async imports(checkout: CheckoutTarget, kind: "picker" | "clipboard", paths?: string[]) {
      if (!paths && kind === "picker") { const result = await dialog.showOpenDialog(window, { title: "Import files into " + checkout.root, properties: ["openFile", "openDirectory", "multiSelections"] }); if (result.canceled) return []; paths = result.filePaths; }
      if (kind === "clipboard") {
        const consent = await dialog.showMessageBox(window, { type: "question", message: "Import clipboard files?", detail: "Copy files from Finder, then confirm import into " + checkout.root, buttons: ["Cancel", "Import files"], defaultId: 0, cancelId: 0 });
        if (consent.response !== 1) return [];
        const items = await clipboard.read();
        const item = items.find(item => item.types.some(type => type.includes("NSFilenamesPboardType")));
        const format = item?.types.find(type => type.includes("NSFilenamesPboardType"));
        const payload = item && format ? await item.getType(format) : undefined;
        const bytes = payload && "arrayBuffer" in payload ? Buffer.from(await payload.arrayBuffer()) : Buffer.alloc(0);
        if (!bytes.length) throw new ApplicationError({ code: "InvalidInput", message: "Clipboard contains no Finder files." });
        const parsed: unknown = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: bytes, maxBuffer: 2 ** 20 }).toString());
        if (!Array.isArray(parsed) || parsed.some(p => typeof p !== "string")) throw new ApplicationError({ code: "InvalidInput", message: "Invalid Finder file list." });
        paths = parsed;
      }
      if (!paths?.length) return [];
      return runtime.runPromise(Effect.flatMap(WorkspaceNative, service => service.capture({ checkout, clientId: "desktop-primary", paths })));
    },
  };
  const editorSession = new EditorSession(client, native, (id, value) => { if (!window.isDestroyed()) window.webContents.send(channels.event, id, value); });
  ipcMain.handle(channels.call, async (event, value: unknown) => {
    try { requireTrusted(event); const v = record(value); keys(v, ["method", "input", "id"]); return await editorSession.call(v.method, v.input, v.id); }
    catch (error) { return { ok: false, error: errorDTO(error) }; }
  });
  ipcMain.on(channels.cancel, (event, id: unknown) => { try { requireTrusted(event); editorSession.cancel(id); } catch (e) { console.error(ApplicationError.fromUnknown(e).message); } });
  const chatSession = chatConfiguration && chat && connection ? new ProofSession(chat, connection, chatConfiguration.context,
    (id, result) => { if (!window.isDestroyed()) window.webContents.send(chatChannels.event, id, result); }) : null;
  ipcMain.handle(channels.configured, (event, ...args: unknown[]) => {
    try { requireTrusted(event); if (args.length !== 1 || args[0] !== null) throw new ApplicationError({ code: "InvalidInput", message: "Unexpected configuration query input." }); return { ok: true, value: chatSession !== null }; }
    catch (error) { return { ok: false, error: errorDTO(error) }; }
  });
  ipcMain.handle(chatChannels.call, async (event, value: unknown) => {
    try {
      requireTrusted(event);
      const v = chatRecord(value);
      if (v.kind === "context") {
        fields(v, ["kind"]);
        if (!chatSession) throw new ApplicationError({ code: "Unavailable", message: "Remote chat is not configured. Launch with an explicit MOONBASE_CHAT_CONFIG to use a host. Local editing is available." });
        return { ok: true, value: chatSession.context };
      }
      fields(v, ["kind", "operation", "input", "id"]);
      if (!chatSession) throw new ApplicationError({ code: "Unavailable", message: "Remote chat is not configured." });
      return await chatSession.call(v.kind, v.operation, v.input, v.id);
    } catch (error) { return chatError(error); }
  });
  ipcMain.on(chatChannels.cancel, (event, id: unknown) => { try { requireTrusted(event); chatSession?.cancel(id); } catch (error) { console.error(ApplicationError.fromUnknown(error).message); } });
  function show() { if (!window.isDestroyed()) { window.show(); window.focus(); } }
  const requestQuit = coordinateQuit({
    window, requireTrusted, show,
    releaseDocument: () => { editorSession.releaseDocument(); chatSession?.dispose(); },
    dispose: async () => {
      chatSession?.dispose(); editorSession.dispose(); await runtime.dispose();
    },
  });
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-frame-navigate", event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on("activate", show);
  app.on("second-instance", show);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Moonbase", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { label: "Quit Moonbase", accelerator: "CmdOrCtrl+Q", click: requestQuit }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { label: "Show workbench", click: show }, { label: "Hide workbench", accelerator: "CmdOrCtrl+Shift+H", click: () => window.hide() }] },
    { role: "windowMenu" },
  ]));
  window.once("ready-to-show", show);
  await window.loadURL(appURL);

}
void main().catch(error => { console.error(error); app.exit(1); });
