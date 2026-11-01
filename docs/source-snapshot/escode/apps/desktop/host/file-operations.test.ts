import { test, expect, vi } from "vite-plus/test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as child from "node:child_process";
import { Checkout } from "./project";
import { Workspace } from "./recovery-fixture";
import { FileOperationJournal } from "./recovery-fixture";
import { FileOperations } from "./file-operations";
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
}));
async function fixture(run: (p: Checkout, store: Workspace, base: string) => Promise<void>) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "escode-operations-")));
  const root = join(base, "repo");
  execFileSync("git", ["init", root]);
  mkdirSync(join(root, "folder"));
  writeFileSync(join(root, "folder/a.ts"), "disk");
  writeFileSync(join(root, "folder/b.ts"), "second disk");
  const p = await Checkout.open(root);
  const store = new Workspace(join(base, "workspace.json"));
  await store.write({
    projects: [{ project: root, root }],
    selected: root,
    views: { [root]: { path: "folder/a.ts", directory: "folder", openFiles: ["folder/a.ts", "folder/b.ts"] } },
    drafts: await Promise.all(
      ["a", "b"].map(async (name) => ({
        root,
        path: `folder/${name}.ts`,
        text: `${name} unsaved`,
        disk: await p.read(`folder/${name}.ts`),
      })),
    ),
  });
  try {
    await run(p, store, base);
  } finally {
    vi.restoreAllMocks();
    p.close();
    rmSync(base, { recursive: true, force: true });
  }
}
test("real folder move preserves descendant drafts and conflict baseline through a fresh store", async () =>
  fixture(async (p, store, base) => {
    const before = await store.read();
    before.views[p.root].files!.hideIgnored = true;
    before.views[p.root].openFiles = ["folder/b.ts", "folder/a.ts"];
    before.views[p.root].preview = "folder/b.ts";
    before.views[p.root].fileViews = { "folder/a.ts": "unstaged" };
    before.views[p.root].editorPositions = { "folder/a.ts": { unstaged: { line: 3, column: 2, top: 50, left: 0 } } };
    await store.write(before);
    const ops = new FileOperations(store, join(base, "intent.json"));
    await ops.run(p, "move", "folder", "renamed");
    const state = await new Workspace(join(base, "workspace.json")).read();
    expect(state.views[p.root].openFiles).toEqual(["renamed/b.ts", "renamed/a.ts"]);
    expect(state.views[p.root].preview).toBe("renamed/b.ts");
    expect(state.views[p.root].fileViews).toEqual({ "renamed/a.ts": "unstaged" });
    expect(state.views[p.root].editorPositions?.["renamed/a.ts"].unstaged.line).toBe(3);
    expect(state.drafts.map((d) => d.path)).toEqual(["renamed/a.ts", "renamed/b.ts"]);
    expect(state.drafts[0].text).toBe("a unsaved");
    expect(state.views[p.root].files).toEqual({
      hideIgnored: true,
      expanded: ["renamed"],
      selected: ["renamed/a.ts"],
      focus: "renamed/a.ts",
      scroll: 0,
    });
    expect(readFileSync(join(p.root, "renamed/a.ts"), "utf8")).toBe("disk");
    writeFileSync(join(p.root, "renamed/a.ts"), "external");
    expect((await p.save("renamed/a.ts", "a unsaved", state.drafts[0].disk.version)).kind).toBe(
      "conflict",
    );
    expect(existsSync(join(p.root, "folder"))).toBe(false);
  }));
