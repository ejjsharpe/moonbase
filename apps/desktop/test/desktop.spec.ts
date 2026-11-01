import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";

let app: ElectronApplication, child: ChildProcess, page: Page, base: string, checkout: string;
const errors: string[] = [];
declare global { var desktopTest: { calls: {method: string; input: {operation?: string; input?: Record<string, unknown>}}[]; results: { operation?: string; reply: {ok: boolean; value?: {items: {message?: string}[]}} }[]; fault: string | null; noStatus: boolean; held: string | null; release(): void; cancels: number }; }
test.beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "moonbase-desktop-"))); checkout = join(base, "checkout"); mkdirSync(checkout);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", checkout, "-c", "user.name=Moonbase Test", "-c", "user.email=test@example.invalid", ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q", "-b", "main"); writeFileSync(join(checkout, "a.ts"), "export const value = 'HEAD';\n"); writeFileSync(join(checkout, "b.ts"), "export const b = 2;\n"); git("add", "."); git("commit", "-qm", "Controlled fixture");
  writeFileSync(join(checkout, "a.ts"), "export const value = 'INDEX';\n"); git("add", "a.ts"); writeFileSync(join(checkout, "a.ts"), "export const value = 'WORKING';\n");
  await launch();
});
async function launch() {
  errors.length = 0;
  const env = { ...process.env, MOONBASE_USER_DATA: join(base, "user-data"), MOONBASE_TEST_REPORT: join(base, "quit-report.json"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as Record<string, string>; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [resolve("test/harness.mjs")], env, timeout: 20000 });
  child = app.process();
  child.stderr?.on("data", value => console.log(String(value)));
  page = await app.firstWindow(); page.on("pageerror", e => errors.push(e.message));
  await expect(page.getByRole("button", { name: "Open checkout", exact: true })).toBeVisible();
  await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog; }, checkout);
}
test.afterEach(async () => { if (child && child.exitCode === null && child.signalCode === null) { await forceStop(); } rmSync(base, { recursive: true, force: true }); });
async function forceStop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exit;
}
async function open(path = "a.ts") {
  if (!await page.getByRole("button", { name: "Find file", exact: true }).count()) await page.getByRole("button", { name: "Open checkout", exact: true }).click();
  await page.getByRole("button", { name: "Find file", exact: true }).click(); await page.getByRole("combobox").fill(path); await expect(page.getByRole("option", { name: path, exact: true })).toBeVisible(); await page.getByRole("combobox").press("Enter");
  await expect(page.getByRole("textbox", { name: `${path} editor`, exact: true })).toBeVisible();
}
async function edit(text: string, path = "a.ts") { const input = page.getByRole("textbox", { name: `${path} editor`, exact: true }); await input.focus(); await input.press("Meta+a"); await input.pressSequentially(text); }
test("actual sandboxed custom-scheme editor reads, edits and saves through SQLite workspace", async () => {
  await open(); await edit("export const saved = 42;"); await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => readFileSync(join(checkout, "a.ts"), "utf8")).toBe("export const saved = 42;");
  expect(await page.evaluate(() => ({ node: typeof (window as unknown as {require: unknown}).require, process: typeof (window as unknown as {process: unknown}).process, url: location.href }))).toEqual({ node: "undefined", process: "undefined", url: "moonbase://editor/index.html" });
  await page.screenshot({ path: "test-results/desktop-normal.png", scale: "css" }); expect(errors).toEqual([]);
});

async function checkoutTarget() {
  await expect.poll(async () => (await recovery()).state.checkouts.length).toBeGreaterThan(0);
  return page.evaluate(async () => {
    const r = await window.moonbase.call("command", { operation: "loadRecovery", input: { clientId: window.moonbase.clientId } }, crypto.randomUUID());
    if (!r.ok) throw Error(r.error.message);
    return (r.value as import("@moonbase/application/client").RecoveryLoad).state.checkouts[0];
  });
}
async function recovery() {
  return page.evaluate(async () => {
    const r = await window.moonbase.call("command", { operation: "loadRecovery", input: { clientId: window.moonbase.clientId } }, crypto.randomUUID());
    if (!r.ok) throw Error(r.error.message);
    return r.value as import("@moonbase/application/client").RecoveryLoad;
  });
}
async function quit() { await app.evaluate(({ app }) => { app.quit(); }); }

