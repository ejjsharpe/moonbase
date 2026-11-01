import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { ChatProof, createChatProof } from "@moonbase/chat-probe/ui";
import { browserClients, type ChatBridge } from "@moonbase/chat-probe/bridge";
import { Button } from "@base-ui/react/button";
import * as stylex from "@stylexjs/stylex";
import { EditorWorkbench, createEditor, type EditorWorkbenchHandle } from "@moonbase/editor";
import { configureMonacoWorkers } from "@moonbase/editor/workers";
import { controls } from "@moonbase/ui/controls";
import { workbench } from "@moonbase/ui/workbench";
import { colors, space } from "@moonbase/ui/tokens.stylex";
import { bridgeClient, unwrap, type DesktopBridge } from "../wire.ts";
import "@moonbase/ui/reset.css";

declare global { interface Window { moonbase: DesktopBridge; moonbaseChat: ChatBridge } }
document.body.className = stylex.props(workbench.document).className ?? "";
configureMonacoWorkers();
const bridge = window.moonbase, controller = createEditor({ client: bridgeClient(bridge), clientId: bridge.clientId });
const root = createRoot(document.getElementById("root")!);
const loaded = controller.load().catch(controller.report);
let chatError = "", chatInitializationFailed = false;
const chat = await (async () => {
  try {
    const configured = unwrap(await bridge.chatConfigured());
    if (!configured) { chatError = "Remote chat is not configured. Launch with an explicit MOONBASE_CHAT_CONFIG to use a host. Local editing is available."; return null; }
    const context = await window.moonbaseChat.context();
    return createChatProof({ ...browserClients(window.moonbaseChat), context, storage: localStorage });
  } catch (error) { chatInitializationFailed = true; chatError = error instanceof Error ? error.message : "Chat could not initialize. Preserve this user-data directory."; return null; }
})();
window.addEventListener("beforeunload", event => { if (chatInitializationFailed || chat && !chat.preserve()) { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("visibilitychange", () => { if (document.hidden) chat?.detach(); else void chat?.start(); });
const styles = stylex.create({
  shell: { height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", backgroundColor: colors.canvas, color: colors.text },
  toolbar: { display: "flex", alignItems: "center", gap: space.sm, padding: space.sm, flexWrap: "wrap", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: colors.border, backgroundColor: colors.chrome },
  title: { flex: 1, minWidth: 80 },
  editor: { flex: 1, minHeight: 0, overflow: "hidden" },
  panel: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" },
  empty: { padding: space.lg, maxWidth: 740 },
});
function Desktop() {
  const [closing, setClosing] = useState(false), [view, setView] = useState("editor");
  const panels = useRef<Record<string, HTMLElement | null>>({}), focus = useRef<Record<string, HTMLElement | null>>({});
  const currentView = useRef(view); currentView.current = view;
  const handle = useRef<EditorWorkbenchHandle>(null), state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const selected = state.recovery.checkouts.find(c => c.checkoutId === state.recovery.selectedCheckoutId);
  useEffect(() => { const stop = bridge.actions((action, id) => {
    if (action === "quit") void (async () => { try { if (chatInitializationFailed || chat && !chat.preserve()) { setView("chat"); bridge.quitResult(id, false); return; }
      // Check chat before destructive editor choices, then preserve any newer draft after them.
      setView("editor");
      const consent = (await handle.current?.prepareQuit() ?? false) && (chat?.preserve() ?? true);
      if (!consent && chat?.getSnapshot().storageError) setView("chat"); if (consent) flushSync(() => setClosing(true)); bridge.quitResult(id, consent); } catch (error) { controller.report(error); bridge.quitResult(id, false); } })();
    if (action === "dispose") { chat?.dispose(); controller.dispose(); root.unmount(); bridge.quitResult(id, true); }
  }); void loaded.then(() => bridge.ready()); return stop; }, []);
  const run = (task: Promise<unknown>) => { void task.catch(controller.report); };
  return <Tabs.Root value={view} onValueChange={(value, details) => {
    const next = String(value); setView(next);
    if (details.event.type === "click") requestAnimationFrame(() => requestAnimationFrame(() => {
      const element = focus.current[next]; if (currentView.current === next && element?.isConnected && panels.current[next]?.contains(element)) element.focus();
    }));
  }} inert={closing} {...stylex.props(workbench.document, styles.shell)} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => {
    if (view !== "editor" || !event.dataTransfer.files.length) return;
    event.preventDefault(); if (!selected) { controller.report(Error("Open a checkout before importing files.")); return; }
    run((async () => { const refs = unwrap(await bridge.drop(selected, [...event.dataTransfer.files])); if (refs.length) handle.current?.importFiles(selected, refs); })());
  }}>
    <header {...stylex.props(styles.toolbar)}><strong {...stylex.props(styles.title)}>Moonbase</strong>
      <Tabs.List aria-label="Workbench views" {...stylex.props(controls.row)}>
        <Tabs.Tab value="editor" {...stylex.props(controls.button, view === "editor" && workbench.fileSelected)}>Editor</Tabs.Tab>
        <Tabs.Tab value="chat" {...stylex.props(controls.button, view === "chat" && workbench.fileSelected)}>Chat</Tabs.Tab>
      </Tabs.List>
      <span role="status">{closing ? "Closing workbench…" : state.preserving ? "Preserving edits…" : state.publication ? "Recovery confirmation pending" : view === "editor" ? "Explicit Save · Local workspace" : "Remote host · Explicit Connect and Send"}</span>
      <Button hidden={view !== "editor"} {...stylex.props(controls.button)} disabled={!selected || state.preserving} onClick={() => { if (selected) run((async () => {
        const refs = unwrap<string[]>(await bridge.call("clipboard-imports", { checkout: selected }, crypto.randomUUID()) as never);
        if (refs.length) handle.current?.importFiles(selected, refs);
      })()); }}>Import clipboard files</Button>
    </header>
    <Tabs.Panel value="editor" keepMounted ref={element => { panels.current.editor = element; }} onFocusCapture={event => { focus.current.editor = event.target as HTMLElement; }} {...stylex.props(styles.panel)}>
    <section {...stylex.props(styles.editor)} aria-label="Editor workbench"><EditorWorkbench ref={handle} controller={controller}
      selectCheckout={async () => unwrap(await bridge.call("choose-checkout", null, crypto.randomUUID())) as string | null}
      selectNativeImports={async checkout => unwrap(await bridge.call("choose-imports", { checkout }, crypto.randomUUID())) as string[]} /></section>
    </Tabs.Panel>
    <Tabs.Panel value="chat" keepMounted ref={element => { panels.current.chat = element; }} onFocusCapture={event => { focus.current.chat = event.target as HTMLElement; }} {...stylex.props(styles.panel)}>
      {chat ? <ChatProof controller={chat} /> : <section {...stylex.props(styles.empty)} aria-label="Remote chat configuration"><h1>Remote chat is unavailable</h1><p role="status">{chatError}</p><p>Local checkouts remain on this computer. Remote paths are descriptive; they do not open or synchronize local files.</p></section>}
    </Tabs.Panel>
  </Tabs.Root>;
}
root.render(<Desktop />);
await loaded;
