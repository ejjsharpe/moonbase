import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { ManagedRuntime } from "effect";
import { ApplicationError, type EditorClient, type FileTarget, type WorkspaceEvent } from "@moonbase/application/client";
import { makeEditorClient } from "@moonbase/application/runtime-client";
import { createEditor, fileKey, type EditorController } from "@moonbase/editor/state";
import { WorkspaceLive } from "@moonbase/workspace";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "moonbase-editor-fanin-")));
  const roots = [join(base, "alpha"), join(base, "beta")], dataDirectory = join(base, "fresh-workspace");
  for (const root of roots) {
    mkdirSync(root); mkdirSync(join(root, "folder"));
    const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", root, "-c", "user.name=Moonbase integration", "-c", "user.email=integration@example.invalid", ...args]);
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, "a.ts"), "HEAD\n"); writeFileSync(join(root, "b.ts"), "B\n"); writeFileSync(join(root, "folder/nested.ts"), "NESTED\n");
    git("add", "."); git("commit", "-qm", "Controlled initial files");
    writeFileSync(join(root, "a.ts"), "INDEX\n"); git("add", "a.ts"); writeFileSync(join(root, "a.ts"), "WORKING\n");
  }
  const runtimes: ReturnType<typeof start>[] = [], editors: EditorController[] = [];
  function start() {
    const runtime = ManagedRuntime.make(WorkspaceLive({ hostId: "fanin-local", dataDirectory,
      filesystemHelper: createRequire(import.meta.url).resolve("@moonbase/workspace/filesystem"),
      ripgrepExecutable: process.env.MOONBASE_TEST_RIPGREP ?? resolve("dist/tools/ripgrep/rg"),
    }));
    return { runtime, client: makeEditorClient(runtime) };
  }
  const launch = () => { const value = start(); runtimes.push(value); return value; };
  const current = launch();
  async function editor(clientId: string, client = current.client) { const value = createEditor({ client, clientId }); editors.push(value); await value.load(); return value; }
  return { ...current, base, roots, dataDirectory, editor, launch, async close() {
    for (const value of editors) value.dispose();
    for (const value of runtimes) await value.runtime.dispose();
    rmSync(base, { recursive: true, force: true });
  } };
}
const code = (expected: ApplicationError["code"]) => (error: unknown) => ApplicationError.is(error) && error.code === expected;

test("real Git comparisons share a working buffer and exact-checkout recovery survives a fresh runtime", { timeout: 30000 }, async () => {
  const f = fixture();
  try {
    const editor = await f.editor("comparison");
    const alpha = await editor.openCheckout(f.roots[0]), beta = await editor.openCheckout(f.roots[1]);
    const target = { checkout: alpha, path: "a.ts" }, other = { checkout: beta, path: "a.ts" };
    assert.equal(await editor.open(target), true); editor.edit(target, "DIRTY ALPHA\n");
    assert.equal(await editor.open(target, { view: "staged" }), true);
    assert.equal(editor.getSnapshot().comparisons[fileKey(target)].original, "HEAD\n");
    assert.equal(await editor.open(target, { view: "unstaged" }), true);
    assert.equal(editor.getSnapshot().comparisons[fileKey(target)].original, "INDEX\n");
    await editor.open(other); editor.edit(other, "DIRTY BETA\n");
    assert.equal(editor.getSnapshot().buffers.length, 2);
    assert.equal(await editor.save(target), true); await editor.flush();
    assert.equal(readFileSync(join(f.roots[0], "a.ts"), "utf8"), "DIRTY ALPHA\n");
    assert.equal(readFileSync(join(f.roots[1], "a.ts"), "utf8"), "WORKING\n");
    editor.dispose(); await f.runtime.dispose();
    const restarted = f.launch(), restored = await f.editor("comparison", restarted.client);
    assert.equal(restored.buffer(other)?.text, "DIRTY BETA\n");
    assert.equal(restored.buffer(other)?.disk.text, "WORKING\n");
    assert.equal(restored.getSnapshot().recovery.openCheckoutIds.length, 2);
    assert(Object.values(restored.getSnapshot().listings).filter(listing => listing.entries.some(entry => entry.path === "a.ts")).length >= 2);
  } finally { await f.close(); }
});

