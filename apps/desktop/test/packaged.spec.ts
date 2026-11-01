import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

test("unsigned macOS package runs with only system PATH, SQLite, native/rg resources and CSP workers", async () => {
  test.setTimeout(45000);
  const base = realpathSync(mkdtempSync(join(tmpdir(), "moonbase-package-"))), checkout = join(base, "checkout"); mkdirSync(checkout);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", checkout, "-c", "user.name=Package Test", "-c", "user.email=package@example.invalid", ...args]);
  git("init", "-q", "-b", "main"); writeFileSync(join(checkout, "package.ts"), "export const packaged = 'original';\n"); writeFileSync(join(checkout, "lookup-native-resource.txt"), "qualified rg fixture"); git("add", "."); git("commit", "-qm", "Package fixture");
  const executablePath = resolve(`release/mac-${process.arch === "arm64" ? "arm64" : "x64"}/Moonbase.app/Contents/MacOS/Moonbase`);
  const app = await electron.launch({ executablePath, args: [], env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR ?? tmpdir(), MOONBASE_USER_DATA: join(base, "fresh-user-data"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, timeout: 20000 });
  const child = app.process(), page = await app.firstWindow(), errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  try {
    const resource = await app.evaluate(async ({ app }) => {
      const fs = process.getBuiltinModule("fs"), path = process.getBuiltinModule("path"), crypto = process.getBuiltinModule("crypto");
      const resources = process.resourcesPath, assets = path.join(resources, "app.asar/renderer/assets");
      const files = ["workspace/filesystem", "workspace/ripgrep/rg", "workspace/ripgrep/COPYING", "workspace/ripgrep/LICENSE-MIT", "workspace/ripgrep/UNLICENSE", "app.asar/dependency-notices.txt"];
      return { packaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node, path: process.env.PATH,
        assets: fs.readdirSync(assets), files: files.map(name => ({ name, bytes: fs.statSync(path.join(resources, name)).size, mode: fs.statSync(path.join(resources, name)).mode & 0o777, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(resources, name))).digest("hex") })), notices: fs.readFileSync(path.join(resources, "app.asar/dependency-notices.txt"), "utf8") };
    });
    expect(resource.packaged).toBe(true); expect(resource.path).toBe("/usr/bin:/bin"); expect(resource.node).toBe("24.22.1");
    expect(resource.files.filter(file => ["workspace/filesystem", "workspace/ripgrep/rg"].includes(file.name)).every(file => file.mode & 0o111)).toBe(true);
    const workers = resource.assets.filter(name => /^(editor|json|css|html|ts)\.worker.*\.js$/.test(name)); expect(workers).toHaveLength(5); expect(resource.assets.some(name => name.endsWith(".ttf"))).toBe(true);
    expect(resource.notices).toContain("@stylexjs/stylex@0.19.1"); expect(resource.notices).toContain("monaco-editor@0.57.0"); expect(resource.notices).toContain("MIT License");
    await expect(page.getByRole("button", { name: "Open checkout", exact: true })).toBeVisible();
    await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog; }, checkout);
    await page.getByRole("button", { name: "Open checkout", exact: true }).click(); await page.getByRole("button", { name: "Find file", exact: true }).click();
    await page.getByRole("combobox").fill("lookup-native"); await expect(page.getByRole("option")).toContainText("lookup-native-resource.txt"); await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("treeitem", { name: "package.ts", exact: true }).dblclick(); const input = page.getByRole("textbox", { name: "package.ts editor", exact: true }); await input.focus(); await input.press("Meta+a"); await input.pressSequentially("export const packaged = 42;");
    await page.getByRole("button", { name: "Save", exact: true }).click(); await expect.poll(() => readFileSync(join(checkout, "package.ts"), "utf8")).toBe("export const packaged = 42;");
    await page.getByLabel("File view", { exact: true }).selectOption("staged"); await expect(page.getByRole("textbox", { name: / original$/ })).toHaveCount(1);
    const workerErrors = await page.evaluate(async workers => {
      const failures: string[] = [];
      await Promise.all(workers.map(name => new Promise<void>(resolve => { const worker = new Worker(new URL("./assets/" + name, location.href)); worker.onerror = event => failures.push(event.message); setTimeout(() => { worker.terminate(); resolve(); }, 300); })));
      return failures;
    }, workers); expect(workerErrors).toEqual([]); expect(errors).toEqual([]);
    await page.screenshot({ path: "test-results/packaged-editor.png", fullPage: true, scale: "css" });
    mkdirSync("evidence", { recursive: true });
    writeFileSync("evidence/packaged-resources.json", JSON.stringify({ ...resource, notices: undefined, workerErrors, asarSha256: createHash("sha256").update(readFileSync(resolve(`release/mac-${process.arch === "arm64" ? "arm64" : "x64"}/Moonbase.app/Contents/Resources/app.asar`))).digest("hex"), fixture: "fresh temporary Git repository with package.ts and lookup-native-resource.txt; no provider environment", viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })) }, null, 2) + "\n");
    const closed = app.waitForEvent("close"); await app.evaluate(({ app }) => app.quit()); await closed;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited; }
    rmSync(base, { recursive: true, force: true });
  }
});
