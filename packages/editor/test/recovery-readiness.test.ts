import assert from "node:assert/strict";
import { test } from "node:test";
import { ManagedRuntime } from "effect";
import { makeEditorClient } from "@moonbase/application/runtime-client";
import { type CheckoutTarget, type EditorClient, type CommandInput } from "@moonbase/application/client";
import { createEditor } from "../src/editor.ts";
import { memoryWorkspace } from "../src/memory.ts";

const checkout: CheckoutTarget = { hostId: "local", checkoutId: "ready", projectId: "project", root: "/memory/ready", branch: "main" };
const target = { checkout, path: "a.ts" };
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function fixture() {
  const memory = memoryWorkspace([{ checkout, files: { "a.ts": "disk" } }]), runtime = ManagedRuntime.make(memory.layer), raw = makeEditorClient(runtime);
  let hold: ReturnType<typeof gate> | undefined, read: ReturnType<typeof gate> | undefined, entered = gate();
  const requests: CommandInput<"persistRecovery">[] = [];
  const client: EditorClient = { ...raw, command(name, input, options) {
    if (name !== "persistRecovery") { const wait = name === "lookupFiles" ? read : undefined; read = undefined; if (wait) entered.release(); return wait ? wait.promise.then(() => raw.command(name, input, options)) : raw.command(name, input, options); }
    requests.push(structuredClone(input as CommandInput<"persistRecovery">));
    const wait = hold; hold = undefined; entered.release();
    return (wait ? wait.promise.then(() => raw.command(name, input, options)) : raw.command(name, input, options));
  } };
  const editor = createEditor({ client, clientId: "readiness" }); await editor.load(); await editor.openCheckout(checkout.root); await editor.open(target); await editor.flush();
  return { memory, raw, editor, requests, hold() { entered = gate(); hold = gate(); return { entered: entered.promise, release: hold.release }; },
    holdRead() { entered = gate(); read = gate(); return { entered: entered.promise, release: read.release }; },
    async restart() { editor.dispose(); const next = createEditor({ client: raw, clientId: editor.clientId }); await next.load(); return next; },
    async dispose() { editor.dispose(); await runtime.dispose(); } };
}

test("fresh capture invalidates exact recovery confirmation synchronously; confirmed dirty drafts allow unload", async () => {
  const f = await fixture();
  try {
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    f.editor.edit(target, "fresh visible tail"); assert.equal(f.editor.getSnapshot().recoveryReady, false);
    await f.editor.flush(); assert.equal(f.editor.getSnapshot().recoveryReady, true);
    assert.equal(f.editor.buffer(target)!.text, "fresh visible tail"); assert.equal(f.editor.buffer(target)!.disk.text, "disk");
    f.editor.edit(target, "disk"); f.editor.edit(target, "fresh visible tail");
    assert.equal(f.editor.getSnapshot().recoveryReady, false, "equal text cannot reuse old confirmation");
    await f.editor.flush(); const next = await f.restart();
    assert.equal(next.buffer(target)!.text, "fresh visible tail"); next.dispose();
  } finally { await f.dispose(); }
});

test("ordinary publication stays unready in flight and cannot confirm an edit made after capture", async () => {
  const f = await fixture(); const hold = f.hold();
  try {
    f.editor.edit(target, "captured"); const flush = f.editor.flush(); await hold.entered;
    assert.equal(f.editor.getSnapshot().publication, undefined);
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    f.editor.edit(target, "newer while publishing"); hold.release(); await flush;
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    assert.equal((await f.raw.command("loadRecovery", { clientId: f.editor.clientId })).state.drafts[0].text, "captured");
    await f.editor.flush(); assert.equal(f.editor.getSnapshot().recoveryReady, true);
    const next = await f.restart(); assert.equal(next.buffer(target)!.text, "newer while publishing"); next.dispose();
  } finally { hold.release(); await f.dispose(); }
});

