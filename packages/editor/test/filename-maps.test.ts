import assert from "node:assert/strict";
import { test } from "node:test";
import { ManagedRuntime } from "effect";
import { makeEditorClient } from "@moonbase/application/runtime-client";
import { createEditor } from "@moonbase/editor/state";
import { memoryWorkspace } from "@moonbase/editor/memory";

const checkout = { hostId: "local", checkoutId: "filenames", projectId: "project", root: "/memory/filenames", branch: "main" };
const names = ["__proto__", "constructor", "toString", "hasOwnProperty"];
const target = (path: string) => ({ checkout, path });
const cursor = { line: 1, column: 3, top: 0, left: 0 };
function protectPrototypes() {
  const objects = [Object.prototype, Object, Object.prototype.toString, Object.prototype.hasOwnProperty];
  const snapshots = objects.map(value => Object.getOwnPropertyDescriptors(value));
  return {
    assertUnchanged() { objects.forEach((value, index) => assert.deepEqual(Object.getOwnPropertyDescriptors(value), snapshots[index])); },
    restore() { objects.forEach((value, index) => { for (const key of Reflect.ownKeys(value)) if (!Object.hasOwn(snapshots[index], key)) Reflect.deleteProperty(value, key); Object.defineProperties(value, snapshots[index]); }); },
  };
}

test("filename caret state never mutates inherited prototypes", async () => {
  const prototypes = protectPrototypes();
  const memory = memoryWorkspace([{ checkout, files: Object.fromEntries([["__proto__", "baseline"]]) }]);
  const runtime = ManagedRuntime.make(memory.layer), editor = createEditor({ client: makeEditorClient(runtime), clientId: "prototype" });
  try {
    await editor.load(); await editor.openCheckout(checkout.root); await editor.open(target("__proto__"), { view: "file" });
    editor.position(target("__proto__"), "file", cursor);
    prototypes.assertUnchanged();
    const view = editor.getSnapshot().recovery.views[checkout.checkoutId];
    assert(Object.hasOwn(view.fileViews, "__proto__")); assert(Object.hasOwn(view.positions, "__proto__"));
    assert.deepEqual(view.positions.__proto__.file, cursor);
  } finally { prototypes.restore(); editor.dispose(); await runtime.dispose(); }
});

test("prototype-shaped filenames keep own JSON view keys through Save, reopen, restart and move reconciliation", async () => {
  const prototypes = protectPrototypes(), files = Object.fromEntries(["sibling.ts", ...names].map(path => [path, "baseline " + path]));
  const memory = memoryWorkspace([{ checkout, files, head: files, index: files }]);
  const runtime = ManagedRuntime.make(memory.layer), client = makeEditorClient(runtime);
  let editor = createEditor({ client, clientId: "filenames" });
  try {
    await editor.load(); await editor.openCheckout(checkout.root); await editor.open(target("sibling.ts")); editor.edit(target("sibling.ts"), "retained sibling");
    for (const path of names) {
      assert.equal(await editor.open(target(path)), true);
      editor.edit(target(path), "saved " + path); assert.equal(await editor.save(target(path)), true);
      assert.equal((await client.command("readFile", target(path))).text, "saved " + path);
      await editor.open(target(path), { view: "staged" }); editor.position(target(path), "staged", cursor); editor.position(target(path), "staged:original", cursor);
      editor.edit(target(path), "newer dirty " + path);
    }
    await editor.flush();
    const persisted = (await client.command("loadRecovery", { clientId: "filenames" })).state;
    const json = JSON.parse(JSON.stringify(persisted));
    for (const path of names) { assert(Object.hasOwn(json.views[checkout.checkoutId].fileViews, path)); assert(Object.hasOwn(json.views[checkout.checkoutId].positions, path)); }
    editor.dispose(); editor = createEditor({ client, clientId: "filenames" }); await editor.load();
    for (const path of names) {
      assert.equal(await editor.open(target(path)), true);
      assert.equal(editor.buffer(target(path))?.text, "newer dirty " + path);
      assert.equal(editor.buffer(target(path))?.disk.text, "saved " + path);
      assert.deepEqual(editor.getSnapshot().recovery.views[checkout.checkoutId].positions[path].staged, cursor);
      assert.equal(await editor.close([target(path)], async () => "save"), true);
      assert.equal(await editor.reopen(checkout), true);
      assert.equal(editor.getSnapshot().recovery.views[checkout.checkoutId].fileViews[path], "staged");
    }
    assert.equal(editor.buffer(target("sibling.ts"))?.text, "retained sibling");
    const source = target("__proto__"); editor.edit(source, "dirty moved text");
    await editor.mutate({ checkout, kind: "move", sources: await editor.inspect(checkout, [source.path]), destination: "moved.ts" });
    await editor.mutate({ checkout, kind: "move", sources: await editor.inspect(checkout, ["moved.ts"]), destination: "__proto__" });
    await editor.flush(); editor.dispose(); editor = createEditor({ client, clientId: "filenames" }); await editor.load();
    assert.equal(editor.buffer(source)?.text, "dirty moved text");
    assert.deepEqual(editor.getSnapshot().recovery.views[checkout.checkoutId].positions.__proto__.staged, cursor);
    for (const [from, destination] of [["__proto__", "foreign.ts"], ["foreign.ts", "__proto__"]]) {
      await client.command("mutate", { checkout, clientId: "foreign", id: crypto.randomUUID(), kind: "move", sources: await client.command("inspectEntries", { checkout, paths: [from] }), destination });
      await editor.reconcileRecovery();
    }
    await editor.flush();
    assert.equal(editor.buffer(source)?.text, "dirty moved text");
    assert.equal(memory.stats.mutations, 4);
    assert(Object.hasOwn(editor.getSnapshot().recovery.views[checkout.checkoutId].positions, "__proto__"));
    prototypes.assertUnchanged();
  } finally { prototypes.restore(); editor.dispose(); await runtime.dispose(); }
});


test("untracked prototype-shaped filenames never inherit a demo Git baseline", async () => {
  const memory = memoryWorkspace([{ checkout, files: Object.fromEntries(names.map(path => [path, "working"])), head: {}, index: {} }]);
  const runtime = ManagedRuntime.make(memory.layer), client = makeEditorClient(runtime);
  try {
    assert.deepEqual((await client.command("gitStatus", { checkout })).changes.map(change => [change.path, change.area]), names.map(path => [path, "untracked"]));
    for (const path of names) {
      for (const area of ["staged", "unstaged"] as const) await assert.rejects(client.command("readComparison", { target: target(path), area }), /Git baseline unavailable/);
      assert.equal((await client.command("readComparison", { target: target(path), area: "untracked" })).original, "");
    }
  } finally { await runtime.dispose(); }
});
