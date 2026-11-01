import { test, expect, vi } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from "node:fs/promises";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Checkout } from "./project";
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));

test("loaded directories share coalesced native notifications; clients release independently", async () => {
  const root = fs.realpathSync(await mkdtemp(join(tmpdir(), "escode-watch-")));
  execFileSync("git", ["init", root]);
  await mkdir(join(root, "loaded"));
  await mkdir(join(root, "unloaded"));
  const project = await Checkout.open(root);
  const watch = vi.spyOn(fs, "watch");
  const first = vi.fn(), second = vi.fn();
  const release = project.watchFiles(["", "loaded"], first);
  project.watchFiles(["loaded"], second);
  try {
    expect(watch).toHaveBeenCalledTimes(2);
    // Observe native delivery for both clients before measuring the separate burst.
    let warmup = 0;
    await vi.waitFor(async () => {
      if (!first.mock.calls.length || !second.mock.calls.length)
        await writeFile(join(root, "loaded/watch-ready"), String(warmup++));
      expect(first).toHaveBeenCalledWith(undefined);
      expect(second).toHaveBeenCalledWith(undefined);
    }, { timeout: 5000, interval: 100 });
    first.mockClear(); second.mockClear();
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(join(root, "loaded", String(i)), "disk")));
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledWith(undefined);
      expect(second).toHaveBeenCalledWith(undefined);
    }, { timeout: 5000 });
    expect(first.mock.calls.length).toBeLessThan(5);
    release();
    first.mockClear(); second.mockClear();
    await rename(join(root, "loaded/0"), join(root, "loaded/restored"));
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith(undefined), { timeout: 5000 });
    expect(first).not.toHaveBeenCalled();
    project.close();
    second.mockClear();
    await writeFile(join(root, "loaded/after-close"), "disk");
    await new Promise((r) => setTimeout(r, 250));
    expect(second).not.toHaveBeenCalled();
  } finally {
    project.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true });
  }
}, 20000);

test("watch failures are contextual; symlink parents, metadata and replaced roots cannot subscribe", async () => {
  const root = fs.realpathSync(await mkdtemp(join(tmpdir(), "escode-watch-failure-")));
  execFileSync("git", ["init", root]);
  const project = await Checkout.open(root);
  try {
    await symlink(root, join(root, "alias"));
    const notify = vi.fn();
    project.watchFiles(["alias", ".git"], notify);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0][0]).toContain(root);
    const runtime = vi.spyOn(fs, "watch");
    const runtimeFailure = vi.fn();
    project.watchFiles([""], runtimeFailure);
    runtime.mock.results[0].value.emit("error", Error("ENOSPC injected runtime failure"));
    await vi.waitFor(() => expect(runtimeFailure).toHaveBeenCalledWith(expect.stringContaining("ENOSPC")));
    expect(await project.files()).toBeDefined();
    const watch = runtime.mockImplementation(() => { throw Error("EMFILE injected"); });
    const failure = vi.fn();
    project.watchFiles([""], failure);
    await vi.waitFor(() => expect(failure).toHaveBeenCalledWith(expect.stringContaining("EMFILE")));
    watch.mockRestore();
    await rename(root, root + "-original");
    await mkdir(root);
    const replaced = vi.fn();
    project.watchFiles([""], replaced);
    await vi.waitFor(() => expect(replaced).toHaveBeenCalledWith(expect.stringContaining("replaced")));
  } finally {
    project.close(); vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    await rm(root + "-original", { recursive: true, force: true });
  }
});

test("a live loaded parent swapped for a symlink cannot expose outside contents and can recover", async () => {
  const root = fs.realpathSync(await mkdtemp(join(tmpdir(), "escode-watch-swap-")));
  const outside = fs.realpathSync(await mkdtemp(join(tmpdir(), "escode-watch-outside-")));
  execFileSync("git", ["init", root]);
  await mkdir(join(root, "parent"));
  await writeFile(join(root, "parent/original"), "original");
  await writeFile(join(outside, "secret"), "outside");
  const project = await Checkout.open(root);
  const changed = vi.fn();
  project.watchFiles(["", "parent"], changed);
  try {
    // Establish native watcher readiness before the parent replacement burst.
    await vi.waitFor(async () => {
      await writeFile(join(root, "watch-ready"), String(Date.now()));
      expect(changed).toHaveBeenCalled();
    }, { timeout: 5000 });
    changed.mockClear();
    await rename(join(root, "parent"), join(root, "original-parent"));
    await symlink(outside, join(root, "parent"));
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5000 });
    await expect(project.files("parent")).rejects.toThrow();
    const failed = vi.fn();
    project.watchFiles(["parent"], failed);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(expect.stringContaining("parent")));
    await rm(join(root, "parent"));
    await rename(join(root, "original-parent"), join(root, "parent"));
    expect(await project.files("parent")).toEqual([{ path: "parent/original", directory: false }]);
    expect(fs.readFileSync(join(outside, "secret"), "utf8")).toBe("outside");
  } finally {
    project.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