test("an admitted Save reply preserves newer live text and its original saved baseline across restart", { timeout: 30000 }, async () => {
  const f = fixture(), admitted = deferred(), reply = deferred(); let saves = 0;
  const gated: EditorClient = { watch: f.client.watch, command: async (operation, input, options) => {
    const result = await f.client.command(operation, input, options);
    if (operation === "saveFile") { saves++; admitted.resolve(); await reply.promise; }
    return result;
  } };
  try {
    const editor = await f.editor("save-handoff", gated), checkout = await editor.openCheckout(f.roots[0]);
    const target = { checkout, path: "a.ts" }; await editor.open(target); editor.edit(target, "CAPTURED SAVE\n"); await editor.flush();
    const saving = editor.save(target); await admitted.promise; editor.edit(target, "NEWER LIVE TEXT\n"); reply.resolve();
    assert.equal(await saving, false); assert.equal(saves, 1); await editor.flush();
    assert.equal(editor.buffer(target)?.text, "NEWER LIVE TEXT\n"); assert.equal(editor.buffer(target)?.disk.text, "CAPTURED SAVE\n");
    editor.dispose(); await f.runtime.dispose(); const restarted = f.launch(), restored = await f.editor("save-handoff", restarted.client);
    assert.equal(restored.buffer(target)?.text, "NEWER LIVE TEXT\n"); assert.equal(restored.buffer(target)?.disk.text, "CAPTURED SAVE\n");
    assert.equal(readFileSync(join(f.roots[0], "a.ts"), "utf8"), "CAPTURED SAVE\n");
  } finally { reply.resolve(); await f.close(); }
});

test("another controller's Save cannot rebase an independently persisted dirty baseline", { timeout: 30000 }, async () => {
  const f = fixture();
  try {
    const a = await f.editor("actor-a"), b = await f.editor("actor-b");
    const checkout = await a.openCheckout(f.roots[0]); await b.openCheckout(f.roots[0]); const target = { checkout, path: "a.ts" };
    await a.open(target); await b.open(target); a.edit(target, "A SAVED\n"); b.edit(target, "B RETAINED\n"); await a.flush(); await b.flush();
    const baseline = b.buffer(target)!.disk; assert.equal(await a.save(target), true);
    assert.equal(await b.save(target), false); assert.deepEqual(b.buffer(target)?.disk, baseline); assert.equal(b.buffer(target)?.text, "B RETAINED\n");
    await b.flush(); const durable = await f.client.command("loadRecovery", { clientId: "actor-b" });
    assert.deepEqual(durable.state.drafts[0].disk, baseline); assert.equal(durable.state.drafts[0].text, "B RETAINED\n");
    a.dispose(); b.dispose(); await f.runtime.dispose(); const restarted = f.launch(), restored = await f.editor("actor-b", restarted.client);
    assert.deepEqual(restored.buffer(target)?.disk, baseline); assert.equal(await restored.save(target), false);
  } finally { await f.close(); }
});

test("real move facts remain visible after origin acknowledgement until the other controller publishes", { timeout: 30000 }, async () => {
  const f = fixture(); let latest: WorkspaceEvent | undefined, release = () => {}; let paused = true;
  const delayed: EditorClient = { command: f.client.command, watch: (input, receive, onError) => {
    release = () => { paused = false; if (latest) receive(latest); };
    return f.client.watch(input, event => { if (paused) latest = event; else receive(event); }, onError);
  } };
  try {
    const a = await f.editor("move-a"), b = await f.editor("move-b", delayed);
    const checkout = await a.openCheckout(f.roots[0]); await b.openCheckout(f.roots[0]); const target = { checkout, path: "a.ts" }, moved = { checkout, path: "moved.ts" };
    await a.open(target); await b.open(target); a.edit(target, "A DRAFT\n"); b.edit(target, "B DRAFT\n"); await a.flush(); await b.flush();
    const sources = await a.inspect(checkout, ["a.ts"]);
    const result = await a.mutate({ id: "one-move", checkout, kind: "move", sources, destination: "moved.ts" });
    assert.equal(result.outcome, "completed");
    assert.equal((await f.client.command("loadRecovery", { clientId: "move-a" })).operations.length, 0);
    assert.equal((await f.client.command("loadRecovery", { clientId: "move-b" })).operations[0].id, "one-move");
    await b.reconcileRecovery(); release(); await b.flush();
    assert.equal(a.buffer(moved)?.text, "A DRAFT\n"); assert.equal(b.buffer(moved)?.text, "B DRAFT\n"); assert.equal(b.buffer(target), undefined);
    assert.equal((await f.client.command("loadRecovery", { clientId: "move-b" })).operations.length, 0);
    assert.equal(readFileSync(join(f.roots[0], "moved.ts"), "utf8"), "WORKING\n");
  } finally { release(); await f.close(); }
});

