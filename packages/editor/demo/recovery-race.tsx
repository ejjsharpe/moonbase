import { createRoot } from "react-dom/client";
import { ManagedRuntime } from "effect";
import { ApplicationError, type CommandInput } from "@moonbase/application/client";
import { makeEditorClient } from "@moonbase/application/runtime-client";
import { EditorWorkbench, createEditor } from "../src/index.ts";
import { configureMonacoWorkers } from "../src/workers.ts";
import { memoryWorkspace } from "../src/memory.ts";
import "@moonbase/ui/reset.css";
import "virtual:stylex:runtime";

configureMonacoWorkers();
const alpha = { hostId: "memory", checkoutId: "alpha", projectId: "race", root: "/race/alpha", branch: "main" };
const beta = { ...alpha, checkoutId: "beta", root: "/race/beta" };
const memory = memoryWorkspace([alpha, beta].map(checkout => ({ checkout, files: { "a.ts": "current A", "b.ts": "current B" } })));
const runtime = ManagedRuntime.make(memory.layer), client = makeEditorClient(runtime);
const seed = createEditor({ client, clientId: "recovery-race" }); await seed.load();
await seed.openCheckout(beta.root); await seed.open({ checkout: beta, path: "a.ts" });
await seed.openCheckout(alpha.root); await seed.open({ checkout: alpha, path: "a.ts" }); await seed.open({ checkout: alpha, path: "b.ts" });
await seed.flush(); seed.dispose();
let loseFinal = false, failStatus = false;
let hold = false, waiting = false, release!: () => void;
const wait = new Promise<void>(resolve => { release = resolve; });
const editor = createEditor({ clientId: "recovery-race", client: { ...client, async command(name, input, options) {
  if (hold && name === "persistRecovery") { waiting = true; await wait; }
  if (loseFinal && name === "persistRecovery" && !(input as CommandInput<"persistRecovery">).state.views.alpha.openFiles.includes("b.ts")) {
    loseFinal = false; failStatus = true; await client.command(name, input, options);
    throw new ApplicationError({ code: "Unavailable", message: "Controlled lost final close response" });
  }
  if (failStatus && name === "getRecoveryPublication") { failStatus = false; throw new ApplicationError({ code: "Unavailable", message: "Controlled status outage" }); }
  return client.command(name, input, options);
} } });
await editor.load();
createRoot(document.getElementById("root")!).render(<div style={{ height: "100vh" }}><EditorWorkbench controller={editor} /></div>);
declare global { interface Window { recoveryRace: { editor: typeof editor; hold(): void; release(): void; loseFinalResponse(): void; readonly waiting: boolean;
  load(): ReturnType<typeof client.command<"loadRecovery">> } } }
window.recoveryRace = { editor, hold() { hold = true; }, release, loseFinalResponse() { loseFinal = true; }, get waiting() { return waiting; }, load: () => client.command("loadRecovery", { clientId: editor.clientId }) };
window.addEventListener("pagehide", () => { editor.dispose(); void runtime.dispose(); }, { once: true });