test("restart reconciles a crash immediately after native rename, before completion is journalled", async () =>
  fixture(async (p, store, base) => {
    const before = await store.read();
    before.views[p.root].files!.hideIgnored = true;
    before.views[p.root].openFiles = ["folder/b.ts", "folder/a.ts"];
    before.views[p.root].fileViews = { "folder/a.ts": "unstaged" };
    before.views[p.root].editorPositions = { "folder/a.ts": { file: { line: 2, column: 3, top: 40, left: 0 } } };
    await store.write(before);
    const file = join(base, "intent.json");
    const journal = new FileOperationJournal(file);
    await journal.writeIntent({
      root: p.root,
      checkoutIdentity: p.checkoutIdentity(),
      source: "folder",
      destination: "moved",
      kind: "move",
      identity: p.operationIdentity("folder"),
    });
    p.move("folder", "moved", p.operationIdentity("folder"));
    const fresh = new FileOperations(new Workspace(join(base, "workspace.json")), file);
    expect(await fresh.recover(async () => p)).toContain("Recovered move");
    expect((await store.read()).drafts[1].path).toBe("moved/b.ts");
    expect((await store.read()).views[p.root].files).toEqual({
      hideIgnored: true,
      expanded: ["moved"],
      selected: ["moved/a.ts"],
      focus: "moved/a.ts",
      scroll: 0,
    });
    const restored = await store.read();
    expect(restored.views[p.root].openFiles).toEqual(["moved/b.ts", "moved/a.ts"]);
    expect(restored.views[p.root].path).toBe("moved/a.ts");
    expect(restored.views[p.root].fileViews).toEqual({ "moved/a.ts": "unstaged" });
    expect(restored.views[p.root].editorPositions?.["moved/a.ts"].file).toEqual({ line: 2, column: 3, top: 40, left: 0 });
    expect(readFileSync(join(p.root, "moved/a.ts"), "utf8")).toBe("disk");
    expect(restored.drafts[0]).toMatchObject({ text: "a unsaved", disk: { text: "disk" } });
    expect(await journal.readIntent()).toBe(null);
  }));
test("persistence failure after mutation returns the actual outcome and restart recovers edits", async () =>
  fixture(async (p, store, base) => {
    const ops = new FileOperations(store, join(base, "intent.json"));
    vi.spyOn(store, "write").mockRejectedValueOnce(Error("injected disk full"));
    const result = await ops.run(p, "move", "folder", "moved");
    expect(result.applied).toBe(true);
    expect(result.message).toContain("persistence");
    expect(
      await new FileOperations(
        new Workspace(join(base, "workspace.json")),
        join(base, "intent.json"),
      ).recover(async () => p),
    ).toContain("Recovered move");
    expect((await store.read()).drafts[0].path).toBe("moved/a.ts");
  }));
test("occupied, traversal, protected metadata, descendant and replaced checkout paths fail safely", async () =>
  fixture(async (p) => {
    writeFileSync(join(p.root, "occupied"), "retain");
    for (const target of ["occupied", "../outside", ".git/new", "folder/child", ""])
      expect(() => p.move("folder", target, p.operationIdentity("folder"))).toThrow();
    expect(() => p.trash(".", "ignored")).toThrow();
    mkdirSync(join(p.root, "folder/.git"));
    expect(() => p.move("folder", "moved", p.operationIdentity("folder"))).toThrow();
    renameSync(p.root, p.root + "-old");
    mkdirSync(p.root);
    expect(() => p.operationIdentity("folder")).toThrow("replaced");
  }));
for (const kind of ["move", "trash"] as const)
  test(`${kind} rejects a symlink-parent swap at native execution`, async () =>
    fixture(async (p, _store, base) => {
      const outside = join(base, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "a.ts"), "outside");
      const id = p.operationIdentity("folder/a.ts");
      const execute = child.execFileSync;
      vi.spyOn(child, "execFileSync").mockImplementation((...args) => {
        if (Array.isArray(args[1]) && args[1][0] === kind) {
          renameSync(join(p.root, "folder"), join(p.root, "original"));
          symlinkSync(outside, join(p.root, "folder"));
        }
        return execute(...args);
      });
      expect(() =>
        kind === "move" ? p.move("folder/a.ts", "new", id) : p.trash("folder/a.ts", id),
      ).toThrow();
      expect(readFileSync(join(outside, "a.ts"), "utf8")).toBe("outside");
    }));
test("native macOS Trash returns a recoverable disk object with unchanged bytes", async () =>
  fixture(async (p) => {
    const destination = p.trash("folder", p.operationIdentity("folder"));
    expect(destination).toContain(".Trash/");
    expect(existsSync(join(p.root, "folder"))).toBe(false);
    expect(readFileSync(join(destination, "a.ts"), "utf8")).toBe("disk");
    // Test-owned fixture only; production has no permanent-delete fallback.
    rmSync(destination, { recursive: true });
  }));
test("case-only rename keeps the same object and failed Trash preserves durable drafts", async () =>
  fixture(async (p, store, base) => {
    const id = p.operationIdentity("folder/a.ts");
    p.move("folder/a.ts", "folder/A.ts", id);
    expect(p.operationIdentity("folder/A.ts")).toBe(id);
    const ops = new FileOperations(store, join(base, "intent.json"));
    vi.spyOn(p, "trash").mockImplementationOnce(() => {
      throw Error("injected Trash failure");
    });
    await expect(ops.run(p, "trash", "folder", "")).rejects.toThrow("injected Trash failure");
    expect((await new Workspace(join(base, "workspace.json")).read()).drafts).toHaveLength(2);
    ops.assertIdle();
  }));