test("actual conflict Compare, Cancel, Overwrite and Reload retain one dirty working buffer and Git index", async () => {
  await open(); await edit("my unsaved text"); writeFileSync(join(checkout, "a.ts"), "external text");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "a.ts editor", exact: true })).toBeVisible();
  await expect(page.locator('.monaco-diff-editor .view-line').filter({ hasText: "external text" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(readFileSync(join(checkout, "a.ts"), "utf8")).toBe("external text");
  await page.getByRole("button", { name: "Save", exact: true }).click(); await page.getByRole("button", { name: "Overwrite observed version", exact: true }).click();
  await expect.poll(() => readFileSync(join(checkout, "a.ts"), "utf8")).toBe("my unsaved text");
  for (const area of ["staged", "unstaged"]) {
    await page.getByLabel("File view", { exact: true }).selectOption(area);
    await expect(page.getByRole("textbox", { name: "a.ts editor", exact: true })).toBeVisible();
    // Monaco's accessible label is exercised together with its readonly editor option by the module suite.
    await expect(page.getByRole('textbox', { name: / original$/, exact: false })).toHaveCount(1);
    await edit("shared " + area); await page.getByLabel("File view", { exact: true }).selectOption("file");
    await expect(page.locator('.view-line').filter({ hasText: "shared " + area }).first()).toBeVisible();
  }
  writeFileSync(join(checkout, "a.ts"), "latest external"); await page.getByRole("button", { name: "Save", exact: true }).click(); await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.locator('.view-line').filter({ hasText: "latest external" }).first()).toBeVisible();
  expect(execFileSync("/usr/bin/git", ["-C", checkout, "show", ":a.ts"], { encoding: "utf8" })).toContain("INDEX"); expect(errors).toEqual([]);
});

test("window close hides mounted Monaco; Quit Cancel preserves undo, then Save quits and releases resources", async () => {
  await open(); await edit("retained across hide");
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  await app.evaluate(({ app }) => { app.emit("activate", {} as never, false); });
  const input = page.getByRole("textbox", { name: "a.ts editor", exact: true }); await expect(input).toBeVisible();
  await input.focus(); await input.press("End"); await input.pressSequentially(" extra"); await input.press("Meta+z");
  await expect(page.locator('.view-line').filter({ hasText: "retained across hide" }).first()).toBeVisible();
  await quit(); await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await input.focus(); await input.press("End"); await input.pressSequentially(" after cancel");
  const exited = app.waitForEvent("close"); await quit(); await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click(); await exited;
  expect(readFileSync(join(checkout, "a.ts"), "utf8")).toContain("after cancel");
  const report = JSON.parse(readFileSync(join(base, "quit-report.json"), "utf8"));
  expect(report.resources.filter((name: string) => /FSWatcher/.test(name))).toEqual([]); expect(report.cancelListeners).toBe(0);
  const db = new DatabaseSync(join(base, "user-data/workspace-v1/moonbase-workspace-v1.sqlite")); db.exec("BEGIN IMMEDIATE; ROLLBACK"); db.close();
});

