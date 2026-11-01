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
async function fixture(clientId = "editor-one", observe = true) {
  const memory = memoryWorkspace([checkout, second].map(checkout => ({ checkout,
    files: { "a.ts": "const a = 1;", "b.ts": "second", "c.ts": "third", "folder/nested.ts": "nested" },
    head: { "a.ts": "const a = 0;" }, index: { "a.ts": "const a = 0.5;" }, ignored: ["c.ts"],
  })));
  const runtime = ManagedRuntime.make(memory.layer), client = makeEditorClient(runtime);
  const editor = createEditor({ client: observe ? client : { ...client, watch: () => () => {} }, clientId }); await editor.load(); await editor.openCheckout(checkout.root);
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
    assert.equal(f.editor.getSnapshot().recovery.views[checkout.checkoutId].openFiles.length, 3);
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
    assert.equal(f.editor.getSnapshot().recovery.views[checkout.checkoutId].active, "a.ts");
    await f.editor.open(target("b.ts"), { intent: "preview" });
    assert.equal(f.editor.buffer(target("a.ts")), undefined);
    f.editor.edit(target("b.ts"), "dirty"); await f.editor.open(target("c.ts"), { intent: "preview" });
    f.editor.reorder(checkout, "c.ts", 0); await f.editor.open(target("a.ts"), { intent: "preview" });
    assert.deepEqual(f.editor.getSnapshot().recovery.views[checkout.checkoutId].openFiles, ["c.ts", "a.ts", "b.ts"]);
    f.editor.keepOpen(target("a.ts")); assert.equal(f.editor.getSnapshot().recovery.views[checkout.checkoutId].preview, null);
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
    const selected = f.editor.getSnapshot().recovery.views[checkout.checkoutId];
    assert.deepEqual(selected.openFiles, ["a.ts", "b.ts"]); assert.equal(selected.fileViews["a.ts"], "staged");
    assert.equal(selected.positions["a.ts"].staged?.column, 4);
    assert.equal(f.editor.buffer(target("b.ts"))!.text, "latest source");
    await f.editor.navigate(checkout, -1); assert.equal(f.editor.getSnapshot().recovery.views[checkout.checkoutId].active, "a.ts");
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
    assert.equal(other.getSnapshot().recovery.views[checkout.checkoutId].active, "b.ts");
    assert.equal(other.getSnapshot().recovery.views[checkout.checkoutId].positions["a.ts"], undefined);
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
    assert.deepEqual(f.editor.getSnapshot().recovery.views[checkout.checkoutId].tree.selected, ["folder/nested.ts"]);
    assert.deepEqual((await f.editor.lookup(checkout, "nested")).matches.map(row => row.path), ["folder/nested.ts"]);
    await assert.rejects(f.editor.open(target("../escape")), /relative path/);
  } finally { await f.dispose(); }
});

test("lost move response resolves status once and publishes dirty drafts at the exact successful destination", async () => {
  const f = await fixture("editor-one", false);
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "dirty source");
    const sources = await f.editor.inspect(checkout, ["a.ts"]);
    f.memory.failNext("mutate", "Response lost", true);
    await assert.rejects(f.editor.mutate({ id: "move-one", checkout, kind: "move", sources, destination: "renamed.ts" }));
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "dirty source");
    assert.equal(await f.editor.close([target("a.ts")], async () => "discard"), false);
    assert.equal(await f.editor.save(target("a.ts")), false);
    await f.editor.open(target("b.ts")); f.editor.edit(target("b.ts"), "unrelated remains usable");
    assert.equal(await f.editor.save(target("b.ts")), true);
    await f.editor.resolveOperation("move-one"); await f.editor.resolveOperation("move-one");
    assert.equal(f.memory.stats.mutations, 1); assert.equal(f.editor.buffer(target("a.ts")), undefined);
    assert.equal(f.editor.buffer(target("renamed.ts"))!.text, "dirty source");
    assert.equal((await f.client.command("loadRecovery", { clientId: f.editor.clientId })).state.drafts[0].target.path, "renamed.ts");
  } finally { await f.dispose(); }
});