test("uncertain native outcome retains drafts and blocks mutations across a fresh store", async () =>
  fixture(async (p, store, base) => {
    const file = join(base, "intent.json");
    const journal = new FileOperationJournal(file);
    await journal.writeIntent({
      root: p.root,
      checkoutIdentity: p.checkoutIdentity(),
      source: "folder",
      destination: "moved",
      kind: "move",
      identity: p.operationIdentity("folder"),
    });
    renameSync(join(p.root, "folder"), join(p.root, "external-name"));
    const fresh = new FileOperations(new Workspace(join(base, "workspace.json")), file);
    expect(await fresh.recover(async () => p)).toContain("Uncertain file operation");
    expect(() => fresh.assertIdle()).toThrow("pending reconciliation");
    await expect(fresh.ack(p.root)).rejects.toThrow("Uncertain operation");
    expect((await store.read()).drafts[0].text).toBe("a unsaved");
    expect((await store.read()).views[p.root].openFiles).toEqual(["folder/a.ts", "folder/b.ts"]);
    expect(readFileSync(join(p.root, "external-name/a.ts"), "utf8")).toBe("disk");
    expect(await journal.readIntent()).not.toBe(null);
    expect(existsSync(join(p.root, "folder"))).toBe(false);
  }));
test("destination parent swap cannot overwrite files outside the checkout", async () =>
  fixture(async (p, _store, base) => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    mkdirSync(join(p.root, "target"));
    const execute = child.execFileSync;
    vi.spyOn(child, "execFileSync").mockImplementation((...args) => {
      if (Array.isArray(args[1]) && args[1][0] === "move") {
        renameSync(join(p.root, "target"), join(p.root, "target-old"));
        symlinkSync(outside, join(p.root, "target"));
      }
      return execute(...args);
    });
    expect(() =>
      p.move("folder/a.ts", "target/new.ts", p.operationIdentity("folder/a.ts")),
    ).toThrow();
    expect(existsSync(join(outside, "new.ts"))).toBe(false);
    expect(readFileSync(join(p.root, "folder/a.ts"), "utf8")).toBe("disk");
  }));
test("origin is revalidated after durable intent and before filesystem mutation", async () =>
  fixture(async (p, store, base) => {
    const file = join(base, "intent.json");
    const ops = new FileOperations(store, file);
    await expect(
      ops.run(p, "move", "folder", "moved", () => {
        throw Error("origin closed while intent persisted");
      }),
    ).rejects.toThrow("origin closed");
    expect(readFileSync(join(p.root, "folder/a.ts"), "utf8")).toBe("disk");
    expect((await store.read()).drafts[0].text).toBe("a unsaved");
    ops.assertIdle();
  }));
test("case-only dirty folder move maps descendants without mistaking them for destination drafts", async () =>
  fixture(async (p, store, base) => {
    await new FileOperations(store, join(base, "intent.json")).run(p, "move", "folder", "FOLDER");
    expect((await store.read()).drafts.map((d) => d.path)).toEqual(["FOLDER/a.ts", "FOLDER/b.ts"]);
  }));

test("create is exclusive, basename-only and protects roots, metadata and missing parents", async () =>
  fixture(async (p) => {
    expect(p.create("folder", "new.txt", "file")).toBe("folder/new.txt");
    expect(await p.read("folder/new.txt")).toMatchObject({ text: "" });
    expect(p.create("", "empty", "folder")).toBe("empty");
    expect(await p.files("empty")).toEqual([]);
    for (const name of [
      "",
      " ",
      ".",
      "..",
      "../escape",
      "/absolute",
      "a/b",
      "a\\b",
      ".GIT",
      "a\0b",
    ])
      expect(() => p.create("", name, "file")).toThrow();
    expect(() => p.renameDestination("folder/a.ts", "../escape")).toThrow();
    expect(() => p.create("folder", "a.ts", "file")).toThrow();
    expect(() => p.create("", "folder", "folder")).toThrow();
    expect(() => p.create("missing", "a", "file")).toThrow();
    expect(() => p.create(".git", "a", "file")).toThrow();
    expect(readFileSync(join(p.root, "folder/a.ts"), "utf8")).toBe("disk");
    renameSync(p.root, p.root + "-old");
    mkdirSync(p.root);
    expect(() => p.create("", "a", "file")).toThrow("replaced");
  }));

