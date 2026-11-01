import { test, expect } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./recovery-fixture";
test("renderer workspace data cannot change host project approvals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-approvals-"));
  try {
    const store = new Workspace(join(dir, "workspace.json"));
    await store.approve(dir, dir);
    await store.write({
      projects: [{ project: "/unapproved", root: "/unapproved" }],
      selected: "/unapproved",
      views: {},
      drafts: [],
    });
    expect(await new Workspace(join(dir, "workspace.json")).approved()).toEqual([
      { project: dir, root: dir },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("acknowledged recovery survives a fresh store; discard cannot resurrect it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-recovery-"));
  try {
    const file = join(dir, "workspace.json");
    const store = new Workspace(file);
    const state = {
      projects: [{ project: dir, root: dir }],
      selected: dir,
      views: {},
      drafts: [
        {
          root: dir,
          path: "a.txt",
          text: "edits",
          disk: { text: "original", version: "baseline" },
        },
      ],
    };
    // Recovery must retain even edits too large to save as a supported file.
    const oversized = {
      ...state.drafts[0],
      path: "large.txt",
      text: "é".repeat(2 * 1024 * 1024 + 1),
    };
    await store.write({ ...state, drafts: [oversized] });
    await store.write({ ...state, drafts: [oversized, state.drafts[0]] });
    expect((await new Workspace(file).read()).drafts[1].text).toBe("edits");
    await store.write(state);
    expect(await new Workspace(file).read()).toEqual(state);
    await store.write({ ...state, drafts: [] });
    expect((await new Workspace(file).read()).drafts).toEqual([]);
    await expect(store.write({ drafts: "bad" })).rejects.toThrow();
    expect((await store.read()).drafts).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("closed editor membership persists independently of catalogue, checkout memories, recovery and approvals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-closed-workspace-"));
  try {
    const file = join(dir, "workspace.json"),
      store = new Workspace(file);
    const project = join(dir, "project"),
      checkout = join(dir, "worktree");
    await store.approve(project, project);
    const state = {
      projects: [{ project, root: project }],
      savedProjects: [{ project, root: project }],
      selected: project,
      agentsChat: "global-chat",
      views: {
        [project]: {
          mode: "Source Control",
          checkout,
          roots: [project, checkout],
          chat: "local-chat",
        },
        [checkout]: {
          path: "folder/a.ts",
          directory: "folder",
          files: {
            expanded: ["folder"],
            selected: ["folder/a.ts"],
            focus: "folder/a.ts",
            scroll: 0,
            hideIgnored: true,
          },
          change: { path: "folder/a.ts", area: "unstaged" as const },
        },
      },
      drafts: [
        {
          root: checkout,
          path: "folder/a.ts",
          text: "recovered",
          disk: { text: "disk", version: "loaded" },
        },
      ],
    };
    await store.write(state);
    const closed = { ...state, projects: [], selected: "agents" };
    await store.write(closed);
    const restarted = new Workspace(file);
    const migrated = {
      ...closed,
      views: {
        [project]: {
          ...closed.views[project],
          files: { expanded: [], selected: [], focus: "", scroll: 0 },
        },
        [checkout]: {
          ...closed.views[checkout],
          files: {
            expanded: ["folder"],
            selected: ["folder/a.ts"],
            focus: "folder/a.ts",
            scroll: 0,
            hideIgnored: true,
          },
        },
      },
    };
    expect(await restarted.read()).toEqual(migrated);
    expect(await restarted.approved()).toEqual(state.savedProjects);
    // Invalid membership cannot erase an acknowledged closed-project recovery draft.
    await expect(restarted.write({ ...closed, projects: [state.projects[0], state.projects[0]] }))
      .rejects.toThrow("Duplicate checkout memory");
    expect(await restarted.read()).toEqual(migrated);
    // Invalid updates cannot erase an acknowledged closed-project recovery draft.
    await expect(
      restarted.write({ ...closed, drafts: [{ ...state.drafts[0], path: "../outside" }] }),
    ).rejects.toThrow("Invalid recovery draft");
    expect(await restarted.read()).toEqual(migrated);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy Files navigation migrates through a fresh store while drafts and approvals survive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-tree-migration-"));
  try {
    const file = join(dir, "workspace.json");
    const store = new Workspace(file);
    await store.approve(dir, dir);
    const draft = {
      root: dir,
      path: "src/deep/a.ts",
      text: "unsaved",
      disk: { text: "disk", version: "baseline" },
    };
    await store.write({
      projects: [{ project: dir, root: dir }],
      selected: dir,
      views: { [dir]: { directory: "src/deep", path: draft.path } },
      drafts: [draft],
    });
    const migrated = await new Workspace(file).read();
    expect(migrated.views[dir].files).toEqual({
      expanded: ["src", "src/deep"],
      focus: draft.path,
      selected: [draft.path],
      scroll: 0,
    });
    migrated.views[dir].files!.scroll = 140;
    migrated.views[dir].files!.hideIgnored = true;
    await store.write(migrated);
    const fresh = new Workspace(file);
    expect(await fresh.read()).toEqual(migrated);
    expect((await fresh.read()).drafts).toEqual([draft]);
    expect(await fresh.approved()).toEqual([{ project: dir, root: dir }]);
    await expect(
      store.write({
        ...migrated,
        views: {
          [dir]: { files: { expanded: ["../outside"], selected: [], focus: "", scroll: 0 } },
        },
      }),
    ).rejects.toThrow("Invalid Files memory");
    expect((await fresh.read()).drafts).toEqual([draft]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkout approvals retain the native directory identity independently of client membership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-checkout-approval-"));
  try {
    const store = new Workspace(join(dir, "workspace.json"));
    await store.approve(dir, dir, "1:42");
    await store.write({ projects: [], selected: "agents", views: {}, drafts: [] });
    await expect(store.approve(dir, dir, "1:43")).rejects.toThrow("Checkout identity changed");
    expect(await new Workspace(join(dir, "workspace.json")).approved()).toEqual([
      { project: dir, root: dir, directoryIdentity: "1:42" },
    ]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("client project use validates exact paths and unique MRU entries without losing acknowledged state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-project-use-"));
  try {
    const store = new Workspace(join(dir, "workspace.json"));
    const state = { projects: [], selected: "agents", views: {}, drafts: [],
      projectUse: [{ project: dir, checkout: join(dir, "closed-worktree") }] };
    await store.write(state);
    expect(await new Workspace(join(dir, "workspace.json")).read()).toEqual(state);
    for (const projectUse of ["bad", [{ project: "relative" }], [{ project: dir, checkout: "relative" }],
      [state.projectUse[0], state.projectUse[0]]]) {
      await expect(store.write({ ...state, projectUse })).rejects.toThrow("Invalid project use");
      expect(await store.read()).toEqual(state);
    }

  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ordered file identities validate before replacing client recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-open-files-"));
  try {
    const store = new Workspace(join(dir, "workspace.json"));
    const state = { projects: [], selected: "", drafts: [], views: {
      [dir]: { openFiles: ["a.txt", "folder/b.txt"], path: "folder/b.txt" },
    } };
    await store.write(state);
    expect((await store.read()).views[dir].openFiles).toEqual(["a.txt", "folder/b.txt"]);
    for (const openFiles of [["../escape"], ["/absolute"], [".git/config"], ["a", "a"], [""], "bad"]) {
      await expect(store.write({ ...state, views: { [dir]: { openFiles } } })).rejects.toThrow("Invalid open files");
    }
    await expect(store.write({ ...state, views: { [dir]: { openFiles: ["a.txt"], path: "missing.txt" } } })).rejects.toThrow("Invalid open files");
    expect((await store.read()).views[dir].openFiles).toEqual(["a.txt", "folder/b.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file views and positions reject malformed metadata without replacing recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-file-views-"));
  try {
    const store = new Workspace(join(dir, "workspace.json"));
    const state = { projects: [], selected: "", drafts: [], views: {
      [dir]: { openFiles: ["a.txt"], path: "a.txt", fileViews: { "a.txt": "unstaged" as const },
        editorPositions: { "a.txt": { file: { line: 4, column: 2, top: 80, left: 0 } } } },
    } };
    await store.write(state);
    expect((await store.read()).views[dir].fileViews).toEqual({ "a.txt": "unstaged" });
    for (const invalid of [
      { fileViews: { "../escape": "file" } },
      { fileViews: { "a.txt": "unknown" } },
      { editorPositions: { "a.txt": { file: { line: -1, column: 1, top: 0, left: 0 } } } },
      { editorPositions: { "a.txt": { unknown: { line: 1, column: 1, top: 0, left: 0 } } } },
    ]) {
      await expect(store.write({ ...state, views: { [dir]: { ...state.views[dir], ...invalid } } })).rejects.toThrow();
      expect((await store.read()).views[dir].fileViews).toEqual({ "a.txt": "unstaged" });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("preview metadata retains an exact open identity and rejects orphan previews", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-preview-state-"));
  try {
    const store = new Workspace(join(dir, "workspace.json"));
    const state = { projects: [], selected: "", drafts: [], views: {
      [dir]: { openFiles: ["a.txt"], path: "a.txt", preview: "a.txt" },
    } };
    await store.write(state);
    expect((await store.read()).views[dir].preview).toBe("a.txt");
    for (const preview of ["../escape", "missing.txt", "/absolute", 3]) {
      await expect(store.write({ ...state, views: { [dir]: { ...state.views[dir], preview } } })).rejects.toThrow("Invalid preview");
    }
    expect((await store.read()).views[dir].preview).toBe("a.txt");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("recent file metadata is bounded, exact and independent of checkout membership and approvals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-recents-"));
  try {
    const store = new Workspace(join(dir, "workspace.json"));
    const target = { root: dir, path: "ignored/file.txt" };
    const state = { projects: [], selected: "agents", views: {}, drafts: [], recentFiles: [target] };
    await store.write(state);
    expect((await new Workspace(join(dir, "workspace.json")).read()).recentFiles).toEqual([target]);
    expect(await store.approved()).toEqual([]);
    for (const recentFiles of [[target, target], [{ ...target, path: "../escape" }], [{ ...target, root: "relative" }],
      Array.from({ length: 201 }, (_, i) => ({ root: dir, path: `${i}.txt` })),
      Array.from({ length: 20 }, (_, i) => ({ root: dir, path: `${i}${"x".repeat(4000)}` }))]) {
      await expect(store.write({ ...state, recentFiles })).rejects.toThrow("Invalid recent files");
    }
    expect((await store.read()).recentFiles).toEqual([target]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("host approvals retain checkout identity independently of client navigation and rejected replacement approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-checkout-approval-"));
  try {
    const file = join(dir, "workspace.json"), store = new Workspace(file);
    await store.approve(dir, dir);
    await expect(store.validateCheckout(dir, "1:42")).rejects.toThrow("identity");
    await store.approve(dir, dir, "1:42");
    const restarted = new Workspace(file);
    await restarted.validateCheckout(dir, "1:42");
    await expect(restarted.validateCheckout(dir, "1:43")).rejects.toThrow("replaced");
    await restarted.write({ projects: [], selected: "", drafts: [], views: {} });
    await expect(restarted.validateCheckout(dir, "1:43")).rejects.toThrow("replaced");
    await expect(restarted.approve(dir, dir, "1:43")).rejects.toThrow("Checkout identity changed");
    await restarted.validateCheckout(dir, "1:42");
    await expect(restarted.validateCheckout(dir, "1:43")).rejects.toThrow("replaced");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Files scroll anchors persist and reject invalid paths or offsets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "escode-scroll-anchor-"));
  try {
    const store = new Workspace(join(dir, "workspace.json"));
    const state = { projects: [], selected: "", drafts: [], views: {
      [dir]: { files: { expanded: [], selected: [], focus: "", scroll: 70, scrollAnchor: { path: "folder/file.txt", offset: 7 } } },
    } };
    await store.write(state);
    expect((await store.read()).views[dir].files?.scrollAnchor).toEqual({ path: "folder/file.txt", offset: 7 });
    for (const anchor of [{ path: "../escape", offset: 0 }, { path: "file", offset: -1 }, { path: "file", offset: Infinity }]) {
      state.views[dir].files.scrollAnchor = anchor;
      await expect(store.write(state)).rejects.toThrow();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("fresh SQLite approvals preserve and ignore superseded approval bytes", async () => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "escode-approval-cutover-"));
  try {
    const legacy = join(dir, "approved-projects.json");
    await writeFile(legacy, "preserved old bytes");
    const store = new Workspace(join(dir, "workspace.json"));
    expect(await store.approved()).toEqual([]);
    await store.approve(dir, dir, "1:2");
    expect(await new Workspace(join(dir, "workspace.json")).approved()).toEqual([
      { project: dir, root: dir, directoryIdentity: "1:2" },
    ]);
    expect(await readFile(legacy, "utf8")).toBe("preserved old bytes");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
