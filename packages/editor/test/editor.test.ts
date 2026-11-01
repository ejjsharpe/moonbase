import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, ManagedRuntime } from "effect";
import { makeEditorClient } from "@moonbase/application/runtime-client";
import { ApplicationError, type CheckoutTarget, type EditorClient, type CommandInput } from "@moonbase/application/client";
import { createEditor, checkoutKey, fileKey, type CloseChoice } from "../src/editor.ts";
import { memoryWorkspace } from "../src/memory.ts";

const checkout: CheckoutTarget = { hostId: "local", checkoutId: "first", projectId: "project", root: "/memory/first", branch: "main" };
const second: CheckoutTarget = { hostId: "other-host", checkoutId: "second", projectId: "project", root: "/memory/second", branch: "main" };
const target = (path: string, c = checkout) => ({ checkout: c, path });
async function fixture(clientId = "editor-one") {
  const memory = memoryWorkspace([checkout, second].map(checkout => ({ checkout,
    files: { "a.ts": "const a = 1;", "b.ts": "second", "c.ts": "third", "folder/nested.ts": "nested" },
    head: { "a.ts": "const a = 0;" }, index: { "a.ts": "const a = 0.5;" }, ignored: ["c.ts"],
  })));
  const runtime = ManagedRuntime.make(memory.layer), client = makeEditorClient(runtime);
  const editor = createEditor({ client, clientId }); await editor.load(); await editor.openCheckout(checkout.root);
  return { memory, runtime, client, editor, async dispose() { editor.dispose(); await runtime.dispose(); } };
}

test("open/edit/save and staged/unstaged views use one working buffer and distinct baselines", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.editor.open(target("a.ts")), true);
    f.editor.edit(target("a.ts"), "my edits");
    assert.equal(await f.editor.open(target("a.ts"), { view: "staged" }), true);
    assert.equal(f.editor.getSnapshot().comparisons[fileKey(target("a.ts"))].original, "const a = 0;");
    assert.equal(f.editor.buffer(target("a.ts"))?.text, "my edits");
    await f.editor.open(target("a.ts"), { view: "unstaged" });
    assert.equal(f.editor.getSnapshot().comparisons[fileKey(target("a.ts"))].original, "const a = 0.5;");
    assert.equal(f.editor.getSnapshot().buffers.length, 1);
    assert.equal(await f.editor.save(target("a.ts")), true);
    assert.equal((await f.client.command("readFile", target("a.ts"))).text, "my edits");
    assert.equal((await f.client.command("readComparison", { target: target("a.ts"), area: "unstaged" })).original, "const a = 0.5;");
  } finally { await f.dispose(); }
});

test("external-change conflict retains dirty text and baseline; Overwrite checks the observed version again", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts")); const baseline = f.editor.buffer(target("a.ts"))!.disk;
    f.editor.edit(target("a.ts"), "dirty"); f.memory.externalWrite(target("a.ts"), "external");
    assert.equal(await f.editor.save(target("a.ts")), false);
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "dirty");
    assert.deepEqual(f.editor.buffer(target("a.ts"))!.disk, baseline);
    await f.editor.open(target("a.ts"), { view: "conflict" });
    assert.equal(f.editor.getSnapshot().comparisons[fileKey(target("a.ts"))].original, "external");
    f.memory.externalWrite(target("a.ts"), "external again");
    assert.equal(await f.editor.save(target("a.ts"), true), false);
    assert.equal(f.editor.buffer(target("a.ts"))!.conflict!.text, "external again");
    assert.equal(await f.editor.save(target("a.ts"), true), true);
    assert.equal((await f.client.command("readFile", target("a.ts"))).text, "dirty");
  } finally { await f.dispose(); }
});

test("Reload persistence failure vetoes loss; Cancel keeps the edits", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "dirty");
    f.memory.externalWrite(target("a.ts"), "external"); await f.editor.save(target("a.ts"));
    f.memory.failNext("persistRecovery"); await assert.rejects(f.editor.reload(target("a.ts")));
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "dirty");
    f.editor.cancelConflict(target("a.ts")); assert.equal(f.editor.buffer(target("a.ts"))!.text, "dirty");
    assert.equal(await f.editor.reload(target("a.ts")), true);
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "external");
  } finally { await f.dispose(); }
});