for (const replacement of ["directory", "symlink"])
  test(`create rejects ${replacement} parent swaps at native execution`, async () =>
    fixture(async (p, _store, base) => {
      const outside = join(base, "outside");
      mkdirSync(outside);
      const execute = child.execFileSync;
      vi.spyOn(child, "execFileSync").mockImplementation((...args) => {
        if (Array.isArray(args[1]) && args[1][0] === "create") {
          renameSync(join(p.root, "folder"), join(p.root, "original"));
          if (replacement === "symlink") symlinkSync(outside, join(p.root, "folder"));
          else mkdirSync(join(p.root, "folder"));
        }
        return execute(...args);
      });
      expect(() => p.create("folder", "new", "file")).toThrow();
      expect(existsSync(join(outside, "new"))).toBe(false);
      expect(existsSync(join(p.root, "original/new"))).toBe(false);
    }));

test("Trash permission and missing-source failures preserve drafts in a fresh store", async () =>
  fixture(async (p, store, base) => {
    const ops = new FileOperations(store, join(base, "intent.json"));
    chmodSync(join(p.root, "folder"), 0o555);
    try {
      await expect(ops.run(p, "trash", "folder/a.ts", "")).rejects.toThrow();
      expect(readFileSync(join(p.root, "folder/a.ts"), "utf8")).toBe("disk");
      ops.assertIdle();
    } finally {
      chmodSync(join(p.root, "folder"), 0o755);
    }
    rmSync(join(p.root, "folder/a.ts"));
    await expect(ops.run(p, "trash", "folder/a.ts", "")).rejects.toThrow();
    expect(
      (await new Workspace(join(base, "workspace.json")).read()).drafts.map((d) => d.text),
    ).toEqual(["a unsaved", "b unsaved"]);
    ops.assertIdle();
  }));

test("batch save persists the completed baseline without replacing newer recoverable text", async () =>
  fixture(async (p, store, base) => {
    const ops = new FileOperations(store, join(base, "intent.json"));
    const state = await store.read();
    state.drafts[0].text = "newer available edit";
    await store.write(state);
    const saved = await ops.save(
      p,
      "folder/a.ts",
      "completed save",
      state.drafts[0].disk.version,
      () => {},
    );
    expect(saved.kind).toBe("saved");
    const fresh = await new Workspace(join(base, "workspace.json")).read();
    expect(fresh.drafts[0].text).toBe("newer available edit");
    expect(fresh.drafts[0].disk.text).toBe("completed save");
    expect(
      (await p.save("folder/a.ts", "newer available edit", fresh.drafts[0].disk.version)).kind,
    ).toBe("saved");
    ops.assertIdle();
  }));

test("saved disk outcome survives baseline persistence failure and fresh journal recovery", async () =>
  fixture(async (p, store, base) => {
    const file = join(base, "intent.json"),
      ops = new FileOperations(store, file);
    const draft = (await store.read()).drafts[0];
    vi.spyOn(store, "write").mockRejectedValueOnce(Error("save baseline denied"));
    const result = await ops.save(p, draft.path, draft.text, draft.disk.version, () => {});
    expect(result).toMatchObject({ kind: "saved", persistencePending: true });
    expect(readFileSync(join(p.root, draft.path), "utf8")).toBe(draft.text);
    expect(() => ops.assertIdle()).toThrow("pending reconciliation");
    const freshStore = new Workspace(join(base, "workspace.json"));
    expect(await new FileOperations(freshStore, file).recover(async () => p)).toContain(
      "Recovered saved baseline",
    );
    expect((await freshStore.read()).drafts[0]).toMatchObject({
      text: draft.text,
      disk: { text: draft.text },
    });
  }));

test("restart reconciles a save interrupted after replacement but before completion was journalled", async () =>
  fixture(async (p, store, base) => {
    const file = join(base, "intent.json"),
      draft = (await store.read()).drafts[0];
    await new FileOperationJournal(file).writeIntent({
      root: p.root,
      checkoutIdentity: p.checkoutIdentity(),
      source: draft.path,
      destination: "",
      kind: "save",
      identity: p.operationIdentity(draft.path),
      saveText: draft.text,
    });
    await p.save(draft.path, draft.text, draft.disk.version);
    expect(await new FileOperations(store, file).recover(async () => p)).toContain(
      "Recovered saved baseline",
    );
    const fresh = (await new Workspace(join(base, "workspace.json")).read()).drafts[0];
    expect(fresh.disk.text).toBe(draft.text);
    writeFileSync(join(p.root, draft.path), "external after completed save");
    expect((await p.save(draft.path, "new available edit", fresh.disk.version)).kind).toBe(
      "conflict",
    );
  }));