test("incompatible recovered operation evidence never rebinds equal checkout/path strings", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "retained"); await f.editor.flush(); f.editor.dispose();
    const client: EditorClient = { ...f.client, async command(name, input, options) {
      const result = await f.client.command(name, input, options);
      if (name !== "loadRecovery") return result;
      return { ...result, operations: [{ id: "foreign", clientId: "origin", recoveryChanges: [], checkout: { ...checkout, hostId: "impostor" }, kind: "move", outcome: "completed",
        items: [{ source: "a.ts", destination: "moved.ts", outcome: "completed" }] }] } as typeof result;
    } };
    const editor = createEditor({ client, clientId: f.editor.clientId });
    try {
      await editor.load(); assert.equal(editor.buffer(target("a.ts"))!.text, "retained");
      assert.equal(editor.buffer(target("moved.ts")), undefined);
      assert.match(editor.getSnapshot().errors.join(" "), /identity unavailable or changed/);
      assert.equal(editor.getSnapshot().operations[0].checkout.hostId, "impostor");
    } finally { editor.dispose(); }
  } finally { await f.dispose(); }
});

test("typed lookup filters history separately, deduplicates, ranks and highlights independently", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts"));
    const blank = await f.editor.lookup(checkout, ""); assert.equal(blank.matches.length, 0); assert.equal(blank.history[0].path, "a.ts");
    const typed = await f.editor.lookup(checkout, "ats");
    assert.equal(typed.history[0].path, "a.ts"); assert.deepEqual(typed.history[0].positions, [0, 2, 3]);
    assert.equal(typed.matches.some(row => row.path === "a.ts"), false);
    const nested = await f.editor.lookup(checkout, '"nested"');
    assert.equal(nested.matches[0].path, "folder/nested.ts"); assert.deepEqual(nested.matches[0].positions, [7, 8, 9, 10, 11, 12]);
    assert.deepEqual((await f.editor.lookup(checkout, "ignored")).matches, []);
  } finally { await f.dispose(); }
});

test("pending commands retain newer live text and close cannot cross an unresolved Save", async () => {
  const f = await fixture(); let received!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { received = resolve; }), delayed = new Promise<void>(resolve => { release = resolve; });
  const client: EditorClient = { ...f.client, async command(name, input, options) {
    const result = await f.client.command(name, input, options);
    if (name === "saveFile") { received(); await delayed; }
    return result;
  } };
  const editor = createEditor({ client, clientId: "pending-save" });
  try {
    await editor.load(); await editor.openCheckout(checkout.root); await editor.open(target("a.ts")); editor.edit(target("a.ts"), "captured save"); await editor.flush();
    const save = editor.save(target("a.ts")); await admitted; editor.edit(target("a.ts"), "newer live edit");
    assert.equal(await editor.prepareQuit(async () => "discard"), false);
    release(); assert.equal(await save, false);
    assert.equal(editor.buffer(target("a.ts"))!.disk.text, "captured save"); assert.equal(editor.buffer(target("a.ts"))!.text, "newer live edit");
    assert.equal((await f.client.command("loadRecovery", { clientId: editor.clientId })).state.drafts[0].text, "newer live edit");
  } finally { release(); editor.dispose(); await f.dispose(); }
});

test("a rejected memory transfer preserves its destination instead of partially deleting it", async () => {
  const f = await fixture();
  try {
    const sources = await f.editor.inspect(checkout, ["a.ts"]), replacements = await f.editor.inspect(checkout, ["b.ts"]);
    await assert.rejects(f.client.command("mutate", { id: "invalid-transfer", clientId: "raw", checkout, kind: "copy", sources, destination: "missing/b.ts", replacements }));
    assert.equal((await f.client.command("readFile", target("b.ts"))).text, "second");
    assert.equal((await f.client.command("readFile", target("a.ts"))).text, "const a = 1;");
  } finally { await f.dispose(); }
});

