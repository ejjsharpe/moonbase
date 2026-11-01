import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { resolve, join } from "node:path";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { fixture, until } from "./fixture.ts";
const root = resolve(import.meta.dirname, ".."),
  require = createRequire(import.meta.url);
const evidence = join(root, "evidence");
async function launch(f: Awaited<ReturnType<typeof fixture>>, data: string, packaged = false) {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    MOONBASE_CHAT_CONFIG: f.clientConfig,
    MOONBASE_CHAT_DATA: data,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = packaged
    ? join(root, "release/mac-arm64/Moonbase Chat Proof.app/Contents/MacOS/Moonbase Chat Proof")
    : require("electron");
  const app = await electron.launch({
    executablePath,
    args: packaged ? [] : [join(root, "dist/main.mjs")],
    env,
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Connect", exact: true }).waitFor();
  return {
    app,
    page,
    async quit() {
      await app.evaluate(({ app }) => app.quit());
      await app.process().exitCode;
    },
  };
}
async function shutdown(app: ElectronApplication) {
  if (app.process().exitCode !== null) return;
  await app.evaluate(({ app }) => app.quit());
  if (app.process().exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Preserved Quit deadline")), 10000);
    app.process().once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
test("actual Electron proof: lost response, streamed tools, reload, captured Stop, reconnect and keyboard/constrained UI", async () => {
  const f = await fixture(true);
  let current: ElectronApplication | undefined;
  try {
    await mkdir(evidence, { recursive: true });
    const data = join(f.directory, "client-data");
    const first = await launch(f, data);
    current = first.app;
    const page = first.page;
    const versions = await first.app.evaluate(() => process.versions);
    expect(versions.electron).toBe("45.1.0");
    expect(versions.node).toBe("24.22.1");
    expect((await f.stats()).calls).toBe(0);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText("Verified host.", { exact: false })).toBeVisible();
    await page.getByLabel("New saved chat").fill("Remote workflow proof");
    await expect(page.getByLabel("New saved chat")).toHaveValue("Remote workflow proof");
    await expect(page.getByRole('button',{name:'Create chat',exact:true})).toBeEnabled();
    await page.getByRole("button", { name: "Create chat", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Remote workflow proof", exact: true }),
    ).toBeVisible();
    await f.loseNextSend();
    await page
      .getByLabel("Message", { exact: true })
      .fill("Inspect the controlled remote context once.");
    await page.getByLabel("Message", { exact: true }).press("Control+Enter");
    await expect(page.getByRole("region", { name: "Retained commands" })).toContainText(
      "Uncertain",
    );
    await expect(page.getByRole("article", { name: "Live response" })).toContainText(
      "Controlled remote tool activity",
    );
    await expect(
      page
        .getByRole("article", { name: "Live response" })
        .getByText("inspect_remote_context · running", { exact: true }),
    ).toBeInViewport();
    await page
      .getByLabel("Message", { exact: true })
      .fill("Newer draft stays unsent after reconnect.");
    await page.screenshot({ path: join(evidence, "normal.png") });
    const retained = await page.evaluate(
      () => JSON.parse(localStorage.getItem("moonbase.chat-proof.v1")!).pending[0],
    );
    expect(retained.operation).toBe("sendChat");
    await page.reload();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "Newer draft stays unsent after reconnect.",
    );
    await expect(page.getByRole("region", { name: "Retained commands" })).toHaveCount(0);
    expect((await f.stats()).commands.filter((c) => c === "sendChat")).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await until(f.stats, (s) => s.commands.includes("stopChat"));
    await expect(page.getByText("Chat stopped", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Remote workflow proof", exact: true }),
    ).toBeVisible();
    expect((await f.stats()).commands.filter((c) => c === "sendChat")).toHaveLength(1);
    await first.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(700, 650),
    );
    await page.getByLabel("Message", { exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeFocused();
    await page.screenshot({ path: join(evidence, "constrained-keyboard.png") });
    const dimensions = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      font: getComputedStyle(document.documentElement).fontFamily,
      focus: getComputedStyle(document.activeElement!).outlineStyle,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    expect(dimensions.font).toContain("-apple-system");
    expect(dimensions.focus).not.toBe("none");
    // Exact document/frame gate: an about:blank child frame cannot obtain configuration or dispatch.
    const frameResult = await page.evaluate(async () => {
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      return !!iframe.contentWindow && "moonbaseChat" in iframe.contentWindow;
    });
    expect(frameResult).toBe(false);
    await writeFile(
      join(evidence, "runtime.json"),
      JSON.stringify(
        {
          electron: versions.electron,
          node: versions.node,
          dimensions,
          sendDispatches: (await f.stats()).commands.filter((c) => c === "sendChat").length,
          toolCalls: (await f.stats()).tools,
          retainedRequestId: retained.input.requestId,
        },
        null,
        2,
      ),
    );
    await shutdown(first.app);
    current = undefined;
    const second = await launch(f, data);
    current = second.app;
    await expect(second.page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
    expect((await f.stats()).commands.filter((c) => c === "sendChat")).toHaveLength(1);
    await second.page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(second.page.getByLabel("Message", { exact: true })).toHaveValue(
      "Newer draft stays unsent after reconnect.",
    );
    await shutdown(second.app);
    current = undefined;
  } catch(error) {
    const page=current?.windows()[0];if(page&&!page.isClosed()){await page.screenshot({path:join(root,'test-results/native-failure.png')});await writeFile(join(root,'test-results/native-failure.txt'),await page.locator('body').innerText());}
    throw error;
  } finally {
    if (current) await current.close();
    await f.close();
  }
});

test("packaged actual client starts disconnected, uses public production transport and carries generated notices", async () => {
  const f = await fixture(false);
  let current: ElectronApplication | undefined;
  try {
    const { app, page } = await launch(f, join(f.directory, "packaged-data"), true);
    current = app;
    expect((await f.stats()).calls).toBe(0);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText("Verified host.", { exact: false })).toBeVisible();
    await page.getByLabel("New saved chat").fill("Packaged remote proof");
    await page.getByRole("button", { name: "Create chat", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Packaged client message");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
      "Remote response finished",
    );
    await page.screenshot({ path: join(evidence, "packaged.png") });
    expect((await f.stats()).commands.filter((c) => c === "sendChat")).toHaveLength(1);
    const archive = join(
      root,
      "release/mac-arm64/Moonbase Chat Proof.app/Contents/Resources/app.asar",
    );
    expect((await stat(archive)).size).toBeGreaterThan(0);
    await shutdown(app);
    current = undefined;
  } finally {
    if (current) await current.close();
    await f.close();
  }
});

test("actual Hide/Quit detach the client while remote work continues; a fresh client reconnects without Send", async () => {
  const f = await fixture(true);
  let current: ElectronApplication | undefined;
  try {
    const data = join(f.directory, "detached-data"),
      first = await launch(f, data);
    current = first.app;
    await first.page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(first.page.getByText("Verified host.", { exact: false })).toBeVisible();
    await first.page.getByLabel("New saved chat").fill("Detached remote work");
    await first.page.getByRole("button", { name: "Create chat", exact: true }).click();
    await expect(first.page.getByLabel("Message", { exact: true })).toBeEnabled();
    await first.page.getByLabel("Message", { exact: true }).fill("Continue after client Quit");
    await first.page.getByRole("button", { name: "Send message", exact: true }).click();
    await until(f.stats, (s) => s.tools === 1);
    await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await shutdown(first.app);
    current = undefined;
    expect((await f.stats()).tools).toBe(1);
    expect((await f.stats()).commands.filter((s) => s === "stopChat")).toHaveLength(0);
    const second = await launch(f, data);
    current = second.app;
    await second.page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(second.page.getByRole("article", { name: "Live response" })).toContainText(
      "Controlled remote tool activity",
    );
    expect((await f.stats()).commands.filter((s) => s === "sendChat")).toHaveLength(1);
    f.release();
    await expect(second.page.getByRole("region", { name: "Chat transcript" })).toContainText(
      "Remote response finished",
    );
    await shutdown(second.app);
    current = undefined;
  } finally {
    if (current) await current.close();
    await f.close();
  }
});