test("copy keeps both dirty drafts independently editable against actual copied disk", { timeout: 30000 }, async () => {
  const f = fixture();
  try {
    const editor = await f.editor("copy"), checkout = await editor.openCheckout(f.roots[0]), target = { checkout, path: "b.ts" }, copy = { checkout, path: "copy.ts" };
    await editor.open(target); editor.edit(target, "DIRTY SOURCE\n");
    const result = await editor.mutate({ id: "one-copy", checkout, kind: "copy", sources: await editor.inspect(checkout, ["b.ts"]), destination: "copy.ts" });
    assert.equal(result.outcome, "completed"); assert.equal(editor.buffer(copy)?.text, "DIRTY SOURCE\n"); assert.equal(editor.buffer(copy)?.disk.text, "B\n");
    assert.equal(editor.buffer(target)?.text, "DIRTY SOURCE\n"); assert.equal(await editor.save(copy), true);
    assert.equal(readFileSync(join(f.roots[0], "copy.ts"), "utf8"), "DIRTY SOURCE\n"); assert.equal(readFileSync(join(f.roots[0], "b.ts"), "utf8"), "B\n");
  } finally { await f.close(); }
});

test("actual SQLite contention vetoes discard; resolving a preflight cannot silently commit Close", { timeout: 30000 }, async () => {
  const f = fixture(); let lock: DatabaseSync | undefined;
  try {
    const editor = await f.editor("blocked-close"), checkout = await editor.openCheckout(f.roots[0]), target = { checkout, path: "a.ts" };
    await editor.open(target); editor.edit(target, "PRESERVE UNDER CONTENTION\n"); await editor.flush();
    lock = new DatabaseSync(join(f.dataDirectory, "moonbase-workspace-v1.sqlite")); lock.exec("BEGIN IMMEDIATE");
    assert.equal(await editor.close([target], async () => "discard"), false);
    assert.equal(editor.buffer(target)?.text, "PRESERVE UNDER CONTENTION\n");
    lock.exec("ROLLBACK"); lock.close(); lock = undefined;
    assert.equal(await editor.resolveRecoveryPublication(), true);
    assert.equal(editor.buffer(target)?.text, "PRESERVE UNDER CONTENTION\n");
    assert.equal((await f.client.command("loadRecovery", { clientId: "blocked-close" })).state.drafts[0].text, "PRESERVE UNDER CONTENTION\n");
    assert.equal(await editor.close([target], async () => "cancel"), false);
    assert.equal(await editor.close([target], async () => "discard"), true); assert.equal(editor.buffer(target), undefined);
  } finally { if (lock) { lock.exec("ROLLBACK"); lock.close(); } await f.close(); }
});

test("lost final Close response resolves its original SQLite receipt without adopting a later revision", { timeout: 30000 }, async () => {
  const f = fixture(); let unknown = true, finalCommits = 0;
  const transport: EditorClient = { watch: f.client.watch, command: async (operation, input, options) => {
    if (operation === "getRecoveryPublication" && unknown) throw new ApplicationError({ code: "Unavailable", message: "Controlled receipt response loss" });
    const result = await f.client.command(operation, input, options);
    if (operation === "persistRecovery" && !(input as { state: { drafts: unknown[] } }).state.drafts.length && unknown) {
      finalCommits++; throw new ApplicationError({ code: "Uncertain", message: "Controlled committed response loss" });
    }
    return result;
  } };
  try {
    // Start losing only the final publication after the draft is durably present.
    unknown = false; const editor = await f.editor("unknown-close", transport), checkout = await editor.openCheckout(f.roots[0]), target = { checkout, path: "a.ts" };
    await editor.open(target); editor.edit(target, "DISCARD ONLY ON EXACT RECEIPT\n"); await editor.flush(); unknown = true;
    assert.equal(await editor.close([target], async () => "discard"), false); assert.equal(finalCommits, 1);
    assert.equal(editor.buffer(target)?.text, "DISCARD ONLY ON EXACT RECEIPT\n"); assert.equal(editor.getSnapshot().publication?.kind, "close");
    const committed = await f.client.command("loadRecovery", { clientId: "unknown-close" }); assert.equal(committed.state.drafts.length, 0);
    await f.client.command("persistRecovery", { clientId: "unknown-close", requestId: randomUUID(), expectedRevision: committed.revision, state: { ...committed.state, sidebarWidth: 321 } });
    unknown = false; assert.equal(await editor.resolveRecoveryPublication(), true); assert.equal(editor.buffer(target), undefined);
    await assert.rejects(editor.flush(), code("Conflict")); assert.equal(finalCommits, 1);
    editor.dispose(); await f.runtime.dispose(); const restarted = f.launch(), restored = await f.editor("unknown-close", restarted.client);
    assert.equal(restored.buffer(target), undefined); assert.equal(restored.getSnapshot().recovery.sidebarWidth, 321);
  } finally { unknown = false; await f.close(); }
});