test("restart reconciles recorded outcomes only in their immutable checkout despite colliding source paths", async () => {
  const f = await fixture("editor-one", false);
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
    assert.equal(editor.getSnapshot().recovery.views[checkout.checkoutId].active, "a.ts");
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

test("origin acknowledgement cannot hide a move from another observer; observer publication/ack then hides its fact", async () => {
  const f = await fixture("origin", false);
  const observer = createEditor({ client: { ...f.client, watch: () => () => {} }, clientId: "observer" });
  try {
    await observer.load(); await observer.openCheckout(checkout.root);
    for (const editor of [f.editor, observer]) { await editor.open(target("a.ts")); editor.edit(target("a.ts"), editor.clientId + " draft"); await editor.flush(); }
    const baseline = observer.buffer(target("a.ts"))!.disk;
    const sources = await f.editor.inspect(checkout, ["a.ts"]);
    await f.editor.mutate({ id: "shared-fact", checkout, sources, kind: "move", destination: "moved.ts" });
    assert.equal((await f.client.command("loadRecovery", { clientId: "origin" })).operations.length, 0);
    const evidence = await f.client.command("loadRecovery", { clientId: "observer" });
    assert.equal(evidence.operations[0].clientId, "origin"); assert.equal(evidence.operations[0].id, "shared-fact");
    observer.edit(target("a.ts"), "newer live observer text");
    await observer.reconcileRecovery();
    assert.equal(observer.buffer(target("a.ts")), undefined);
    assert.equal(observer.buffer(target("moved.ts"))!.text, "newer live observer text");
    assert.deepEqual(observer.buffer(target("moved.ts"))!.disk, baseline);
    assert.equal((await f.client.command("loadRecovery", { clientId: "observer" })).operations.length, 0);
    assert.equal(f.memory.stats.mutations, 1);
  } finally { observer.dispose(); await f.dispose(); }
});

test("Save receipts advance only known own revisions; a competing same-client publication gap stays visible", async () => {
  const f = await fixture("unused", false); f.editor.dispose();
  let ready!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { ready = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const client: EditorClient = { ...f.client, watch: () => () => {}, async command(name, input, options) {
    if (name === "saveFile") {
      const { clientId } = input as CommandInput<"saveFile">;
      const loaded = await f.client.command("loadRecovery", { clientId });
      await f.client.command("persistRecovery", { clientId, expectedRevision: loaded.revision, state: { ...loaded.state, sidebarWidth: 333 } });
      const result = await f.client.command(name, input, options); ready(); await wait; return result;
    }
    return f.client.command(name, input, options);
  } };
  const editor = createEditor({ client, clientId: "receipt-gap" });
  try {
    await editor.load(); await editor.openCheckout(checkout.root); await editor.open(target("a.ts")); editor.edit(target("a.ts"), "captured"); await editor.flush();
    const save = editor.save(target("a.ts")); const rejection = assert.rejects(save, /revision gap/);
    await admitted; editor.edit(target("a.ts"), "newer live text"); release(); await rejection;
    assert.equal(editor.buffer(target("a.ts"))!.text, "newer live text");
    assert.equal(editor.buffer(target("a.ts"))!.disk.text, "captured");
    assert.equal(await editor.close([target("a.ts")], async () => "discard"), false);
    assert.equal(f.memory.stats.saves, 1);
    assert.equal((await f.client.command("loadRecovery", { clientId: editor.clientId })).state.sidebarWidth, 333);
  } finally { release(); editor.dispose(); await f.dispose(); }
});

test("an observer's own Save does not rebase another dirty editor's baseline", async () => {
  const f = await fixture("origin", false), other = createEditor({ client: { ...f.client, watch: () => () => {} }, clientId: "other" });
  try {
    await other.load(); await other.openCheckout(checkout.root); await other.open(target("a.ts"));
    other.edit(target("a.ts"), "other draft"); await other.flush(); const baseline = other.buffer(target("a.ts"))!.disk;
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "saved origin"); await f.editor.flush();
    assert.equal(await f.editor.save(target("a.ts")), true);
    const durable = await f.client.command("loadRecovery", { clientId: other.clientId });
    assert.deepEqual(durable.state.drafts[0].disk, baseline);
    assert.equal(await other.save(target("a.ts")), false); assert.equal(other.buffer(target("a.ts"))!.text, "other draft");
  } finally { other.dispose(); await f.dispose(); }
});

for (const kind of ["move", "copy"] as const) test(`${kind} receipts preserve edits made while the mutation response is pending`, async () => {
  const f = await fixture("unused", false); f.editor.dispose();
  let ready!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { ready = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const client: EditorClient = { ...f.client, watch: () => () => {}, async command(name, input, options) {
    const result = await f.client.command(name, input, options);
    if (name === "mutate") { ready(); await wait; }
    return result;
  } };
  const editor = createEditor({ client, clientId: "pending-" + kind });
  try {
    await editor.load(); await editor.openCheckout(checkout.root); await editor.open(target("a.ts")); editor.edit(target("a.ts"), "captured draft");
    const sources = await editor.inspect(checkout, ["a.ts"]), baseline = editor.buffer(target("a.ts"))!.disk;
    const operation = editor.mutate({ checkout, sources, kind, destination: "destination.ts" }); await admitted;
    editor.edit(target("a.ts"), "newer live text"); release(); await operation;
    assert.equal(f.memory.stats.mutations, 1);
    assert.equal(editor.buffer(target("destination.ts"))!.text, kind === "move" ? "newer live text" : "captured draft");
    if (kind === "move") { assert.equal(editor.buffer(target("a.ts")), undefined); assert.deepEqual(editor.buffer(target("destination.ts"))!.disk, baseline); }
    else assert.equal(editor.buffer(target("a.ts"))!.text, "newer live text");
    const durable = await f.client.command("loadRecovery", { clientId: editor.clientId });
    assert.equal(durable.operations.length, 0); assert.equal(durable.state.drafts.find(draft => draft.target.path === "destination.ts")!.text, kind === "move" ? "newer live text" : "captured draft");
  } finally { release(); editor.dispose(); await f.dispose(); }
});

test("clean tabs restore current disk content while dirty tabs retain their original baseline", async () => {
  const f = await fixture("restore", false);
  try {
    await f.editor.open(target("a.ts")); await f.editor.flush(); f.editor.dispose(); f.memory.externalWrite(target("a.ts"), "latest disk");
    const restored = createEditor({ client: f.client, clientId: "restore" });
    try { await restored.load(); assert.equal(restored.buffer(target("a.ts"))!.text, "latest disk"); }
    finally { restored.dispose(); }
  } finally { await f.dispose(); }
});

for (const origin of ["own", "foreign"] as const) test(`R1 move collision retains both drafts and evidence for ${origin} outcome`, async () => {
  const f = await fixture("collision", false); f.editor.dispose();
  let admit!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const client: EditorClient = { ...f.client, watch: () => () => {}, async command(name, input, options) {
    const result = await f.client.command(name, input, options);
    if (origin === "own" && name === "mutate") { admit(); await wait; }
    return result;
  } };
  let editor = createEditor({ client, clientId: "collision-observer" });
  try {
    await editor.load(); await editor.openCheckout(checkout.root); await editor.open(target("a.ts")); editor.edit(target("a.ts"), "source edits"); await editor.flush();
    const sources = await editor.inspect(checkout, ["a.ts"]);
    let operation: Promise<unknown>;
    if (origin === "own") { operation = editor.mutate({ id: "collision", checkout, sources, kind: "move", destination: "destination.ts" }); await admitted; }
    else { await f.client.command("mutate", { id: "collision", clientId: "foreign", checkout, sources, kind: "move", destination: "destination.ts" }); operation = Promise.resolve(); }
    await editor.open(target("destination.ts")); editor.edit(target("destination.ts"), "destination edits");
    release(); await operation; if (origin === "foreign") await editor.reconcileRecovery();
    assert.equal(editor.buffer(target("a.ts"))!.text, "source edits");
    assert.equal(editor.buffer(target("destination.ts"))!.text, "destination edits");
    const retained = await f.client.command("loadRecovery", { clientId: editor.clientId });
    assert.deepEqual(retained.state.drafts.map(draft => draft.text).sort(), ["destination edits", "source edits"]);
    assert.equal(retained.operations.length, 1); assert.equal(f.memory.stats.mutations, 1);
    editor.dispose(); editor = createEditor({ client, clientId: "collision-observer" }); await editor.load();
    assert.equal(editor.buffer(target("a.ts"))!.text, "source edits");
    assert.equal(editor.buffer(target("destination.ts"))!.text, "destination edits");
    await editor.resolveOperation("collision", origin === "own" ? editor.clientId : "foreign");
    assert.equal((await f.client.command("loadRecovery", { clientId: editor.clientId })).operations.length, 1);
    assert.equal(await editor.close([target("a.ts")], async () => "discard"), true);
    await editor.resolveOperation("collision", origin === "own" ? editor.clientId : "foreign");
    assert.equal(editor.buffer(target("destination.ts"))!.text, "destination edits");
    const recent = editor.getSnapshot().recovery.recentFiles.map(fileKey); assert.equal(new Set(recent).size, recent.length);
    assert.equal((await f.client.command("loadRecovery", { clientId: editor.clientId })).operations.length, 0);
  } finally { release(); editor.dispose(); await f.dispose(); }
});

test("R1 removed checkout ignores late position recording", async () => {
  const f = await fixture();
  try {
    await f.editor.open(target("a.ts")); assert.equal(await f.editor.closeCheckout(checkout, async () => "discard"), true);
    assert.doesNotThrow(() => f.editor.position(target("a.ts"), "file", { line: 1, column: 2, top: 0, left: 0 }));
  } finally { await f.dispose(); }
});

test("R1 definitive InvalidInput Save frees the captured request while uncertain retries remain immutable", async () => {
  const f = await fixture("invalid-save", false);
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "bad\0text");
    await assert.rejects(f.editor.save(target("a.ts")), error => ApplicationError.is(error) && error.code === "InvalidInput");
    assert.equal(f.editor.buffer(target("a.ts"))!.pendingSave, undefined);
    assert.equal(f.memory.stats.saves, 0); f.editor.edit(target("a.ts"), "corrected"); assert.equal(await f.editor.save(target("a.ts")), true);
    f.editor.edit(target("a.ts"), "another\0invalid"); await assert.rejects(f.editor.save(target("a.ts")));
    assert.equal(await f.editor.prepareQuit(async () => "discard"), true);
  } finally { await f.dispose(); }
});

test("R1 missing retained dirty tab stays accessible after Trash and new missing opens leave selection alone", async () => {
  const f = await fixture("trash-activation", false);
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "recover these edits");
    await f.editor.mutate({ checkout, sources: await f.editor.inspect(checkout, ["a.ts"]), kind: "trash" });
    await f.editor.open(target("b.ts")); assert.equal(await f.editor.open(target("a.ts")), true);
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "recover these edits");
    assert.equal(await f.editor.open(target("missing.ts")), false);
    assert.equal(f.editor.getSnapshot().recovery.views[checkout.checkoutId].active, "a.ts");
    assert.match(f.editor.getSnapshot().errors.join(" "), /unavailable|retained/i);
  } finally { await f.dispose(); }
});