test("failed baseline acknowledgement retains pending save and does not deny the completed save", async () =>
  fixture(async (p, store, base) => {
    const file = join(base, "intent.json"),
      ops = new FileOperations(store, file),
      draft = (await store.read()).drafts[0];
    vi.spyOn(ops, "ack").mockRejectedValueOnce(Error("save ack denied"));
    expect(await ops.save(p, draft.path, draft.text, draft.disk.version, () => {})).toMatchObject({
      kind: "saved",
      persistencePending: true,
    });
    expect((await store.read()).drafts[0].disk.text).toBe(draft.text);
    expect(() => ops.assertIdle()).toThrow("pending reconciliation");
    expect(await new FileOperations(store, file).recover(async () => p)).toContain(
      "Recovered saved baseline",
    );
  }));

test("origin closure after save intent prevents saving and leaves the original baseline", async () =>
  fixture(async (p, store, base) => {
    const ops = new FileOperations(store, join(base, "intent.json")),
      draft = (await store.read()).drafts[0];
    await expect(
      ops.save(p, draft.path, draft.text, draft.disk.version, () => {
        throw Error("origin closed");
      }),
    ).rejects.toThrow("origin closed");
    expect(readFileSync(join(p.root, draft.path), "utf8")).toBe("disk");
    expect((await store.read()).drafts[0].disk.text).toBe("disk");
    ops.assertIdle();
  }));

test("interrupted save intent before replacement keeps the original draft and baseline", async () =>
  fixture(async (p, store, base) => {
    const file = join(base, "intent.json"),
      draft = (await store.read()).drafts[0];
    await new FileOperationJournal(file).writeIntent({
      root: p.root,
      checkoutIdentity: p.checkoutIdentity(),
      source: draft.path,
      destination: "",
      kind: "save",
      identity: p.operationIdentity(draft.path),
      saveText: draft.text,
    });
    expect(await new FileOperations(store, file).recover(async () => p)).toContain(
      "did not replace",
    );
    expect((await store.read()).drafts[0]).toEqual(draft);
    expect(await new FileOperationJournal(file).readIntent()).toBe(null);
  }));

test("ambiguous interrupted save retains its draft and blocks later mutations", async () =>
  fixture(async (p, store, base) => {
    const file = join(base, "intent.json"),
      draft = (await store.read()).drafts[0];
    await new FileOperationJournal(file).writeIntent({
      root: p.root,
      checkoutIdentity: p.checkoutIdentity(),
      source: draft.path,
      destination: "",
      kind: "save",
      identity: p.operationIdentity(draft.path),
      saveText: draft.text,
    });
    await p.save(draft.path, "different external replacement", draft.disk.version);
    const fresh = new FileOperations(store, file);
    expect(await fresh.recover(async () => p)).toContain("Uncertain file operation");
    expect((await store.read()).drafts[0]).toEqual(draft);
    expect(() => fresh.assertIdle()).toThrow("pending reconciliation");
    await expect(fresh.ack(p.root)).rejects.toThrow("Uncertain operation");
  }));

