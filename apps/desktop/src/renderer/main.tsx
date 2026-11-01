import { createRoot } from "react-dom/client";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Button } from "@base-ui/react/button";
import * as stylex from "@stylexjs/stylex";
import { EditorWorkbench, createEditor, type EditorWorkbenchHandle } from "@moonbase/editor";
import { configureMonacoWorkers } from "@moonbase/editor/workers";
import { controls } from "@moonbase/ui/controls";
import { colors, space } from "@moonbase/ui/tokens.stylex";
import { bridgeClient, unwrap, type DesktopBridge } from "../wire.ts";
import "@moonbase/ui/reset.css";
import "virtual:stylex:runtime";

declare global { interface Window { moonbase: DesktopBridge } }
configureMonacoWorkers();
const bridge = window.moonbase, controller = createEditor({ client: bridgeClient(bridge), clientId: bridge.clientId });
const root = createRoot(document.getElementById("root")!);
const styles = stylex.create({
  shell: { height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", backgroundColor: colors.canvas, color: colors.text },
  toolbar: { display: "flex", alignItems: "center", gap: space.sm, padding: space.sm, flexWrap: "wrap", borderBottomWidth: 1, borderBottomStyle: "solid", borderBottomColor: colors.border, backgroundColor: colors.chrome },
  title: { flex: 1, minWidth: 80 },
  editor: { flex: 1, minHeight: 0, overflow: "hidden" },
});
function Desktop() {
  const handle = useRef<EditorWorkbenchHandle>(null), state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const selected = state.recovery.checkouts.find(c => c.checkoutId === state.recovery.selectedCheckoutId);
  useEffect(() => bridge.actions((action, id) => {
    if (action === "quit") void (async () => { try { bridge.quitResult(id, await handle.current?.prepareQuit() ?? false); } catch (error) { controller.report(error); bridge.quitResult(id, false); } })();
    if (action === "dispose") { controller.dispose(); root.unmount(); bridge.quitResult(id, true); }
  }), []);
  const run = (task: Promise<unknown>) => { void task.catch(controller.report); };
  return <main {...stylex.props(styles.shell)} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault(); if (!selected) { controller.report(Error("Open a checkout before importing files.")); return; }
    run((async () => { const refs = unwrap(await bridge.drop(selected, [...event.dataTransfer.files])); if (refs.length) await controller.mutate({ checkout: selected, kind: "import", sources: [], destination: "", nativeReferences: refs }); })());
  }}>
    <header {...stylex.props(styles.toolbar)}><strong {...stylex.props(styles.title)}>Moonbase</strong>
      <span role="status">{state.preserving ? "Preserving edits…" : state.publication ? "Recovery confirmation pending" : "Explicit Save · Local workspace"}</span>
      <Button {...stylex.props(controls.button)} disabled={!selected || state.preserving} onClick={() => { if (selected) run((async () => {
        const refs = unwrap<string[]>(await bridge.call("clipboard-imports", { checkout: selected }, crypto.randomUUID()) as never);
        if (refs.length) await controller.mutate({ checkout: selected, kind: "import", sources: [], destination: "", nativeReferences: refs });
      })()); }}>Import clipboard files</Button>
    </header>
    <section {...stylex.props(styles.editor)} aria-label="Editor workbench"><EditorWorkbench ref={handle} controller={controller}
      selectCheckout={async () => unwrap(await bridge.call("choose-checkout", null, crypto.randomUUID())) as string | null}
      selectNativeImports={async checkout => unwrap(await bridge.call("choose-imports", { checkout }, crypto.randomUUID())) as string[]} /></section>
  </main>;
}
root.render(<Desktop />);
await controller.load().catch(controller.report);
