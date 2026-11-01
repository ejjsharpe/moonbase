import { ApplicationError, type CheckoutTarget, type EditorClient, type WorkspaceCommand, type WorkspaceEvent } from "@moonbase/application/client";
import { checkout, commandFields, errorDTO, invalid, keys, record, requestId, string, type Reply } from "./wire.ts";

const exact = (a: CheckoutTarget, b: CheckoutTarget) => ["hostId", "checkoutId", "projectId", "root", "branch"].every(k => a[k as keyof CheckoutTarget] === b[k as keyof CheckoutTarget]);
export type NativeActions = {
  chooseCheckout(): Promise<string | null>;
  imports(target: CheckoutTarget, kind: "picker" | "clipboard", paths?: string[]): Promise<string[]>;
};
/** Authority belongs to this main-frame session, never to an arbitrary renderer root or caller ID. */
export class EditorSession {
  readonly clientId = "desktop-primary";
  private known = new Map<string, CheckoutTarget>();
  private rootGrants = new Set<string>();
  private operations = new Set<string>();
  private active = new Map<string, () => void>();
  private closed = false;
  private client: EditorClient;
  private native: NativeActions;
  private send: (id: string, result: Reply<WorkspaceEvent>) => void;
  constructor(client: EditorClient, native: NativeActions, send: (id: string, result: Reply<WorkspaceEvent>) => void) { this.client = client; this.native = native; this.send = send; }
  private own(value: unknown) { if (value !== this.clientId) throw new ApplicationError({ code: "Unauthorized", message: "Foreign editor identity." }); }
  private approved(value: unknown) {
    checkout(value); const known = this.known.get(value.checkoutId);
    if (!known || !exact(known, value)) throw new ApplicationError({ code: "Unauthorized", message: "Choose this exact checkout with the native picker." });
  }
  private inspect(value: unknown, depth = 0): void {
    if (depth > 24) invalid("Input nesting limit exceeded.");
    if (typeof value === "string") { if (value.length > 2 ** 24) invalid("Input too large."); return; }
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) { if (value.length > 8192) invalid("Input array too large."); for (const item of value) this.inspect(item, depth + 1); return; }
    const object = record(value);
    for (const [key, item] of Object.entries(object)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) invalid("Invalid object key.");
      if (key === "checkout") this.approved(item);
      if (key === "checkouts") { if (Array.isArray(item)) { for (const target of item) this.approved(target); } else invalid("Invalid checkout registry."); }
      this.inspect(item, depth + 1);
    }
  }
  private validate(operation: WorkspaceCommand, input: unknown) {
    const v = record(input), [allowed, required] = commandFields[operation]; keys(v, allowed, required ?? allowed);
    // Domain/path/state validation remains in WorkspaceService; this boundary additionally binds caller and approval.
    this.inspect(v);
    if (operation === "operationStatus") {
      requestId(v.clientId); requestId(v.id);
      if (v.clientId !== this.clientId && !this.operations.has(JSON.stringify([v.clientId, v.id]))) this.own(v.clientId);
    } else if ("clientId" in v) this.own(v.clientId);
    if (operation === "acknowledgeOperation") {
      requestId(v.operationClientId); requestId(v.id);
      if (v.operationClientId !== this.clientId && !this.operations.has(JSON.stringify([v.operationClientId, v.id]))) this.own(v.operationClientId);
    }
    if (operation === "persistRecovery") this.own(record(v.state).clientId);
    if (operation === "openCheckout") {
      string(v.root);
      if (!this.rootGrants.delete(v.root) && ![...this.known.values()].some(t => t.root === v.root)) throw new ApplicationError({ code: "Unauthorized", message: "A renderer path is not native root approval." });
    }
    return v;
  }
  async call(method: unknown, input: unknown, id: unknown): Promise<Reply> {
    let reserved = false, watching = false;
    try {
      requestId(id);
      if (this.closed) throw new ApplicationError({ code: "Unavailable", message: "Editor session disposed." });
      if (this.active.has(id)) invalid("Request is already active.");
      if (this.active.size >= 128) invalid("Too many active requests.");
      const abort = new AbortController(); this.active.set(id, () => abort.abort()); reserved = true;
      let value: unknown;
      if (method === "command") {
        const envelope = record(input); keys(envelope, ["operation", "input"]);
        if (typeof envelope.operation !== "string" || !Object.hasOwn(commandFields, envelope.operation)) invalid("Unknown application command.");
        const operation = envelope.operation as WorkspaceCommand;
        const validated = this.validate(operation, envelope.input);
        value = await this.client.command(operation, validated as never, { signal: abort.signal });
        if (operation === "openCheckout") { checkout(value); this.known.set(value.checkoutId, value); }
        if (operation === "loadRecovery") {
          const load = value as Awaited<ReturnType<EditorClient["command"]>> & {state: {checkouts: CheckoutTarget[]}; operations: {clientId: string; id: string}[]};
          for (const target of load.state.checkouts) { checkout(target); this.known.set(target.checkoutId, target); }
          for (const fact of load.operations) this.operations.add(JSON.stringify([fact.clientId, fact.id]));
        }
      } else if (method === "choose-checkout") {
        if (input !== null) invalid("Unexpected native picker input.");
        value = await this.native.chooseCheckout(); if (typeof value === "string") this.rootGrants.add(value);
      } else if (method === "choose-imports" || method === "clipboard-imports" || method === "dropped-imports") {
        const v = record(input); keys(v, method === "dropped-imports" ? ["checkout", "paths"] : ["checkout"]); this.approved(v.checkout);
        if (v.paths !== undefined && (!Array.isArray(v.paths) || v.paths.length > 256 || !v.paths.length || v.paths.some(p => typeof p !== "string" || p.length > 4096))) invalid("Invalid native drop.");
        value = await this.native.imports(v.checkout as CheckoutTarget, method === "clipboard-imports" ? "clipboard" : "picker", v.paths as string[] | undefined);
      } else if (method === "watch") {
        const v = record(input); keys(v, ["checkout", "paths"]); this.inspect(v); this.approved(v.checkout);
        if (!Array.isArray(v.paths) || v.paths.length > 8192 || v.paths.some(p => typeof p !== "string")) invalid("Invalid watch paths.");
        const stop = this.client.watch(v as never, event => { if (!this.closed && this.active.has(id)) this.send(id, { ok: true, value: event }); }, error => { if (!this.closed && this.active.has(id)) this.send(id, { ok: false, error: errorDTO(error) }); });
        this.active.set(id, stop); watching = true; return { ok: true, value: null };
      } else invalid("Unknown desktop method.");
      return { ok: true, value };
    } catch (error) { return { ok: false, error: errorDTO(error) }; }
    finally { if (reserved && !watching) this.active.delete(id as string); }
  }
  cancel(id: unknown) { requestId(id); const stop = this.active.get(id); this.active.delete(id); stop?.(); }
  dispose() { this.closed = true; for (const stop of this.active.values()) stop(); this.active.clear(); }
}