test("lost Save response retries its immutable payload once, preserving newer edits", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "first edit");
    f.memory.failNext("saveFile", "Response lost after replacement", true);
    await assert.rejects(f.editor.save(target("a.ts")));
    const request = f.editor.buffer(target("a.ts"))!.pendingSave;
    assert.equal(f.memory.stats.saves, 1);
    f.editor.edit(target("a.ts"), "newer edit");
    assert.equal(await f.editor.close([target("a.ts")], async () => "discard"), false);
    assert.equal(await f.editor.save(target("a.ts")), false);
    assert.equal(f.memory.stats.saves, 1);
    assert.equal(f.editor.buffer(target("a.ts"))!.disk.text, request!.text);
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "newer edit");
    assert.equal(await f.editor.save(target("a.ts")), true);
    assert.equal(f.memory.stats.saves, 2);
  } finally { await f.dispose(); }
});

test("captured close defers Discards; earlier Save remains a fact after later Cancel", async () => {
  const f = await fixture();
  try {
    for (const path of ["a.ts", "b.ts", "c.ts"]) { await f.editor.open(target(path)); f.editor.edit(target(path), "edit " + path); }
    const choices: CloseChoice[] = ["save", "discard", "cancel"];
    assert.equal(await f.editor.close([target("a.ts"), target("b.ts"), target("c.ts")], async () => choices.shift()!), false);
    assert.equal(f.editor.getSnapshot().recovery.views[checkoutKey(checkout)].openFiles.length, 3);
    assert.equal(f.editor.buffer(target("a.ts"))!.disk.text, "edit a.ts");
    assert.equal(f.editor.buffer(target("b.ts"))!.text, "edit b.ts");
    assert.equal(f.editor.buffer(target("c.ts"))!.text, "edit c.ts");
    f.memory.failNext("persistRecovery");
    assert.equal(await f.editor.close([target("b.ts")], async () => "discard"), false);
    assert.equal(f.editor.buffer(target("b.ts"))!.text, "edit b.ts");
    assert.equal(await f.editor.close([target("b.ts")], async () => "discard"), true);
    assert.equal(f.editor.buffer(target("b.ts")), undefined);
    await f.editor.reopen(checkout); assert.equal(f.editor.buffer(target("b.ts"))!.text, "second");
  } finally { await f.dispose(); }
});

test("preview replacement follows successful activation; dirty, Keep Open and reordered previews remain", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts"), { intent: "preview" });
    f.memory.failNext("readFile"); assert.equal(await f.editor.open(target("b.ts"), { intent: "preview" }), false);
    assert.equal(f.editor.getSnapshot().recovery.views[checkoutKey(checkout)].active, "a.ts");
    await f.editor.open(target("b.ts"), { intent: "preview" });
    assert.equal(f.editor.buffer(target("a.ts")), undefined);
    f.editor.edit(target("b.ts"), "dirty"); await f.editor.open(target("c.ts"), { intent: "preview" });
    f.editor.reorder(checkout, "c.ts", 0); await f.editor.open(target("a.ts"), { intent: "preview" });
    assert.deepEqual(f.editor.getSnapshot().recovery.views[checkoutKey(checkout)].openFiles, ["c.ts", "a.ts", "b.ts"]);
    f.editor.keepOpen(target("a.ts")); assert.equal(f.editor.getSnapshot().recovery.views[checkoutKey(checkout)].preview, null);
  } finally { await f.dispose(); }
});

test("reopen restores batch order/view/position and reads current source rather than discarded text", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts"), { view: "staged" }); await f.editor.open(target("b.ts"));
    f.editor.position(target("a.ts"), "staged", { line: 1, column: 4, top: 18, left: 2 });
    await f.editor.close([target("a.ts"), target("b.ts")], async () => "discard");
    f.memory.externalWrite(target("b.ts"), "latest source");
    await f.editor.reopen(checkout);
    const selected = f.editor.getSnapshot().recovery.views[checkoutKey(checkout)];
    assert.deepEqual(selected.openFiles, ["a.ts", "b.ts"]); assert.equal(selected.fileViews["a.ts"], "staged");
    assert.equal(selected.positions["a.ts"].staged?.column, 4);
    assert.equal(f.editor.buffer(target("b.ts"))!.text, "latest source");
    await f.editor.navigate(checkout, -1); assert.equal(f.editor.getSnapshot().recovery.views[checkoutKey(checkout)].active, "a.ts");
  } finally { await f.dispose(); }
});