test("R1 restored open roots populate initial tree and Git including expanded folders", async () => {
  const f = await fixture("discover-restore", false);
  try {
    await f.editor.openCheckout(second.root); f.editor.tree(checkout, { expanded: ["folder"] }); await f.editor.flush(); f.editor.dispose();
    const restored = createEditor({ client: f.client, clientId: "discover-restore" });
    try {
      await restored.load(); const state = restored.getSnapshot();
      for (const c of [checkout, second]) { assert(state.listings[JSON.stringify([checkoutKey(c), ""])]?.entries.length); assert(state.git[checkoutKey(c)]); }
      assert(state.listings[JSON.stringify([checkoutKey(checkout), "folder"])]?.entries.length);
    } finally { restored.dispose(); }
  } finally { await f.dispose(); }
});

test("R1 a newer explicit checkout selection defeats a delayed file activation in another checkout", async () => {
  const f = await fixture("unused", false); f.editor.dispose(); let admit!: () => void, release!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const editor = createEditor({ clientId: "checkout-race", client: { ...f.client, watch: () => () => {}, async command(name, input, options) {
    if (name === "readFile") { admit(); await wait; } return f.client.command(name, input, options);
  } } });
  try {
    await editor.load(); await editor.openCheckout(checkout.root); await editor.openCheckout(second.root); editor.selectCheckout(checkout);
    const opening = editor.open(target("a.ts")); await admitted; editor.selectCheckout(second); release();
    assert.equal(await opening, false); assert.equal(editor.getSnapshot().recovery.selectedCheckoutId, second.checkoutId);
  } finally { release(); editor.dispose(); await f.dispose(); }
});