test("SQLite contention vetoes Quit Discard; exact resolution and fresh choice keep window usable", async () => {
  await open(); await edit("draft survives contention");
  await expect.poll(async () => (await recovery()).state.drafts[0]?.text).toBe("draft survives contention");
  const db = new DatabaseSync(join(base, "user-data/workspace-v1/moonbase-workspace-v1.sqlite")); db.exec("BEGIN IMMEDIATE");
  try { await quit(); await page.getByRole("button", { name: "Discard", exact: true }).click(); await expect(page.getByRole("button", { name: "Resolve recovery publication", exact: true })).toBeVisible(); }
  finally { db.exec("ROLLBACK"); db.close(); }
  await page.getByRole("button", { name: "Resolve recovery publication", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resolve recovery publication", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "a.ts", exact: true })).toBeVisible();
  const input = page.getByRole("textbox", { name: "a.ts editor", exact: true }); await input.focus(); await input.press("End"); await input.pressSequentially(" still editable");
  expect((await recovery()).state.drafts.length).toBeGreaterThan(0);
  const exited = app.waitForEvent("close"); await quit(); await page.getByRole("button", { name: "Discard", exact: true }).click(); await exited;
  expect(readFileSync(join(checkout, "a.ts"), "utf8")).toContain("WORKING");
});

test("dirty recovery and comparison metadata restore across actual process restart", async () => {
  await open(); await page.getByLabel("File view", { exact: true }).selectOption("staged"); await expect(page.getByRole("textbox", { name: / original$/ })).toHaveCount(1); await edit("dirty restored staged");
  await expect.poll(async () => (await recovery()).state.drafts.find(d => d.target.path === "a.ts")?.text).toBe("dirty restored staged");
  await forceStop(); await launch();
  await expect(page.getByRole("textbox", { name: "a.ts editor", exact: true })).toBeVisible(); await expect(page.getByLabel("File view", { exact: true })).toHaveValue("staged");
  await expect(page.locator('.view-line').filter({ hasText: "dirty restored staged" }).first()).toBeVisible();
  expect((await recovery()).state.drafts[0].disk.text).toContain("WORKING");
  await page.screenshot({ path: "test-results/desktop-restored-diff.png" }); expect(errors).toEqual([]);
});

test("lost real Save reply retries original identity without replacing the native file again", async () => {
  await open(); await edit("captured Save"); await expect.poll(async () => (await recovery()).state.drafts[0]?.text).toBe("captured Save");
  await app.evaluate(() => { globalThis.desktopTest.fault = "saveFile"; });
  await page.getByRole("button", { name: "Save", exact: true }).click(); await expect(page.getByRole("button", { name: "Retry Save", exact: true })).toBeVisible();
  await edit("newer after lost reply"); await page.getByRole("button", { name: "Retry Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await expect.poll(async () => (await recovery()).state.drafts[0]?.text).toBe("newer after lost reply");
  const saves = await app.evaluate(() => globalThis.desktopTest.calls.filter(call => call.input?.operation === "saveFile"));
  expect(saves).toHaveLength(2); expect(saves[0].input.input).toEqual(saves[1].input.input); expect(readFileSync(join(checkout, "a.ts"), "utf8")).toBe("captured Save");
});

test("actual IPC rejects unapproved roots, foreign callers/targets, unknown inputs and navigation", async () => {
  const denied = await page.evaluate(async root => window.moonbase.call("command", { operation: "openCheckout", input: { root } }, crypto.randomUUID()), checkout);
  expect(denied.ok).toBe(false); if (!denied.ok) expect(denied.error.code).toBe("Unauthorized");
  await open(); const target = await checkoutTarget();
  for (const input of [
    { operation: "__proto__", input: {} },
    { operation: "loadRecovery", input: { clientId: "foreign" } },
    { operation: "readFile", input: { checkout: { ...target, hostId: "foreign" }, path: "a.ts" } },
    { operation: "readFile", input: { checkout: target, path: "../outside" } },
    { operation: "readFile", input: { checkout: target, path: "a.ts", ignored: true } },
  ]) { const r = await page.evaluate(input => window.moonbase.call("command", input, crypto.randomUUID()), input); expect(r.ok).toBe(false); }
  const foreign = await app.evaluate(async ({ BrowserWindow }, preload) => {
    const other = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try { await other.loadURL("moonbase://editor/index.html"); return await other.webContents.executeJavaScript('window.moonbase.call("command", {operation:"loadRecovery",input:{clientId:window.moonbase.clientId}}, "foreign-frame")'); }
    finally { other.destroy(); }
  }, resolve("dist/preload.cjs"));
  expect(foreign.ok).toBe(false); expect(foreign.error.code).toBe("Unauthorized");
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  await page.evaluate(() => { window.open("https://example.invalid/"); }); expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windows);
  await page.evaluate(() => { location.href = "https://example.invalid/"; }); await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe("moonbase://editor/index.html");
  expect(await page.evaluate(() => location.href)).toBe("moonbase://editor/index.html");
  await page.evaluate(() => { const frame = document.createElement("iframe"); frame.srcdoc = "<p>blocked</p>"; document.body.append(frame); });
  expect(await page.evaluate(() => document.querySelector("iframe")?.contentDocument?.body?.textContent ?? "")).not.toContain("blocked");
});

test("native picker creates scoped single-use tokens through the actual bridge; fake File paths grant no authority", async () => {
  await open(); const approved = await checkoutTarget(), source = join(base, "native-import.txt"); writeFileSync(source, "CONTROLLED NATIVE IMPORT");
  await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [source] })) as typeof dialog.showOpenDialog; }, source);
  const refs = await page.evaluate(async checkout => {
    const result = await window.moonbase.call("choose-imports", { checkout }, crypto.randomUUID()); if (!result.ok) throw Error(result.error.message); return result.value as string[];
  }, approved);
  expect(refs).toHaveLength(1); expect(refs[0]).not.toContain(source);
  const result = await page.evaluate(async ({ checkout, refs }) => window.moonbase.call("command", { operation: "mutate", input: { id: crypto.randomUUID(), clientId: window.moonbase.clientId, checkout, kind: "import", sources: [], destination: "imported.txt", nativeReferences: refs } }, crypto.randomUUID()), { checkout: approved, refs });
  expect(result.ok).toBe(true); expect(readFileSync(join(checkout, "imported.txt"), "utf8")).toBe("CONTROLLED NATIVE IMPORT");
  const reused = await page.evaluate(async ({ checkout, refs }) => window.moonbase.call("command", { operation: "mutate", input: { id: crypto.randomUUID(), clientId: window.moonbase.clientId, checkout, kind: "import", sources: [], destination: "reused.txt", nativeReferences: refs } }, crypto.randomUUID()), { checkout: approved, refs });
  expect(reused.ok).toBe(false); if (!reused.ok) expect(reused.error.code).toBe("Unauthorized");
  expect(existsSync(join(checkout, "reused.txt"))).toBe(false);
  const fakeDrop = await page.evaluate(async checkout => { try { return await window.moonbase.drop(checkout, [new File(["fake"], "outside.txt")]); } catch { return { ok: false }; } }, approved);
  expect(fakeDrop.ok).toBe(false);
  await page.evaluate(() => { const input = document.createElement("input"); input.type = "file"; input.id = "native-fixture"; document.body.append(input); });
  await page.locator("#native-fixture").setInputFiles(source);
  const dropped = await page.evaluate(async checkout => window.moonbase.drop(checkout, [...(document.querySelector<HTMLInputElement>("#native-fixture")!.files!)]), approved);
  expect(dropped.ok).toBe(true); if (!dropped.ok) throw Error(dropped.error.message);
  const copied = await page.evaluate(async ({ checkout, refs }) => window.moonbase.call("command", { operation: "mutate", input: { id: crypto.randomUUID(), clientId: window.moonbase.clientId, checkout, kind: "import", sources: [], destination: "dropped.txt", nativeReferences: refs } }, crypto.randomUUID()), { checkout: approved, refs: dropped.value });
  expect(copied.ok).toBe(true); expect(readFileSync(join(checkout, "dropped.txt"), "utf8")).toBe("CONTROLLED NATIVE IMPORT");
});

