import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationError, emptyRecovery, type EditorClient, type CheckoutTarget, type WorkspaceEvent } from "@moonbase/application/client";
import { EditorSession } from "../src/session.ts";
import { bridgeClient, errorDTO, failure } from "../src/wire.ts";
const target: CheckoutTarget = { hostId: "local", checkoutId: "checkout", projectId: "project", root: "/approved", branch: "main" };
function fixture() {
  let dispatches = 0, stops = 0, signal: AbortSignal | undefined;
  const events: WorkspaceEvent[] = [];
  const client: EditorClient = { command: async (name, _input, options) => {
    dispatches++; signal = options?.signal;
    if (name === "openCheckout") return target as never;
    if (name === "loadRecovery") return { revision: 0, state: { ...emptyRecovery("desktop-primary"), checkouts: [target] }, operations: [], errors: [] } as never;
    if (name === "readFile") return await new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new ApplicationError({ code: "Cancelled", message: "cancelled", target: { checkout: target, path: "a.ts" } })))) as never;
    return undefined as never;
  }, watch(_input, receive) { receive({ checkout: target, paths: [] }); return () => stops++; } };
  const session = new EditorSession(client, { chooseCheckout: async () => "/approved", imports: async () => ["opaque"] }, (_id, event) => { if (event.ok) events.push(event.value); });
  const call = (operation: string, input: unknown, id: string = crypto.randomUUID()) => session.call("command", { operation, input }, id);
  return { session, call, events, get dispatches() { return dispatches; }, get stops() { return stops; }, get signal() { return signal; } };
}
test("native approval, exact identity and caller validation reject before command dispatch", async () => {
  const f = fixture();
  for (const [name, input] of [["openCheckout", { root: "/approved" }], ["toString", {}], ["readFile", { checkout: target, path: "a.ts" }], ["loadRecovery", { clientId: "foreign" }], ["loadRecovery", { clientId: "desktop-primary", extra: true }]] as const) {
    const result = await f.call(name, input); assert(!result.ok); assert.equal(f.dispatches, 0);
  }
  assert((await f.session.call("choose-checkout", null, "native")).ok);
  assert((await f.call("openCheckout", { root: "/approved" })).ok); assert.equal(f.dispatches, 1);
  assert.equal((await f.call("readFile", { checkout: { ...target, hostId: "other" }, path: "a.ts" })).ok, false);
  assert.equal((await f.call("persistRecovery", { clientId: "desktop-primary", requestId: "publish", expectedRevision: 0, state: { ...emptyRecovery("other"), checkouts: [target] } })).ok, false);
  assert.equal(f.dispatches, 1); f.session.dispose();
});
test("restored exact approvals, owned cancellation, failed-watch cleanup and disposal", async () => {
  const f = fixture(); await f.call("loadRecovery", { clientId: "desktop-primary" });
  const pending = f.call("readFile", { checkout: target, path: "a.ts" }, "owned");
  assert.equal((await f.call("readFile", { checkout: target, path: "a.ts" }, "owned")).ok, false);
  f.session.cancel("other"); assert.equal(f.signal?.aborted, false); f.session.cancel("owned");
  assert.equal((await f.call("readFile", { checkout: target, path: "a.ts" }, "owned")).ok, false);
  const cancelled = await pending; assert(!cancelled.ok); assert.equal(cancelled.error.code, "Cancelled"); assert.deepEqual(cancelled.error.target, { checkout: target, path: "a.ts" });
  assert.equal((await f.session.call("watch", { checkout: target, paths: "bad" }, "watch")).ok, false);
  assert((await f.session.call("watch", { checkout: target, paths: [] }, "watch")).ok); assert.equal(f.events.length, 1);
  f.session.dispose(); assert.equal(f.stops, 1); assert.equal((await f.call("loadRecovery", { clientId: "desktop-primary" })).ok, false);
});
test("error DTO reconstructs the application brand/code/target and rejects malformed DTOs", () => {
  for (const code of ["InvalidInput", "Conflict", "Persistence", "Uncertain", "Cancelled", "Unauthorized", "Unavailable", "Incompatible"] as const) {
    const original = new ApplicationError({ code, message: "retained", target: { checkout: target, path: "a.ts" } });
    const restored = failure(structuredClone(errorDTO(original))); assert(ApplicationError.is(restored)); assert.equal(restored.code, code); assert.deepEqual(restored.target, original.target);
  }
  assert.equal(failure({ code: "fake", message: "x" }).code, "Incompatible"); assert.equal(failure({ code: "Uncertain", message: "x", target: { checkout: { ...target, hostId: 42 }, path: "a.ts" } }).code, "Incompatible");
});
test("preaborted browser command sends nothing", async () => {
  let dispatched = 0; const signal = AbortSignal.abort();
  const client = bridgeClient({ call: async () => { dispatched++; return { ok: true, value: null }; } } as never);
  await assert.rejects(client.command("loadRecovery", { clientId: "desktop-primary" }, { signal }), e => ApplicationError.is(e) && e.code === "Cancelled"); assert.equal(dispatched, 0);
});
test("long-lived watches cannot consume command capacity or prevent disposal", async () => {
  const f = fixture(); await f.call("loadRecovery", { clientId: "desktop-primary" });
  for (let index = 0; index < 128; index++) assert((await f.session.call("watch", { checkout: target, paths: [] }, `watch-${index}`)).ok);
  assert.equal((await f.session.call("watch", { checkout: target, paths: [] }, "overflow")).ok, false);
  assert((await f.call("loadRecovery", { clientId: "desktop-primary" })).ok);
  f.session.dispose(); assert.equal(f.stops, 128);
});