test("R1 checkout close retains exact metadata and reopens its order, comparison, positions and active file", async () => {
  const f = await fixture("checkout-memory", false);
  try {
    await f.editor.open(target("a.ts"), { view: "staged" }); await f.editor.open(target("b.ts"));
    f.editor.position(target("a.ts"), "staged", { line: 1, column: 5, top: 12, left: 2 });
    f.editor.reorder(checkout, "b.ts", 0); const before = f.editor.getSnapshot().recovery.views[checkout.checkoutId];
    assert(before); assert.deepEqual(f.editor.getSnapshot().recovery.openCheckoutIds, [checkout.checkoutId]);
    await f.editor.closeCheckout(checkout, async () => "discard"); const closed = f.editor.getSnapshot().recovery;
    assert.deepEqual(closed.checkouts, [checkout]); assert.deepEqual(closed.openCheckoutIds, []);
    assert.deepEqual(closed.views[checkout.checkoutId], before); assert(closed.recentFiles.length);
    await f.editor.openCheckout(checkout.root);
    assert.deepEqual(f.editor.getSnapshot().recovery.views[checkout.checkoutId], before);
    assert.equal(f.editor.buffer(target("b.ts"))!.text, "second");
    assert.equal(await f.editor.reopen(checkout), false);
  } finally { await f.dispose(); }
});

