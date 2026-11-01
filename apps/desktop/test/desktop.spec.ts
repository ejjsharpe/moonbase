import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

let app: ElectronApplication, page: Page, base: string, checkout: string;
const errors: string[] = [];
test.beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "moonbase-desktop-")); checkout = join(base, "checkout"); mkdirSync(checkout);
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", checkout, "-c", "user.name=Moonbase Test", "-c", "user.email=test@example.invalid", ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git("init", "-q", "-b", "main"); writeFileSync(join(checkout, "a.ts"), "export const value = 'HEAD';\n"); writeFileSync(join(checkout, "b.ts"), "export const b = 2;\n"); git("add", "."); git("commit", "-qm", "Controlled fixture");
  writeFileSync(join(checkout, "a.ts"), "export const value = 'INDEX';\n"); git("add", "a.ts"); writeFileSync(join(checkout, "a.ts"), "export const value = 'WORKING';\n");
  errors.length = 0;
  const env = { ...process.env, MOONBASE_USER_DATA: join(base, "user-data") } as Record<string, string>; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [resolve("dist/main.cjs")], env, timeout: 20000 });
  app.process().stderr?.on("data", value => console.log(String(value)));
  page = await app.firstWindow(); page.on("pageerror", e => errors.push(e.message));
  await expect(page.getByRole("button", { name: "Open checkout", exact: true })).toBeVisible();
  await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog; }, checkout);
});
test.afterEach(async () => { if (app) { await app.close(); } rmSync(base, { recursive: true, force: true }); });
async function open(path = "a.ts") {
  if (!await page.getByRole("button", { name: "Find file", exact: true }).count()) await page.getByRole("button", { name: "Open checkout", exact: true }).click();
  await page.getByRole("button", { name: "Find file", exact: true }).click(); await page.getByRole("combobox").fill(path); await page.getByRole("combobox").press("Enter");
  await expect(page.getByRole("textbox", { name: `${path} editor`, exact: true })).toBeVisible();
}
async function edit(text: string, path = "a.ts") { const input = page.getByRole("textbox", { name: `${path} editor`, exact: true }); await input.focus(); await input.press("Meta+a"); await input.pressSequentially(text); }
test("actual sandboxed custom-scheme editor reads, edits and saves through SQLite workspace", async () => {
  await open(); await edit("export const saved = 42;"); await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => readFileSync(join(checkout, "a.ts"), "utf8")).toBe("export const saved = 42;");
  expect(await page.evaluate(() => ({ node: typeof (window as unknown as {require: unknown}).require, process: typeof (window as unknown as {process: unknown}).process, url: location.href }))).toEqual({ node: "undefined", process: "undefined", url: "moonbase://editor/index.html" });
  await page.screenshot({ path: "test-results/desktop-normal.png" }); expect(errors).toEqual([]);
});
