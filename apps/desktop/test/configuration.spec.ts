import { test, expect, _electron as electron } from "@playwright/test";
import { fixture } from "@moonbase/chat-probe/test-fixture";
import { mkdtempSync, realpathSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), packaged = !!process.env.MOONBASE_PACKAGED_TEST;
const executable = packaged ? process.env.MOONBASE_RELOAD_EXECUTABLE ?? resolve("release/mac-arm64/Moonbase.app/Contents/MacOS/Moonbase") : require("electron");
const args = packaged ? [] : [process.env.MOONBASE_RELOAD_MAIN ?? resolve("dist/main.mjs")];
const platform = { PATH: "/usr/bin:/bin", HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR! };

test("every present invalid configuration including empty fails startup", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "moonbase-config-repair-"))), records: unknown[] = [];
  writeFileSync(join(base, "malformed.json"), "{not-json", { mode: 0o600 }); writeFileSync(join(base, "insecure.json"), "{}", { mode: 0o644 }); symlinkSync(join(base, "malformed.json"), join(base, "symlink.json"));
  try {
    for (const [i, value] of ["", ...["missing.json", "malformed.json", "insecure.json", "symlink.json"].map(name => join(base, name))].entries()) {
      const child = spawn(executable, args, { env: { ...platform, MOONBASE_USER_DATA: join(base, "data-" + i), MOONBASE_CHAT_CONFIG: value }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "", expired = false; child.stderr.on("data", bytes => { stderr += bytes; });
      const timer = setTimeout(() => { expired = true; process.kill(-child.pid!, "SIGKILL"); }, 5000);
      const outcome = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal }))); clearTimeout(timer);
      await expect.poll(() => { try { process.kill(-child.pid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }).toBe(true);
      records.push({ value, pid: child.pid, group: child.pid, outcome, stderr, expired, groupAbsent: true });
      writeFileSync(test.info().outputPath("invalid-config.json"), JSON.stringify(records, null, 2));
      expect(outcome).toEqual({ code: 1, signal: null }); expect(expired).toBe(false);
      if (!value) expect(stderr).toContain("Set MOONBASE_CHAT_CONFIG to an absolute private configuration file.");
    }
  } finally { rmSync(base, { recursive: true }); }
});

for (const configured of [false, true]) test(`${configured ? "valid private" : "absent"} configuration starts without automatic Connect or Send`, async () => {
  const f = configured ? await fixture() : undefined;
  const before = await f?.stats();
  const base = f?.directory ?? realpathSync(mkdtempSync(join(tmpdir(), "moonbase-config-absent-")));
  const app = await electron.launch({ executablePath: executable, args, env: { ...platform, MOONBASE_USER_DATA: join(base, "desktop"), ...(f ? { MOONBASE_CHAT_CONFIG: f.clientConfig, MOONBASE_CHAT_FORWARD_LOG: f.log } : {}) } });
  const child = app.process(), pids = new Set<number>([child.pid!]);
  try {
    const page = await app.firstWindow(); await expect(page.getByRole("button", { name: "Open checkout", exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.moonbase.chatConfigured())).toEqual({ ok: true, value: configured });
    await page.getByRole("tablist", { name: "Workbench views", exact: true }).getByRole("tab", { name: "Chat", exact: true }).click();
    if (configured) {
      await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
      const stats = await f!.stats(); expect(stats.calls).toBe(0); expect(stats.tools).toBe(0); expect(stats.commands).toEqual(before!.commands);
      const status = await page.evaluate(() => window.moonbaseChat.call("connection", "getConnection", {}, crypto.randomUUID()));
      expect(status.ok).toBe(true); if (status.ok) expect(status.value).toMatchObject({ state: "disconnected", connectionId: null }); writeFileSync(test.info().outputPath("configured-no-connect.json"), JSON.stringify({ before, stats, status }, null, 2));
    } else await expect(page.getByLabel("Remote chat configuration")).toContainText("not configured");
  } finally {
    for (const pid of await app.evaluate(({ app }) => app.getAppMetrics().map(value => value.pid))) pids.add(pid);
    await app.windows()[0].evaluate(async () => { const state = await window.moonbaseChat.call("connection", "getConnection", {}, crypto.randomUUID()); if (state.ok && (state.value as { connectionId?: string }).connectionId) await window.moonbaseChat.call("connection", "disconnect", { connectionId: (state.value as { connectionId: string }).connectionId }, crypto.randomUUID()); });
    await app.evaluate(({ app }) => app.exit(0)); await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    for (const pid of pids) await expect.poll(() => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }).toBe(true);
    const host = await f?.close(); if (!f) rmSync(base, { recursive: true });
    writeFileSync(test.info().outputPath("cleanup.json"), JSON.stringify({ pids: [...pids], absent: true, directory: base, removed: true, host }, null, 2));
  }
});