test("closed unavailable checkouts retain exact view metadata without discovery until authorized reopen", { timeout: 30000 }, async () => {
  const f = fixture(); let closedReads = 0, closedId = "";
  try {
    const editor = await f.editor("closed-root"), checkout = await editor.openCheckout(f.roots[0]), target = { checkout, path: "a.ts" };
    await editor.open(target, { view: "staged" }); editor.position(target, "staged", { line: 1, column: 2, top: 3, left: 4 });
    editor.tree(checkout, { expanded: ["folder"], focus: "folder/nested.ts" }); await editor.flush();
    assert.equal(await editor.closeCheckout(checkout, async () => "discard"), true); closedId = checkout.checkoutId;
    editor.dispose(); await f.runtime.dispose(); renameSync(f.roots[0], f.roots[0] + "-unavailable");
    const restarted = f.launch(); const observed: EditorClient = { watch: restarted.client.watch, command: async (operation, input, options) => {
      if (["readFile", "readComparison", "listDirectory", "gitStatus"].includes(operation)) {
        const value = input as { checkout?: { checkoutId: string }; target?: FileTarget };
        if ((value.checkout ?? value.target?.checkout)?.checkoutId === closedId) closedReads++;
      }
      return restarted.client.command(operation, input, options);
    } };
    const restored = await f.editor("closed-root", observed); assert.equal(closedReads, 0);
    assert.equal(restored.getSnapshot().recovery.openCheckoutIds.length, 0);
    const view = restored.getSnapshot().recovery.views[checkout.checkoutId]; assert.equal(view.active, "a.ts"); assert.equal(view.fileViews["a.ts"], "staged"); assert.deepEqual(view.tree.expanded, ["folder"]);
    renameSync(f.roots[0] + "-unavailable", f.roots[0]); assert.deepEqual(await restored.openCheckout(f.roots[0]), checkout);
    assert.equal(restored.buffer(target)?.text, "WORKING\n"); assert.equal(restored.getSnapshot().comparisons[fileKey(target)].original, "HEAD\n");
    assert.deepEqual(restored.getSnapshot().recovery.views[checkout.checkoutId].positions["a.ts"].staged, { line: 1, column: 2, top: 3, left: 4 });
    assert(closedReads > 0);
  } finally { await f.close(); }
});

test("a captured close retains a completed Save and defers every proposed Discard when a later Save conflicts", { timeout: 30000 }, async () => {
  const f = fixture();
  try {
    const editor = await f.editor("captured-batch"), checkout = await editor.openCheckout(f.roots[0]);
    const a = { checkout, path: "a.ts" }, b = { checkout, path: "b.ts" }, c = { checkout, path: "folder/nested.ts" };
    for (const target of [a, b, c]) { await editor.open(target); editor.edit(target, "DIRTY " + target.path + "\n"); }
    await editor.flush(); const baseline = editor.buffer(c)!.disk;
    writeFileSync(join(f.roots[0], c.path), "EXTERNAL WRITER\n");
    assert.equal(await editor.close([a, b, c], async buffer => buffer.target.path === b.path ? "discard" : "save"), false);
    assert.equal(readFileSync(join(f.roots[0], a.path), "utf8"), "DIRTY a.ts\n");
    assert.equal(editor.buffer(a)?.disk.text, "DIRTY a.ts\n");
    assert.equal(editor.buffer(b)?.text, "DIRTY b.ts\n"); assert.equal(readFileSync(join(f.roots[0], b.path), "utf8"), "B\n");
    assert.equal(editor.buffer(c)?.text, "DIRTY folder/nested.ts\n"); assert.deepEqual(editor.buffer(c)?.disk, baseline);
    const durable = await f.client.command("loadRecovery", { clientId: "captured-batch" });
    assert.equal(durable.state.drafts.find(draft => draft.target.path === b.path)?.text, "DIRTY b.ts\n");
    assert.deepEqual(durable.state.drafts.find(draft => draft.target.path === c.path)?.disk, baseline);
    assert.equal(durable.state.views[checkout.checkoutId].openFiles.length, 3);
    assert.equal(await editor.prepareQuit(async () => "cancel"), false);
  } finally { await f.close(); }
});