test("controlled clipboard fixtures require native consent and capture real files without accessing user's clipboard", async () => {
  await open(); const approved = await checkoutTarget(), source = join(base, "clipboard-import.txt"); writeFileSync(source, "CONTROLLED CLIPBOARD IMPORT");
  await app.evaluate(({ clipboard, dialog }, source) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    clipboard.read = async () => { throw Error("Clipboard must not be read after Cancel"); };
  }, source);
  let refs = await page.evaluate(async checkout => window.moonbase.call("clipboard-imports", { checkout }, crypto.randomUUID()), approved); expect(refs).toEqual({ ok: true, value: [] });
  await app.evaluate(({ clipboard, dialog, ClipboardItem }, source) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>${source}</string></array></plist>`;
    clipboard.read = async () => [new ClipboardItem({ 'electron application/osclipboard;format="NSFilenamesPboardType"': new Blob([xml]) })];
  }, source);
  await page.getByRole("button", { name: "Import clipboard files", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Import files", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Import files", exact: true })).toBeDisabled();
  await page.getByLabel("Destination relative path").fill("clipboard.txt"); await page.getByRole("dialog").getByRole("button", { name: "Import files", exact: true }).click();
  await expect.poll(() => existsSync(join(checkout, "clipboard.txt"))).toBe(true); expect(readFileSync(join(checkout, "clipboard.txt"), "utf8")).toBe("CONTROLLED CLIPBOARD IMPORT");
});

test("real create, dirty move and copy use native operations; lost move reply resolves status without replay", async () => {
  await open(); await page.getByRole("button", { name: "New File", exact: true }).click(); await page.getByLabel("Destination relative path").fill("created.ts");
  await page.getByRole("dialog").getByRole("button", { name: "New File", exact: true }).click();
  await expect(page.getByRole("tab", { name: "created.ts", exact: true })).toBeVisible(); await edit("dirty created buffer", "created.ts");
  await page.getByRole("treeitem", { name: "created.ts, unsaved", exact: true }).click();
  await page.getByRole("button", { name: "Rename / Move", exact: true }).click(); await page.getByLabel("Destination relative path").fill("renamed.ts");
  await app.evaluate(() => { globalThis.desktopTest.fault = "mutate"; });
  await page.getByRole("dialog").getByRole("button", { name: "Rename or move", exact: true }).click();
  await expect.poll(() => existsSync(join(checkout, "renamed.ts"))).toBe(true);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Resolve operation status", exact: true }).click();
  await expect(page.getByRole("tab", { name: "renamed.ts", exact: true })).toBeVisible();
  await expect(page.locator('.view-line').filter({ hasText: "dirty created buffer" }).first()).toBeVisible();
  await page.getByRole("treeitem", { name: "renamed.ts, unsaved", exact: true }).click(); await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByLabel("Destination relative path").fill("copied.ts"); await page.getByRole("dialog").getByRole("button", { name: "Copy", exact: true }).click();
  await open("copied.ts"); await expect(page.locator('.view-line').filter({ hasText: "dirty created buffer" }).first()).toBeVisible();
  await edit("saved only copied buffer", "copied.ts"); await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => readFileSync(join(checkout, "copied.ts"), "utf8")).toBe("saved only copied buffer"); expect(readFileSync(join(checkout, "renamed.ts"), "utf8")).toBe("");
  const calls = await app.evaluate(() => globalThis.desktopTest.calls.filter(call => call.input?.operation === "mutate"));
  expect(calls).toHaveLength(3); expect(existsSync(join(checkout, "created.ts"))).toBe(false); expect(errors).toEqual([]);
});

test("previews, Keep Open, order, keyboard Close/Reopen and overflow remain useful at small size and zoom", async () => {
  for (let i = 0; i < 10; i++) writeFileSync(join(checkout, `long-component-name-for-overflow-${i}.ts`), `export const item${i} = ${i};\n`);
  await open(); await page.getByRole("treeitem", { name: "b.ts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Keep Open", exact: true })).toBeVisible(); await page.getByRole("button", { name: "Keep Open", exact: true }).click();
  for (let i = 0; i < 7; i++) await open(`long-component-name-for-overflow-${i}.ts`);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(760, 650); });
  await page.screenshot({ path: "test-results/desktop-constrained-tabs.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const selected = "long-component-name-for-overflow-6.ts";
  const input = page.getByRole("textbox", { name: `${selected} editor`, exact: true }); await input.focus(); await input.press("Meta+w");
  await expect(page.getByRole("tab", { name: selected, exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "long-component-name-for-overflow-5.ts editor", exact: true }).press("Meta+Shift+t");
  await expect(page.getByRole("tab", { name: selected, exact: true })).toBeVisible(); await expect(input).toBeFocused(); await input.press("End"); await input.pressSequentially(" typed after reopen");
  await input.press("Control+Tab"); await input.press("Control");
  await page.keyboard.press("Escape");
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.4); });
  await page.screenshot({ path: "test-results/desktop-zoom.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Tab actions", exact: true }).focus(); await page.keyboard.press("Enter"); await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Find file", exact: true }).focus(); await page.keyboard.press("Enter");
  await page.getByRole("combobox").fill("a.ts"); await page.getByRole("combobox").press("Enter");
  await expect(page.getByRole("textbox", { name: "a.ts editor", exact: true })).toBeFocused();
  await page.getByRole("textbox", { name: "a.ts editor", exact: true }).pressSequentially("keyboard lookup typing");
  await page.screenshot({ path: "test-results/desktop-keyboard.png" }); expect(errors).toEqual([]);
});

test("native Trash moves only a captured temporary fixture and leaves its dirty draft available", async () => {
  const name = `moonbase-trash-${crypto.randomUUID()}.txt`, content = "CONTROLLED TRASH FIXTURE " + name;
  writeFileSync(join(checkout, name), content); const inode = statSync(join(checkout, name)).ino;
  await open(name); await edit("retained after native Trash", name);
  await page.getByRole("treeitem", { name: name + ", unsaved", exact: true }).click(); await page.getByRole("button", { name: "Trash", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Move to Trash", exact: true }).click();
  await expect.poll(() => existsSync(join(checkout, name))).toBe(false);
  const result = await app.evaluate(() => globalThis.desktopTest.results.findLast(r => r.operation === "mutate" && r.reply.ok));
  const trashPath = result?.reply.value?.items.find(item => item.message?.startsWith("macOS Trash: "))?.message?.slice("macOS Trash: ".length);
  expect(trashPath).toBeTruthy(); if (!trashPath) throw Error("No native Trash path recorded");
  // Cleanup touches only the exact native-returned fixture, after content and inode verification.
  try { expect(trashPath.split("/").at(-1)).toBe(name); expect(statSync(trashPath).ino).toBe(inode); expect(readFileSync(trashPath, "utf8")).toBe(content); }
  finally { if (statSync(trashPath).ino === inode && readFileSync(trashPath, "utf8") === content) rmSync(trashPath); }
  await open("b.ts"); await page.getByRole("tab", { name, exact: true }).click();
  await expect(page.getByRole("textbox", { name: `${name} editor`, exact: true })).toBeVisible();
  await expect(page.locator('.view-line').filter({ hasText: "retained after native Trash" }).first()).toBeVisible();
  await expect.poll(async () => (await recovery()).state.drafts.find(d => d.target.path === name)?.text).toBe("retained after native Trash");
});

test("unknown final Quit publication retains the window and resolves only the exact committed receipt", async () => {
  await open(); await edit("consented pending discard"); await expect.poll(async () => (await recovery()).state.drafts[0]?.text).toBe("consented pending discard");
  await app.evaluate(() => { globalThis.desktopTest.fault = "final-publication"; });
  await quit(); await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resolve recovery publication", exact: true })).toBeVisible();
  expect((await recovery()).state.drafts).toEqual([]); // The consented final publication actually committed.
  await expect(page.locator('.view-line').filter({ hasText: "consented pending discard" }).first()).toBeVisible();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await app.evaluate(() => { globalThis.desktopTest.noStatus = false; });
  await page.getByRole("button", { name: "Resolve recovery publication", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resolve recovery publication", exact: true })).toHaveCount(0);
  await expect(page.locator('.view-line').filter({ hasText: "WORKING" }).first()).toBeVisible();
  const exited = app.waitForEvent("close"); await quit(); await exited;
  expect(readFileSync(join(checkout, "a.ts"), "utf8")).toContain("WORKING");
});

test("a command cancelled over real IPC keeps typed cancellation and leaves unrelated IO usable", async () => {
  await open(); const approved = await checkoutTarget();
  const cancelled = await page.evaluate(async checkout => {
    const id = crypto.randomUUID(), pending = window.moonbase.call("command", { operation: "readFile", input: { checkout, path: "a.ts" } }, id);
    window.moonbase.cancel("some-other-request"); window.moonbase.cancel(id); return pending;
  }, approved);
  expect(cancelled.ok).toBe(false); if (!cancelled.ok) expect(cancelled.error.code).toBe("Cancelled");
  const next = await page.evaluate(async checkout => window.moonbase.call("command", { operation: "readFile", input: { checkout, path: "b.ts" } }, crypto.randomUUID()), approved);
  expect(next.ok).toBe(true); expect(await app.evaluate(() => globalThis.desktopTest.cancels)).toBeGreaterThanOrEqual(2);
});

test("exact checkout tabs preserve independent dirty paths, views and closed metadata through native approval", async () => {
  await open(); await edit("alpha dirty a");
  const beta = join(base, "second-checkout"); execFileSync("/usr/bin/git", ["-C", checkout, "worktree", "add", "-q", "-b", "beta", beta, "HEAD"]);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, beta);
  await page.getByRole("button", { name: "Open checkout", exact: true }).click(); await open(); await edit("beta dirty a");
  await expect.poll(async () => (await recovery()).state.drafts.length).toBe(2);
  const first = page.getByRole("tab", { name: "checkout · main", exact: true }); await first.click();
  await expect(page.locator('.view-line').filter({ hasText: "alpha dirty a" }).first()).toBeVisible();
  await page.getByRole("button", { name: `Close checkout ${checkout}`, exact: true }).click(); await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(first).toBeVisible(); await page.getByRole("button", { name: `Close checkout ${checkout}`, exact: true }).click(); await page.getByRole("button", { name: "Discard", exact: true }).click(); await expect(first).toHaveCount(0);
  const closed = await recovery(); expect(closed.state.checkouts).toHaveLength(2); expect(closed.state.openCheckoutIds).toHaveLength(1); expect(Object.values(closed.state.views).some(v => v.openFiles.includes("a.ts"))).toBe(true);
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, checkout);
  await page.getByRole("button", { name: "Open checkout", exact: true }).click(); await expect(first).toBeVisible();
  await expect(page.locator('.view-line').filter({ hasText: "WORKING" }).first()).toBeVisible();
  await expect.poll(async () => (await recovery()).state.drafts.find(d => d.target.checkout.root === beta)?.text).toBe("beta dirty a");
});

test("single-file picker and File-backed drop share the editor's destination dialog", async () => {
  await open(); const source = join(base, "picked.txt"); writeFileSync(source, "ONE PICKED NATIVE FILE");
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog; }, source);
  await page.getByRole("button", { name: "Import files", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Import files", exact: true })).toBeDisabled();
  await page.getByLabel("Destination relative path").fill("picker.txt"); await page.getByRole("dialog").getByRole("button", { name: "Import files", exact: true }).click();
  await expect.poll(() => existsSync(join(checkout, "picker.txt"))).toBe(true); expect(readFileSync(join(checkout, "picker.txt"), "utf8")).toBe("ONE PICKED NATIVE FILE");
  await page.evaluate(() => { const input = document.createElement("input"); input.type = "file"; input.id = "drop-fixture"; document.body.append(input); });
  await page.locator("#drop-fixture").setInputFiles(source);
  await page.evaluate(() => { const transfer = new DataTransfer(); transfer.items.add(document.querySelector<HTMLInputElement>("#drop-fixture")!.files![0]); document.querySelector("main")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer })); });
  await expect(page.getByRole("dialog", { name: "Import files", exact: true })).toBeVisible();
  await page.getByLabel("Destination relative path").fill("drop.txt"); await page.getByRole("dialog").getByRole("button", { name: "Import files", exact: true }).click();
  await expect.poll(() => existsSync(join(checkout, "drop.txt"))).toBe(true); expect(readFileSync(join(checkout, "drop.txt"), "utf8")).toBe("ONE PICKED NATIVE FILE");
});