for (const committed of [false, true]) test(`uncertain ${committed ? "committed" : "uncommitted"} publication retains identity and only confirms its captured generation`, async () => {
  const f = await fixture();
  try {
    f.editor.edit(target, "original request"); f.memory.failNext("persistRecovery", "Lost response", committed); f.memory.failNext("getRecoveryPublication");
    await assert.rejects(f.editor.flush());
    const id = f.editor.getSnapshot().publication!.requestId;
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    f.editor.edit(target, "later live draft");
    assert.equal(await f.editor.resolveRecoveryPublication(), true);
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    assert.equal(f.requests.filter(request => request.requestId === id).every(request => request.state.drafts[0].text === "original request"), true);
    await f.editor.flush(); assert.equal(f.editor.getSnapshot().recoveryReady, true);
    const next = await f.restart(); assert.equal(next.buffer(target)!.text, "later live draft"); next.dispose();
  } finally { await f.dispose(); }
});

test("read-only work and visible diagnostics do not invalidate confirmed recovery; view changes do", async () => {
  const f = await fixture();
  try {
    f.editor.edit(target, "durable dirty"); await f.editor.flush(); f.editor.report(Error("visible diagnostic"));
    await f.editor.list(checkout); await f.editor.lookup(checkout, "a");
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    f.editor.position(target, "file", { line: 2, column: 3, top: 0, left: 0 });
    assert.equal(f.editor.getSnapshot().recoveryReady, false); await f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
  } finally { await f.dispose(); }
});

test("even a publication of an already confirmed capture vetoes unload until its exact reply", async () => {
  const f = await fixture(); const hold = f.hold();
  try {
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    const writing = f.editor.flush();
    assert.equal(f.editor.getSnapshot().recoveryReady, false, "queued publication is synchronous");
    await hold.entered; assert.equal(f.editor.getSnapshot().recoveryReady, false);
    hold.release(); await writing; assert.equal(f.editor.getSnapshot().recoveryReady, true);
    f.editor.dispose(); assert.equal(f.editor.getSnapshot().recoveryReady, false);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.memory.stats.active, 0);
  } finally { hold.release(); await f.dispose(); }
});

test("an exact recovered receipt confirms unchanged dirty text without saving the file", async () => {
  const f = await fixture();
  try {
    f.editor.edit(target, "durable after lost response"); f.memory.failNext("persistRecovery", "Lost committed reply", true); f.memory.failNext("getRecoveryPublication");
    await assert.rejects(f.editor.flush()); assert.equal(f.editor.getSnapshot().recoveryReady, false);
    assert.equal(await f.editor.resolveRecoveryPublication(), true);
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    assert.equal(f.memory.stats.saves, 0);
    assert.equal((await f.raw.command("readFile", target)).text, "disk");
  } finally { await f.dispose(); }
});

test("a definitively rejected ordinary publication invalidates earlier confirmation without adopting a foreign CAS revision", async () => {
  const f = await fixture();
  try {
    f.editor.edit(target, "confirmed dirty"); await f.editor.flush();
    const loaded = await f.raw.command("loadRecovery", { clientId: f.editor.clientId });
    await f.raw.command("persistRecovery", { clientId: f.editor.clientId, requestId: crypto.randomUUID(), expectedRevision: loaded.revision, state: loaded.state });
    await assert.rejects(f.editor.flush()); assert.equal(f.editor.getSnapshot().publication, undefined);
    assert.equal(f.editor.getSnapshot().recoveryReady, false);
    await assert.rejects(f.editor.flush()); assert.equal(f.editor.getSnapshot().recoveryReady, false);
    assert.equal(f.editor.buffer(target)!.text, "confirmed dirty");
  } finally { await f.dispose(); }
});


test("a held public read-only lookup does not veto an otherwise confirmed capture", async () => {
  const f = await fixture(), read = f.holdRead();
  try {
    const lookup = f.editor.lookup(checkout, "a"); await read.entered;
    assert.equal(f.editor.getSnapshot().recoveryReady, true);
    read.release(); await lookup; assert.equal(f.editor.getSnapshot().recoveryReady, true);
  } finally { read.release(); await f.dispose(); }
});