test("R1 memory persistence rejects composite view keys and invalid open membership", async () => {
  const f = await fixture("schema", false);
  try {
    await f.editor.flush(); const loaded = await f.client.command("loadRecovery", { clientId: f.editor.clientId });
    const state = structuredClone(loaded.state), selected = state.views[checkout.checkoutId];
    assert(selected); delete state.views[checkout.checkoutId]; state.views[checkoutKey(checkout)] = selected;
    await assert.rejects(f.client.command("persistRecovery", { clientId: f.editor.clientId, expectedRevision: loaded.revision, state }));
    for (const openCheckoutIds of [["not-known"], [checkout.checkoutId, checkout.checkoutId], []])
      await assert.rejects(f.client.command("persistRecovery", { clientId: f.editor.clientId, expectedRevision: loaded.revision, state: { ...loaded.state, openCheckoutIds } }));
  } finally { await f.dispose(); }
});

test("R1 closed checkout metadata receives operation facts without discovery or reopening", async () => {
  const f = await fixture("closed-facts", false);
  try {
    await f.editor.open(target("a.ts")); await f.editor.openCheckout(second.root); await f.editor.closeCheckout(checkout, async () => "discard");
    const sources = await f.client.command("inspectEntries", { checkout, paths: ["a.ts"] });
    await f.client.command("mutate", { id: "closed-move", clientId: "foreign", checkout, kind: "move", sources, destination: "moved.ts" });
    f.editor.dispose();
    const observed: string[] = [];
    const restored = createEditor({ clientId: "closed-facts", client: { ...f.client,
      watch(input, receive, error) { observed.push("watch:" + input.checkout.checkoutId); return f.client.watch(input, receive, error); },
      command(name, input, options) {
        if (["readFile", "listDirectory", "gitStatus", "readComparison"].includes(name)) {
          const scoped = input as { checkout?: CheckoutTarget; target?: { checkout: CheckoutTarget } };
          observed.push(name + ":" + (scoped.checkout ?? scoped.target?.checkout)?.checkoutId);
        }
        return f.client.command(name, input, options);
      },
    } });
    try {
      await restored.load(); const state = restored.getSnapshot();
      assert.equal(state.recovery.views[checkout.checkoutId].active, "moved.ts");
      assert.deepEqual(state.recovery.openCheckoutIds, [second.checkoutId]);
      assert(observed.length); assert.equal(observed.some(value => value.endsWith(":" + checkout.checkoutId)), false);
      assert.equal((await f.client.command("loadRecovery", { clientId: restored.clientId })).operations.length, 0);
    } finally { restored.dispose(); }
  } finally { await f.dispose(); }
});

test("R1 an unavailable retained comparison activates its buffer while a new comparison failure preserves selection", async () => {
  const f = await fixture("retained-comparison", false);
  try {
    await f.editor.open(target("a.ts"), { view: "staged" }); f.editor.edit(target("a.ts"), "retain in any view"); await f.editor.open(target("b.ts"));
    f.memory.failNext("readComparison"); assert.equal(await f.editor.open(target("a.ts")), true);
    assert.equal(f.editor.buffer(target("a.ts"))!.text, "retain in any view");
    f.memory.failNext("readComparison"); assert.equal(await f.editor.open(target("new.ts"), { view: "staged" }), false);
    assert.equal(f.editor.getSnapshot().recovery.views[checkout.checkoutId].active, "a.ts");
  } finally { await f.dispose(); }
});