test("whole batch facts protect stale navigation snapshots until renderer acknowledgement", async () =>
  fixture(async (p, store, base) => {
    const ops = new FileOperations(store, join(base, "intent.json"));
    const stale = await store.read();
    stale.views[p.root].files!.hideIgnored = true;
    await store.write(stale);
    ops.beginBatch(p.root);
    const saved = await ops.save(
      p,
      stale.drafts[0].path,
      stale.drafts[0].text,
      stale.drafts[0].disk.version,
      () => {},
    );
    expect(saved.kind).toBe("saved");
    let trash = "";
    const nativeTrash = p.trash.bind(p);
    vi.spyOn(p, "trash").mockImplementation((...args) => (trash = nativeTrash(...args)));
    try {
      await ops.run(p, "trash", "folder/b.ts", "");
      await ops.ack();
      stale.selected = "agents";
      stale.drafts[0].text = "newer available text";
      await ops.persist(stale);
      const fresh = await new Workspace(join(base, "workspace.json")).read();
      expect(fresh.selected).toBe("agents");
      expect(fresh.views[p.root].files!.hideIgnored).toBe(true);
      expect(fresh.views[p.root].openFiles).toEqual(["folder/a.ts"]);
      expect(fresh.views[p.root].path).toBe("folder/a.ts");
      expect(fresh.drafts).toHaveLength(1);
      expect(fresh.drafts[0]).toMatchObject({
        text: "newer available text",
        disk: { text: "a unsaved" },
      });
      expect(() => ops.assertIdle()).toThrow("pending reconciliation");
      await ops.ack(p.root);
      ops.assertIdle();
      p.create("folder", "b.ts", "file");
      fresh.drafts.push({
        root: p.root,
        path: "folder/b.ts",
        text: "new incarnation",
        disk: await p.read("folder/b.ts"),
      });
      await ops.persist(fresh);
      expect((await store.read()).drafts[1].text).toBe("new incarnation");
      expect((await store.read()).views[p.root].files!.hideIgnored).toBe(true);
    } finally {
      if (trash) rmSync(trash);
    }
  }));

test("renderer acknowledgement of earlier batch facts never clears an uncertain later item", async () =>
  fixture(async (p, store, base) => {
    const ops = new FileOperations(store, join(base, "intent.json")),
      draft = (await store.read()).drafts[0];
    ops.beginBatch(p.root);
    await ops.save(p, draft.path, draft.text, draft.disk.version, () => {});
    vi.spyOn(p, "trash").mockImplementationOnce(() => {
      renameSync(join(p.root, "folder/b.ts"), join(p.root, "elsewhere.ts"));
      throw Error("unknown native outcome");
    });
    await expect(ops.run(p, "trash", "folder/b.ts", "")).rejects.toThrow("Uncertain");
    await ops.persist(await store.read());
    await ops.ack(p.root);
    expect(() => ops.assertIdle()).toThrow("pending reconciliation");
    const pending = await new FileOperationJournal(join(base, "intent.json")).readIntent();
    expect(pending?.source).toBe("folder/b.ts");
    expect(pending?.completed).not.toBe(true);
    const fresh = new FileOperations(new Workspace(join(base, "workspace.json")), join(base, "intent.json"));
    expect(await fresh.recover(async () => p)).toContain("Uncertain file operation");
    expect(() => fresh.assertIdle()).toThrow("pending reconciliation");
    const retained = await store.read();
    expect(retained.views[p.root].openFiles).toEqual(["folder/a.ts", "folder/b.ts"]);
    expect(retained.drafts[1]).toMatchObject({ path: "folder/b.ts", text: "b unsaved", disk: { text: "second disk" } });
    expect(readFileSync(join(p.root, "elsewhere.ts"), "utf8")).toBe("second disk");
    expect(existsSync(join(p.root, "folder/b.ts"))).toBe(false);
  }));

test("async folder copy carries dirty descendants over actual copied bytes and preserves originals across restart", async () =>
  fixture(async (p, store, base) => {
    const ops = new FileOperations(store, join(base, "intent.json"));
    ops.beginBatch(p.root);
    const stale = await store.read();
    stale.views[p.root].files!.hideIgnored = true;
    await store.write(stale);
    const result = await ops.run(p, "copy", "folder", "copied");
    expect(result.applied).toBe(true);
    expect(readFileSync(join(p.root, "copied/a.ts"), "utf8")).toBe("disk");
    expect(readFileSync(join(p.root, "copied/b.ts"), "utf8")).toBe("second disk");
    await ops.persist(stale);
    const fresh = new Workspace(join(base, "workspace.json"));
    const drafts = (await fresh.read()).drafts;
    expect(drafts.map((d) => d.path)).toEqual([
      "folder/a.ts",
      "folder/b.ts",
      "copied/a.ts",
      "copied/b.ts",
    ]);
    expect(drafts[2].text).toBe("a unsaved");
    expect(drafts[2].disk).toEqual(await p.read("copied/a.ts"));
    expect(
      await new FileOperations(fresh, join(base, "intent.json")).recover(async () => p),
    ).toContain("Recovered copy");
    expect((await fresh.read()).views[p.root].files!.hideIgnored).toBe(true);
    expect((await p.save("copied/a.ts", drafts[2].text, drafts[2].disk.version)).kind).toBe(
      "saved",
    );
    expect(readFileSync(join(p.root, "folder/a.ts"), "utf8")).toBe("disk");
  }));

