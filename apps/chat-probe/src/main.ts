import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { ManagedRuntime, Layer } from "effect";
import { makeChatClient, makeConnectionClient } from "@moonbase/application/runtime-client";
import { RemoteChatLive } from "@moonbase/pi-runtime/remote";
import { SshLive } from "@moonbase/ssh";
import { ApplicationError } from "@moonbase/application/client";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readConfiguration, dataDirectory } from "./config.ts";
import { ProofSession } from "./session.ts";
import { channels, record, fields, requestId, errorDTO } from "./wire.ts";

// Electron requires scheme privileges before any asynchronous bootstrap can reach app.ready.
protocol.registerSchemesAsPrivileged([
  { scheme: "moonbase-chat", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

async function main() {
  const config = await readConfiguration(process.env.MOONBASE_CHAT_CONFIG),
    data = await dataDirectory(process.env.MOONBASE_CHAT_DATA);
  app.setPath("userData", data);
  app.setName("Moonbase Chat");
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  await app.whenReady();
  const runtime = ManagedRuntime.make(RemoteChatLive.pipe(Layer.provideMerge(SshLive(config.ssh))));
  const chat = makeChatClient(runtime),
    connection = makeConnectionClient(runtime);
  await connection.command("getConnection", {}); // Validate/acquire once, without starting SSH.
  const directory = fileURLToPath(new URL(".", import.meta.url)),
    rendererRoot = join(directory, "renderer"),
    appURL = "moonbase-chat://chat/index.html";
  protocol.handle("moonbase-chat", async (request) => {
    const url = new URL(request.url);
    let path: string;
    try {
      path = resolve(rendererRoot, "." + decodeURIComponent(url.pathname));
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    if (
      url.host !== "chat" ||
      url.hash ||
      (path !== rendererRoot && !path.startsWith(rendererRoot + sep))
    )
      return new Response("Forbidden", { status: 403 });
    try {
      const response = await net.fetch(pathToFileURL(path).href);
      const headers = new Headers(response.headers);
      headers.set(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'",
      );
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  const window = new BrowserWindow({
    title: "Moonbase Chat",
    width: 1180,
    height: 820,
    minWidth: 640,
    minHeight: 560,
    show: false,
    webPreferences: {
      preload: join(directory, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent) =>
    !window.isDestroyed() &&
    e.sender === window.webContents &&
    e.senderFrame === window.webContents.mainFrame &&
    e.senderFrame.url === appURL;
  const requireTrusted = (e: IpcMainEvent | IpcMainInvokeEvent) => {
    if (!trusted(e))
      throw new ApplicationError({
        code: "Unauthorized",
        message: "Untrusted chat frame or document.",
      });
  };
  const owner = new ProofSession(chat, connection, config.context, (id, result) => {
    if (!window.isDestroyed()) window.webContents.send(channels.event, id, result);
  });
  ipcMain.handle(channels.call, async (e, value: unknown) => {
    try {
      requireTrusted(e);
      const v = record(value);
      if (v.kind === "context") {
        fields(v, ["kind"]);
        return { ok: true, value: config.context };
      }
      fields(v, ["kind", "operation", "input", "id"]);
      return await owner.call(v.kind, v.operation, v.input, v.id);
    } catch (error) {
      return errorDTO(error);
    }
  });
  ipcMain.on(channels.cancel, (e, id: unknown) => {
    try {
      requireTrusted(e);
      owner.cancel(id);
    } catch {
      /* No private IPC payloads in logs. */
    }
  });
  let quitting = false,
    ready = false,
    requested = false,
    quitId: string | undefined;
  const show = () => {
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
  };
  const requestQuit = () => {
    requested = true;
    show();
    if (ready && !quitId) {
      quitId = randomUUID();
      window.webContents.send(channels.quit, quitId);
    }
  };
  ipcMain.on(channels.ready, (e) => {
    try {
      requireTrusted(e);
      ready = true;
      if (requested) requestQuit();
    } catch {}
  });
  ipcMain.on(channels.consent, async (e, value: unknown) => {
    try {
      requireTrusted(e);
      const v = record(value);
      fields(v, ["id", "preserved"]);
      requestId(v.id);
      if (v.id !== quitId || typeof v.preserved !== "boolean") return;
      if (!v.preserved) {
        quitId = undefined;
        requested = false;
        show();
        return;
      }
      owner.dispose();
      await runtime.dispose();
      quitting = true;
      window.destroy();
      protocol.unhandle("moonbase-chat");
      app.quit();
    } catch {
      quitId = undefined;
      requested = false;
      show();
      console.error("Chat cleanup failed; Quit remains pending.");
    }
  });
  window.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      window.hide();
    }
  });
  window.webContents.on("did-start-navigation", (_e, _url, _inPlace, isMain) => {
    if (isMain) {
      ready = false;
      owner.dispose();
    }
  });
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.on("will-frame-navigate", (e) => e.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (e) => e.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window.webContents.on("render-process-gone", () => {
    ready = false;
    owner.dispose();
  });
  app.on("before-quit", (e) => {
    if (!quitting) {
      e.preventDefault();
      requestQuit();
    }
  });
  app.on("activate", show);
  app.on("second-instance", show);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "Moonbase Chat",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { label: "Quit Moonbase Chat", accelerator: "CmdOrCtrl+Q", click: requestQuit },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { label: "Show Chat", click: show },
          { label: "Hide Chat", click: () => window.hide() },
        ],
      },
    ]),
  );
  window.once("ready-to-show", show);
  await window.loadURL(appURL);
}
void main().catch(() => {
  console.error(
    "Chat proof startup failed. Check private configuration permissions, explicit user-data path and installed runtime.",
  );
  app.exit(1);
});