test("two editor instances isolate buffers, positions, selection and recovery; restart restores only its own namespace", async () => {
  const f = await fixture(), other = createEditor({ client: f.client, clientId: "editor-two" });
  try {
    await other.load(); await other.openCheckout(checkout.root);
    await f.editor.open(target("a.ts")); await other.open(target("a.ts"));
    f.editor.edit(target("a.ts"), "one"); other.edit(target("a.ts"), "two");
    f.editor.position(target("a.ts"), "file", { line: 1, column: 3, top: 9, left: 0 });
    await other.open(target("b.ts")); await f.editor.flush(); await other.flush();
    assert.notEqual(f.editor.instanceId, other.instanceId);
    assert.equal(other.getSnapshot().recovery.views[checkoutKey(checkout)].active, "b.ts");
    assert.equal(other.getSnapshot().recovery.views[checkoutKey(checkout)].positions["a.ts"], undefined);
    f.editor.dispose();
    const restored = createEditor({ client: f.client, clientId: "editor-one" });
    try { await restored.load(); assert.equal(restored.buffer(target("a.ts"))!.text, "one"); }
    finally { restored.dispose(); }
    assert.equal(other.buffer(target("a.ts"))!.text, "two");
  } finally { other.dispose(); await f.dispose(); }
});

test("recovery CAS conflict is visible and vetoes close", async () => {
  const f = await fixture(), duplicate = createEditor({ client: f.client, clientId: f.editor.clientId });
  try {
    await duplicate.load(); await duplicate.openCheckout(checkout.root); await duplicate.flush();
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "dirty");
    assert.equal(await f.editor.close([target("a.ts")], async () => "discard"), false);
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "dirty");
    assert.match(f.editor.getSnapshot().errors.join(" "), /revision changed/);
  } finally { duplicate.dispose(); await f.dispose(); }
});

test("tree ignore filtering/reveal and bounded lookup expose their real results", async () => {
  const f = await fixture();
  try {
    f.editor.tree(checkout, { hideIgnored: true });
    assert.equal((await f.editor.list(checkout)).entries.some(entry => entry.path === "c.ts"), false);
    await assert.rejects(f.editor.reveal(target("c.ts")), /hidden/);
    await f.editor.reveal(target("folder/nested.ts"));
    assert.deepEqual(f.editor.getSnapshot().recovery.views[checkoutKey(checkout)].tree.selected, ["folder/nested.ts"]);
    assert.deepEqual((await f.editor.lookup(checkout, "nested")).paths, ["folder/nested.ts"]);
    await assert.rejects(f.editor.open(target("../escape")), /relative path/);
  } finally { await f.dispose(); }
});

test("lost move response resolves status once and publishes dirty drafts at the exact successful destination", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "dirty source");
    const sources = await f.editor.inspect(checkout, ["a.ts"]);
    f.memory.failNext("mutate", "Response lost", true);
    await assert.rejects(f.editor.mutate({ id: "move-one", checkout, kind: "move", sources, destination: "renamed.ts" }));
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "dirty source");
    await f.editor.resolveOperation("move-one"); await f.editor.resolveOperation("move-one");
    assert.equal(f.memory.stats.mutations, 1); assert.equal(f.editor.buffer(target("a.ts")), undefined);
    assert.equal(f.editor.buffer(target("renamed.ts"))!.text, "dirty source");
    assert.equal((await f.client.command("loadRecovery", { clientId: f.editor.clientId })).state.drafts[0].target.path, "renamed.ts");
  } finally { await f.dispose(); }
});