test("binary copy exceeds editor limit and lets the host event loop run", async () =>
  fixture(async (p, store, base) => {
    const bytes = Buffer.alloc(32 * 1024 * 1024, 173);
    writeFileSync(join(p.root, "large.bin"), bytes);
    const ops = new FileOperations(store, join(base, "intent.json"));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const start = performance.now();
    try {
      const result = await ops.run(p, "copy", "large.bin", "large-copy.bin");
      expect(result.applied).toBe(true);
      expect(readFileSync(join(p.root, "large-copy.bin")).equals(bytes)).toBe(true);
      expect(ticks).toBeGreaterThan(0);
      console.log(
        `32 MiB native binary copy: ${(performance.now() - start).toFixed(1)} ms, event loop ticks: ${ticks}`,
      );
    } finally {
      clearInterval(timer);
    }
  }));

test("recursive unsupported source is reported without publishing a partial destination", async () =>
  fixture(async (p, store, base) => {
    symlinkSync(join(p.root, "folder/a.ts"), join(p.root, "folder/link"));
    const ops = new FileOperations(store, join(base, "intent.json"));
    await expect(ops.run(p, "copy", "folder", "copied")).rejects.toThrow();
    expect(existsSync(join(p.root, "copied"))).toBe(false);
    expect((await store.read()).drafts).toHaveLength(2);
  }));

test("native copy success stays applied through persistence failure and stale navigation writes", async () =>
  fixture(async (p, store, base) => {
    const file = join(base, "intent.json"),
      ops = new FileOperations(store, file);
    const stale = await store.read();
    ops.beginBatch(p.root);
    const write = vi.spyOn(store, "write").mockRejectedValueOnce(Error("copy persistence denied"));
    const result = await ops.run(p, "copy", "folder", "copied");
    expect(result).toMatchObject({ applied: true, persistencePending: true });
    expect(result.message).toContain("copy persistence denied");
    expect(readFileSync(join(p.root, "copied/a.ts"), "utf8")).toBe("disk");
    write.mockRestore();
    stale.selected = "Agents";
    await ops.persist(stale);
    expect((await store.read()).drafts.find((d) => d.path === "copied/a.ts")?.text).toBe(
      "a unsaved",
    );
    await expect(ops.run(p, "move", "folder", "other")).rejects.toThrow("pending reconciliation");
    expect(await new FileOperations(store, file).recover(async () => p)).toContain(
      "Recovered copy",
    );
    expect((await store.read()).selected).toBe("Agents");
  }));

test("copy rejects occupied case variants and descendant destinations without changing disk bytes", async () =>
  fixture(async (p, store, base) => {
    expect(() => p.validateMove("folder", "folder/nested")).toThrow();
    writeFileSync(join(p.root, "École.ts"), "unicode keep");
    await expect(
      p.copy("folder/a.ts", "école.ts", p.operationIdentity("folder/a.ts"), ".unicode-stage"),
    ).rejects.toThrow();
    expect(readFileSync(join(p.root, "École.ts"), "utf8")).toBe("unicode keep");
    writeFileSync(join(p.root, "Occupied.ts"), "keep");
    const ops = new FileOperations(store, join(base, "intent.json"));
    await expect(ops.run(p, "copy", "folder/a.ts", "occupied.ts")).rejects.toThrow();
    expect(readFileSync(join(p.root, "Occupied.ts"), "utf8")).toBe("keep");
    // Staged leftovers deliberately keep uncertain intent, rather than claiming rollback.
    expect(await new FileOperationJournal(join(base, "intent.json")).readIntent()).not.toBe(null);
  }));

