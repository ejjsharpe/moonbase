import assert from "node:assert/strict";
import { test } from "node:test";
import { ManagedRuntime } from "effect";
import { makeEditorClient } from "@moonbase/application/runtime-client";
import { ApplicationError, type CheckoutTarget, type CommandInput, type EditorClient } from "@moonbase/application/client";
import { createEditor, type EditorController } from "../src/editor.ts";
import { memoryWorkspace } from "../src/memory.ts";

const checkout: CheckoutTarget = { hostId: "receipts", checkoutId: "checkout", projectId: "project", root: "/receipt-fixture", branch: "main" };
const target = (path: string) => ({ checkout, path });
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function fixture(wrap: (raw: EditorClient) => EditorClient = raw => raw) {
  const memory = memoryWorkspace([{ checkout, files: { "a.ts": "A", "b.ts": "B", "c.ts": "C" } }]);
  const runtime = ManagedRuntime.make(memory.layer), raw = makeEditorClient(runtime), client = wrap(raw);
  const editor = createEditor({ client, clientId: "only-client" });
  await editor.load(); await editor.openCheckout(checkout.root);
  for (const path of ["a.ts", "b.ts", "c.ts"]) { await editor.open(target(path)); editor.edit(target(path), "captured " + path); }
  await editor.flush();
  const restarted: EditorController[] = [];
  return { memory, runtime, raw, editor, async restart() { editor.dispose(); const next = createEditor({ client: raw, clientId: editor.clientId }); restarted.push(next); await next.load(); return next; }, async dispose() { editor.dispose(); for (const next of restarted) next.dispose(); await runtime.dispose(); assert.equal(memory.stats.active, 0); assert.equal(memory.stats.subscriptions, memory.stats.released); } };
}
for (const observe of [false, true]) test(`R9 lost A reply retains B receipt until A retry bridges the exact chain (watch=${observe})`, async () => {
  let lose = true; const requests: CommandInput<"saveFile">[] = [];
  const f = await fixture(raw => ({ watch: observe ? raw.watch : () => () => {}, async command(name, input, options) {
    const result = await raw.command(name, input, options);
    if (name === "saveFile") { const request = structuredClone(input as CommandInput<"saveFile">); requests.push(request); if (request.target.path === "a.ts" && lose) { lose = false; throw Error("Lost committed A reply"); } }
    return result;
  } }));
  try {
    await assert.rejects(f.editor.save(target("a.ts")), /Lost committed/);
    const a = f.editor.buffer(target("a.ts"))!.pendingSave!;
    f.editor.edit(target("a.ts"), "newer A");
    await assert.rejects(f.editor.save(target("b.ts")), /revision gap/);
    const b = f.editor.buffer(target("b.ts"))!.pendingSave;
    assert(b, "the known B receipt must retain its immutable request across a gap");
    f.editor.edit(target("b.ts"), "newer B");
    await assert.rejects(f.editor.save(target("b.ts")), /revision gap/);
    assert.equal(await f.editor.prepareQuit(async () => "discard"), false);
    assert.equal(await f.editor.save(target("a.ts")), false);
    assert.equal(f.editor.buffer(target("a.ts"))!.pendingSave, undefined);
    assert.equal(f.editor.buffer(target("b.ts"))!.pendingSave, undefined);
    assert.equal(f.memory.stats.saves, 2); assert.deepEqual(requests.filter(r => r.target.path === "a.ts"), [a, a]); assert.equal(requests.filter(r => r.target.path === "b.ts").length, 1);
    await f.editor.flush();
    const stored = await f.raw.command("loadRecovery", { clientId: f.editor.clientId });
    for (const [path, text] of [["a.ts", "newer A"], ["b.ts", "newer B"]]) {
      assert.equal(stored.state.drafts.find(d => d.target.path === path)?.text, text);
      assert.equal((await f.raw.command("readFile", target(path))).text, "captured " + path);
    }
    const restored = await f.restart();
    for (const [path, text] of [["a.ts", "newer A"], ["b.ts", "newer B"]]) { assert.equal(restored.buffer(target(path))!.text, text); assert.equal(restored.buffer(target(path))!.disk.text, "captured " + path); }
    assert.equal(await restored.prepareQuit(async () => "cancel"), false); assert.equal(await restored.prepareQuit(async () => "discard"), true);
  } finally { await f.dispose(); }
});
for (const observe of [false, true]) test(`R9 reversed three Save replies reconcile retained receipts without repeating writes (watch=${observe})`, async () => {
  const admitted = [gate(), gate()], reply = [gate(), gate()];
  const f = await fixture(raw => ({ watch: observe ? raw.watch : () => () => {}, async command(name, input, options) {
    const result = await raw.command(name, input, options);
    if (name === "saveFile") { const index = ["a.ts", "b.ts"].indexOf((input as CommandInput<"saveFile">).target.path); if (index >= 0) { admitted[index].release(); await reply[index].promise; } }
    return result;
  } }));
  try {
    const a = f.editor.save(target("a.ts")); await admitted[0].promise;
    const b = f.editor.save(target("b.ts")); const rejectedB = assert.rejects(b, /revision gap/); await admitted[1].promise;
    await assert.rejects(f.editor.save(target("c.ts")), /revision gap/);
    for (const path of ["a.ts", "b.ts", "c.ts"]) f.editor.edit(target(path), "newer " + path);
    reply[1].release(); await rejectedB;
    reply[0].release(); assert.equal(await a, false);
    assert.equal(f.memory.stats.saves, 3);
    for (const path of ["a.ts", "b.ts", "c.ts"]) assert.equal(f.editor.buffer(target(path))!.pendingSave, undefined);
    await f.editor.flush(); const restored = await f.restart();
    for (const path of ["a.ts", "b.ts", "c.ts"]) { assert.equal(restored.buffer(target(path))!.text, "newer " + path); assert.equal(restored.buffer(target(path))!.disk.text, "captured " + path); }
    assert.equal(await restored.prepareQuit(async () => "discard"), true);
  } finally { reply.forEach(g => g.release()); await f.dispose(); }
});
for (const committed of [false, true]) test(`R9 reconciliation publication uncertainty retains all known requests until its exact receipt (committed=${committed})`, async () => {
  let loseA = true, fault = false, unavailable = false;
  const f = await fixture(raw => ({ ...raw, async command(name, input, options) {
    if (fault && name === "persistRecovery") {
      fault = false; unavailable = true;
      if (committed) await raw.command(name, input, options);
      throw new ApplicationError({ code: "Persistence", message: "Publication response unavailable" });
    }
    if (unavailable && name === "getRecoveryPublication") throw Error("Exact lookup unavailable");
    const result = await raw.command(name, input, options);
    if (loseA && name === "saveFile" && (input as CommandInput<"saveFile">).target.path === "a.ts") { loseA = false; throw Error("Lost A"); }
    return result;
  } }));
  try {
    await assert.rejects(f.editor.save(target("a.ts")), /Lost A/);
    await assert.rejects(f.editor.save(target("b.ts")), /revision gap/);
    f.editor.edit(target("a.ts"), "before pending A"); f.editor.edit(target("b.ts"), "before pending B");
    fault = true; await assert.rejects(f.editor.save(target("a.ts")), /Publication response/);
    const publication = f.editor.getSnapshot().publication!; assert(publication);
    for (const path of ["a.ts", "b.ts"]) assert(f.editor.buffer(target(path))!.pendingSave);
    f.editor.edit(target("a.ts"), "after pending A"); f.editor.edit(target("b.ts"), "after pending B");
    assert.equal(await f.editor.prepareQuit(async () => "discard"), false);
    unavailable = false; assert.equal(await f.editor.resolveRecoveryPublication(), true);
    for (const path of ["a.ts", "b.ts"]) assert.equal(f.editor.buffer(target(path))!.pendingSave, undefined);
    assert(await f.raw.command("getRecoveryPublication", { clientId: f.editor.clientId, requestId: publication.requestId }));
    await f.editor.flush(); assert.equal(f.memory.stats.saves, 2);
    const restored = await f.restart();
    assert.equal(restored.buffer(target("a.ts"))!.text, "after pending A"); assert.equal(restored.buffer(target("b.ts"))!.text, "after pending B");
    for (const path of ["a.ts", "b.ts"]) assert.equal(restored.buffer(target(path))!.disk.text, "captured " + path);
    assert.equal(await restored.prepareQuit(async () => "discard"), true);
  } finally { await f.dispose(); }
});
test("R9 a real unrelated same-client publication cannot be bridged by retained own Save receipts", async () => {
  let loseA = true;
  const f = await fixture(raw => ({ ...raw, async command(name, input, options) {
    const result = await raw.command(name, input, options);
    if (loseA && name === "saveFile" && (input as CommandInput<"saveFile">).target.path === "a.ts") { loseA = false; throw Error("Lost A"); }
    return result;
  } }));
  try {
    await assert.rejects(f.editor.save(target("a.ts")), /Lost A/);
    const before = await f.raw.command("loadRecovery", { clientId: f.editor.clientId });
    await f.raw.command("persistRecovery", { clientId: f.editor.clientId, requestId: "unrelated", expectedRevision: before.revision, state: { ...before.state, sidebarWidth: 333 } });
    await assert.rejects(f.editor.save(target("b.ts")), /revision gap/);
    await assert.rejects(f.editor.save(target("a.ts")), /revision gap/);
    for (const path of ["a.ts", "b.ts"]) { f.editor.edit(target(path), "newer " + path); assert(f.editor.buffer(target(path))!.pendingSave); }
    await assert.rejects(f.editor.save(target("b.ts")), /revision gap/);
    await assert.rejects(f.editor.flush(), e => ApplicationError.is(e) && e.code === "Conflict");
    assert.equal(await f.editor.prepareQuit(async () => "discard"), false); assert.equal(f.memory.stats.saves, 2);
    const stored = await f.raw.command("loadRecovery", { clientId: f.editor.clientId }); assert.equal(stored.state.sidebarWidth, 333); assert.equal(stored.revision, before.revision + 2);
    for (const path of ["a.ts", "b.ts"]) assert.equal(f.editor.buffer(target(path))!.text, "newer " + path);
  } finally { await f.dispose(); }
});
for (const outcome of ["cancel", "conflict"] as const) test(`R9 exact Save chain clears the gate but a later captured-close ${outcome} retains completed Saves and proposed drafts`, async () => {
  let lose = true;
  const f = await fixture(raw => ({ ...raw, async command(name, input, options) { const result = await raw.command(name, input, options); if (lose && name === "saveFile") { lose = false; throw Error("Lost A"); } return result; } }));
  try {
    await assert.rejects(f.editor.save(target("a.ts")), /Lost A/); await assert.rejects(f.editor.save(target("b.ts")), /revision gap/);
    assert.equal(await f.editor.save(target("a.ts")), true); assert.equal(f.memory.stats.saves, 2);
    for (const path of ["a.ts", "b.ts"]) f.editor.edit(target(path), "later " + path);
    await f.editor.flush(); if (outcome === "conflict") f.memory.externalWrite(target("b.ts"), "external B");
    const choices = outcome === "cancel" ? ["save", "discard", "cancel"] as const : ["save", "save"] as const; let index = 0;
    assert.equal(await f.editor.close([target("a.ts"), target("b.ts"), target("c.ts")], async () => choices[index++]), false);
    assert.equal(f.memory.stats.saves, 3); assert.equal((await f.raw.command("readFile", target("a.ts"))).text, "later a.ts");
    assert.equal(f.editor.buffer(target("a.ts"))!.disk.text, "later a.ts"); assert.equal(f.editor.buffer(target("b.ts"))!.text, "later b.ts");
    const stored = await f.raw.command("loadRecovery", { clientId: f.editor.clientId });
    assert.equal(stored.state.drafts.find(d => d.target.path === "b.ts")?.text, "later b.ts"); assert.equal(stored.state.drafts.find(d => d.target.path === "c.ts")?.text, "captured c.ts");
    const restored = await f.restart(); assert.equal(restored.buffer(target("b.ts"))!.text, "later b.ts"); assert.equal(await restored.prepareQuit(async () => "discard"), true);
  } finally { await f.dispose(); }
});
test("R9 disposal releases observations and prevents a late missing Save receipt from publishing", async () => {
  const admitted = gate(), reply = gate();
  const f = await fixture(raw => ({ ...raw, async command(name, input, options) { const result = await raw.command(name, input, options); if (name === "saveFile" && (input as CommandInput<"saveFile">).target.path === "a.ts") { admitted.release(); await reply.promise; } return result; } }));
  try {
    const saving = f.editor.save(target("a.ts")); await admitted.promise;
    await assert.rejects(f.editor.save(target("b.ts")), /revision gap/); const publications = f.memory.stats.publications;
    f.editor.dispose(); reply.release(); assert.equal(await saving, false);
    assert.equal(f.memory.stats.publications, publications); assert.equal(f.memory.stats.saves, 2);
    await f.runtime.dispose(); assert.equal(f.memory.stats.active, 0);
  } finally { reply.release(); await f.dispose(); }
});