test("R2 pre-existing persisted replacement drafts survive a foreign move and controller restart", async () => {
  const f = await fixture("persisted-collision", false);
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "original source draft");
    await f.editor.open(target("b.ts")); f.editor.edit(target("b.ts"), "original destination draft"); await f.editor.flush();
    const before = await f.client.command("loadRecovery", { clientId: f.editor.clientId });
    const sources = await f.client.command("inspectEntries", { checkout, paths: ["a.ts"] });
    const replacements = await f.client.command("inspectEntries", { checkout, paths: ["b.ts"] });
    const result = await f.client.command("mutate", { id: "persisted-replace", clientId: "foreign", checkout, kind: "move", sources, replacements, destination: "b.ts" });
    const pending = await f.client.command("loadRecovery", { clientId: f.editor.clientId });
    assert.deepEqual(pending.state.drafts, before.state.drafts);
    assert.equal(pending.revision, before.revision); assert.equal(pending.operations.length, 1);
    assert.equal(result.recoveryChanges.some(change => change.clientId === f.editor.clientId), false);
    f.editor.dispose(); const restored = createEditor({ client: f.client, clientId: f.editor.clientId });
    try {
      await restored.load();
      assert.equal(restored.buffer(target("a.ts"))!.text, "original source draft");
      assert.equal(restored.buffer(target("b.ts"))!.text, "original destination draft");
      const retained = await f.client.command("loadRecovery", { clientId: restored.clientId });
      assert.equal(new Set(retained.state.drafts.map(draft => fileKey(draft.target))).size, 2); assert.equal(retained.operations.length, 1);
      await assert.rejects(f.client.command("acknowledgeOperation", { clientId: restored.clientId, operationClientId: "foreign", id: result.id }));
      assert.equal(f.memory.stats.mutations, 1);
    } finally { restored.dispose(); }
  } finally { await f.dispose(); }
});

test("R2 definitive rejected mutation releases pending state and leaves Save, Close and Quit usable", async () => {
  const f = await fixture("rejected-move", false);
  try {
    await f.editor.open(target("a.ts")); f.editor.edit(target("a.ts"), "retained after rejection");
    const sources = await f.editor.inspect(checkout, ["a.ts"]);
    await assert.rejects(f.editor.mutate({ id: "self-move", checkout, kind: "move", sources, replacements: sources, destination: "a.ts" }), error => ApplicationError.is(error) && error.code === "InvalidInput");
    assert.equal(f.memory.stats.mutations, 0); assert.equal(f.editor.getSnapshot().operations.length, 0);
    assert.equal(await f.client.command("operationStatus", { clientId: f.editor.clientId, id: "self-move" }), null);
    assert.equal(await f.editor.save(target("a.ts")), true);
    assert.equal(await f.editor.close([target("a.ts")], async () => "discard"), true);
    assert.equal(await f.editor.prepareQuit(async () => "discard"), true);
  } finally { await f.dispose(); }
});

test("R2 closing a restored active clean file loads its survivor's remembered comparison", async () => {
  const f = await fixture("close-survivor", false);
  try {
    await f.editor.open(target("a.ts"), { view: "staged" }); await f.editor.open(target("b.ts")); await f.editor.flush(); f.editor.dispose();
    const restored = createEditor({ client: f.client, clientId: "close-survivor" });
    try {
      await restored.load(); assert.equal(restored.buffer(target("a.ts")), undefined);
      assert.equal(await restored.close([target("b.ts")], async () => "discard"), true);
      assert.equal(restored.getSnapshot().recovery.views[checkout.checkoutId].active, "a.ts");
      assert.equal(restored.buffer(target("a.ts"))!.text, "const a = 1;");
      assert.equal(restored.getSnapshot().comparisons[fileKey(target("a.ts"))].original, "const a = 0;");
    } finally { restored.dispose(); }
  } finally { await f.dispose(); }
});