test("an opened copy stage moved away before native failure retains uncertain intent and source drafts", async () =>
  fixture(async (p, store, base) => {
    const helper = join(base, "staging-helper");
    execFileSync("clang", [
      "-std=c11",
      "-framework",
      "CoreServices",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      "-DESCODE_TEST_COPY_STAGE",
      "host/filesystem.c",
      "-o",
      helper,
    ]);
    const staged = await Checkout.open(p.root, helper);
    const execute = child.spawn;
    vi.spyOn(child, "spawn").mockImplementation((...args) => {
      const process = execute(...args);
      if (Array.isArray(args[1]) && args[1][0] === "copy") {
        const temporary = args[1][4];
        process.stdout!.once("data", () =>
          renameSync(join(p.root, temporary), join(base, "retained-stage")),
        );
      }
      return process;
    });
    const file = join(base, "intent.json"),
      ops = new FileOperations(store, file);
    try {
      // No test synchronization descriptors are inherited: the native helper fails after opening/copying staging.
      await expect(ops.run(staged, "copy", "folder", "destination")).rejects.toThrow(
        "Uncertain copy",
      );
      expect(readFileSync(join(base, "retained-stage/a.ts"), "utf8")).toBe("disk");
      expect(existsSync(join(p.root, "destination"))).toBe(false);
      const pending = await new FileOperationJournal(file).readIntent();
      expect(pending?.kind).toBe("copy");
      expect(pending?.completed).not.toBe(true);
      expect(pending?.copies?.[0].text).toBe("a unsaved");
      const fresh = new FileOperations(store, file);
      expect(await fresh.recover(async () => staged)).toContain("Uncertain file operation");
      await expect(fresh.run(staged, "move", "folder", "other")).rejects.toThrow(
        "pending reconciliation",
      );
      expect((await store.read()).drafts[0].text).toBe("a unsaved");
    } finally {
      staged.close();
    }
  }));


test("a late client snapshot retains newer text and the completed ordinary-save baseline", async () =>
  fixture(async (p, store, base) => {
    const ops = new FileOperations(store, join(base, "intent.json"));
    const stale = await store.read();
    await ops.save(p, "folder/a.ts", "saved", stale.drafts[0].disk.version, () => {});
    stale.drafts[0].text = "newer available text";
    await ops.persist(stale);
    const fresh = await new Workspace(join(base, "workspace.json")).read();
    expect(fresh.drafts[0]).toMatchObject({ text: "newer available text", disk: { text: "saved" } });
    writeFileSync(join(p.root, "folder/a.ts"), "external writer");
    expect((await ops.save(p, "folder/a.ts", fresh.drafts[0].text, fresh.drafts[0].disk.version, () => {})).kind).toBe("conflict");
  }));

test("completed move protects late recovery snapshots until acknowledgement", async () => {
  await fixture(async (p, store, base) => {
    const ops = new FileOperations(store, join(base, "intent.json"));
    const stale = await store.read();
    stale.views[p.root].openFiles = ["folder/b.ts", "folder/a.ts"];
    stale.views[p.root].fileViews = { "folder/a.ts": "unstaged" };
    stale.views[p.root].editorPositions = { "folder/a.ts": { file: { line: 2, column: 3, top: 40, left: 0 } } };
    await store.write(stale);
    const baseline = stale.drafts[0].disk;
    await ops.run(p, "move", "folder", "moved");
    await ops.persist(stale);
    const recovered = await store.read();
    expect(recovered.drafts[0].path).toBe("moved/a.ts");
    expect(recovered.drafts[0].text).toBe("a unsaved");
    expect(recovered.drafts[0].disk).toEqual(baseline);
    expect(recovered.views[p.root].openFiles).toEqual(["moved/b.ts", "moved/a.ts"]);
    expect(recovered.views[p.root].path).toBe("moved/a.ts");
    expect(recovered.views[p.root].fileViews).toEqual({ "moved/a.ts": "unstaged" });
    expect(recovered.views[p.root].editorPositions?.["moved/a.ts"].file).toEqual({ line: 2, column: 3, top: 40, left: 0 });
    expect(readFileSync(join(p.root, "moved/a.ts"), "utf8")).toBe("disk");
    await ops.ack(p.root);
    expect(await new FileOperationJournal(join(base, "intent.json")).readIntent()).toBe(null);
  });
});

test("restart retains completed batch facts against late snapshots until client acknowledgement", async () =>
  fixture(async (p, store, base) => {
    const file = join(base, "intent.json");
    const stale = await store.read();
    const ops = new FileOperations(store, file);
    ops.beginBatch(p.root);
    await ops.run(p, "move", "folder/a.ts", "a.ts");
    await ops.ack();
    await ops.run(p, "move", "folder/b.ts", "b.ts");
    await ops.ack();
    const fresh = new FileOperations(store, file);
    await fresh.recover(async () => p);
    await fresh.persist(stale);
    expect((await store.read()).drafts.map(d => d.path)).toEqual(["a.ts", "b.ts"]);
    expect((await store.read()).drafts.map(d => d.disk.text)).toEqual(["disk", "second disk"]);
    await fresh.ack(p.root);
    expect(readFileSync(join(p.root, "a.ts"), "utf8")).toBe("disk");
  }));