test("restart reconciles recorded outcomes only in their immutable checkout despite colliding source paths", async () => {
  const f = await fixture();
  try {
    await f.editor.openCheckout(second.root);
    for (const c of [checkout, second]) { await f.editor.open(target("a.ts", c)); f.editor.edit(target("a.ts", c), c.hostId + " dirty"); }
    await f.editor.flush();
    const sources = await f.editor.inspect(checkout, ["a.ts"]);
    f.memory.failNext("mutate", "Lost after move", true);
    await assert.rejects(f.editor.mutate({ id: "restart-move", checkout, sources, kind: "move", destination: "moved.ts" }));
    f.editor.dispose();
    const restored = createEditor({ client: f.client, clientId: f.editor.clientId });
    try {
      await restored.load();
      assert.equal(restored.buffer(target("moved.ts"))!.text, "local dirty");
      assert.equal(restored.buffer(target("a.ts", second))!.text, "other-host dirty");
      assert.equal(restored.buffer(target("moved.ts", second)), undefined);
      assert.equal(f.memory.stats.mutations, 1);
    } finally { restored.dispose(); }
  } finally { await f.dispose(); }
});

test("dirty Copy carries a separate destination draft; Trash retains dirty source recovery", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "dirty copy");
    let sources = await f.editor.inspect(checkout, ["a.ts"]);
    await f.editor.mutate({ checkout, sources, kind: "copy", destination: "copy.ts" });
    assert.equal(f.editor.buffer(target("copy.ts"))!.text, "dirty copy");
    assert.equal(f.editor.buffer(target("copy.ts"))!.disk.text, "const a = 1;");
    sources = await f.editor.inspect(checkout, ["a.ts"]);
    await f.editor.mutate({ checkout, sources, kind: "trash" });
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "dirty copy");
    assert.equal((await f.client.command("loadRecovery", { clientId: f.editor.clientId })).state.drafts.length, 2);
  } finally { await f.dispose(); }
});

test("mutation persistence failure precedes effects; acknowledgement waits for reconciled recovery publication", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "dirty");
    const sources = await f.editor.inspect(checkout, ["a.ts"]);
    f.memory.failNext("persistRecovery");
    await assert.rejects(f.editor.mutate({ checkout, sources, kind: "move", destination: "moved.ts" }));
    assert.equal(f.memory.stats.mutations, 0);
    await f.editor.mutate({ checkout, sources, kind: "move", destination: "moved.ts" });
    assert.equal((await f.client.command("loadRecovery", { clientId: f.editor.clientId })).operations.length, 0);
  } finally { await f.dispose(); }
});

test("stale file activation cannot replace a later successful comparison", async () => {
  const f = await fixture(); let release!: () => void, reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
  const client: EditorClient = { ...f.client, async command(name, input, options) {
    if (name === "readFile" && (input as CommandInput<"readFile">).path === "b.ts") { reading(); await wait; }
    return f.client.command(name, input, options);
  } };
  const editor = createEditor({ client, clientId: "stale" });
  try {
    await editor.load(); await editor.openCheckout(checkout.root);
    const slow = editor.open(target("b.ts")); await started;
    await editor.open(target("a.ts"), { view: "staged" }); release(); assert.equal(await slow, false);
    assert.equal(editor.getSnapshot().recovery.views[checkoutKey(checkout)].active, "a.ts");
    assert.equal(editor.buffer(target("b.ts")), undefined);
  } finally { release(); editor.dispose(); await f.dispose(); }
});

test("disposal releases view subscriptions without discarding a published draft or ending the process runtime", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "recover me"); await f.editor.flush();
    f.editor.dispose(); await f.runtime.runPromise(Effect.yieldNow);
    assert.equal(f.memory.stats.active, 0); assert.equal(f.memory.stats.subscriptions, f.memory.stats.released);
    assert.equal((await f.client.command("loadRecovery", { clientId: f.editor.clientId })).state.drafts[0].text, "recover me");
    assert.equal((await f.client.command("readFile", target("b.ts"))).text, "second");
    await assert.rejects(f.editor.open(target("b.ts")), /disposed/);
  } finally { await f.dispose(); }
});

test("Quit uses the same deferred preservation gate and persistence failure keeps all edits", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "dirty");
    assert.equal(await f.editor.prepareQuit(async () => "cancel"), false);
    f.memory.failNext("persistRecovery"); assert.equal(await f.editor.prepareQuit(async () => "discard"), false);
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "dirty");
    assert.equal(await f.editor.prepareQuit(async () => "save"), true);
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "dirty");
  } finally { await f.dispose(); }
});
