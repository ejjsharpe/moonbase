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
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          [
            "PATH",
            "HOME",
            "TMPDIR",
            "TEMP",
            "TMP",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "__CF_USER_TEXT_ENCODING",
            "MOONBASE_CHAT_FORWARD_LOG",
            "MOONBASE_CHAT_DROP_SEND",
          ].includes(entry[0]),
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
  };
}
const electronCleanup: { pids: number[]; confirmedAbsent: boolean }[] = [];
const serviceCleanup: unknown[] = [];
async function shutdown(app: ElectronApplication) {
  if (app.process().exitCode !== null) return;
  const pids = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => m.pid));
  await app.evaluate(({ app }) => app.quit());
  if (app.process().exitCode === null)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Preserved Quit deadline")), 10000);
      app.process().once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  for (const pid of pids)
    await until(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    }, Boolean);
  electronCleanup.push({ pids, confirmedAbsent: true });
  await writeFile(
    join(evidence, "cleanup.json"),
    JSON.stringify({ electron: electronCleanup, services: serviceCleanup }, null, 2),
  );
}
async function closeFixture(f: Awaited<ReturnType<typeof fixture>>) {
  serviceCleanup.push(await f.close());
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, "cleanup.json"),
    JSON.stringify({ electron: electronCleanup, services: serviceCleanup }, null, 2),
  );
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
    await expect(page.getByRole("complementary", { name: "Saved chats" })).toHaveCSS(
      "border-right-width",
      "1px",
    );
    await expect(page.getByLabel("Message", { exact: true }).locator("..")).toHaveCSS(
      "border-top-width",
      "1px",
    );
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText("Verified host.", { exact: false })).toBeVisible();
    await page.getByLabel("New saved chat").fill("Remote workflow proof");
    await expect(page.getByLabel("New saved chat")).toHaveValue("Remote workflow proof");
    await expect(page.getByRole("button", { name: "Create chat", exact: true })).toBeEnabled();
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
  } catch (error) {
    const page = current?.windows()[0];
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(root, "test-results/native-failure.png") });
      await writeFile(
        join(root, "test-results/native-failure.txt"),
        await page.locator("body").innerText(),
      );
    }
    throw error;
  } finally {
    if (current) await current.close();
    await closeFixture(f);
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
    await closeFixture(f);
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
    await closeFixture(f);
  }
});

for (const packaged of [false, true])
  for (const operation of ["createChat", "sendChat", "stopChat"] as const)
    test(`${packaged ? "packaged" : "source"} ${operation}: committed reply lost on Disconnect retains original identity and never resends`, async () => {
      const f = await fixture(true);
      let current: ElectronApplication | undefined;
      try {
        const { app, page } = await launch(f, join(f.directory, "generation-data"), packaged);
        current = app;
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await expect(page.getByText("Verified host.", { exact: false })).toBeVisible();
        if (operation !== "createChat") {
          await page.getByLabel("New saved chat").fill("Exact generation");
          await page.getByRole("button", { name: "Create chat", exact: true }).click();
          await expect(
            page.getByRole("heading", { name: "Exact generation", exact: true }),
          ).toBeVisible();
        }
        if (operation === "stopChat") {
          await page
            .getByLabel("Message", { exact: true })
            .fill("One admitted task before exact Stop");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await expect(page.getByRole("article", { name: "Live response" })).toContainText(
            "Controlled remote tool activity",
          );
        }
        await f.holdReply(operation);
        if (operation === "createChat") {
          await page.getByLabel("New saved chat").fill("Captured creation");
          await page.getByRole("button", { name: "Create chat", exact: true }).click();
        } else if (operation === "sendChat") {
          await page
            .getByLabel("Message", { exact: true })
            .fill("Captured text at original generation");
          await page.getByRole("button", { name: "Send message", exact: true }).click();
        } else await page.getByRole("button", { name: "Stop", exact: true }).click();
        await until(f.stats, (s) => s.heldReplies.includes(operation));
        const retained = await page.evaluate(
          (op) =>
            JSON.parse(localStorage.getItem("moonbase.chat-proof.v1")!).pending.find(
              (p: { operation: string }) => p.operation === op,
            ),
          operation,
        );
        expect(retained.operation).toBe(operation);
        const originalConnection = await page.evaluate(
          async () =>
            await window.moonbaseChat.call("connection", "getConnection", {}, crypto.randomUUID()),
        );
        await page.getByRole("button", { name: "Disconnect", exact: true }).click();
        await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
        await expect(page.getByRole("region", { name: "Retained commands" })).toContainText(
          "Uncertain",
        );
        const afterLoss = await page.evaluate(
          (op) =>
            JSON.parse(localStorage.getItem("moonbase.chat-proof.v1")!).pending.find(
              (p: { operation: string }) => p.operation === op,
            ),
          operation,
        );
        expect(afterLoss.input).toEqual(retained.input);
        if (operation === "sendChat")
          await page
            .getByLabel("Message", { exact: true })
            .fill("Newer unsent edit after disconnect");
        f.releaseReply();
        await page.reload();
        await page.getByRole("button", { name: "Connect", exact: true }).click();
        await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeEnabled();
        await expect(page.locator("main").getByText(f.cwd, { exact: false })).toBeVisible();
        if (operation === "sendChat") {
          await expect(page.getByRole("region", { name: "Retained commands" })).toHaveCount(0);
          await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
            "Newer unsent edit after disconnect",
          );
        } else {
          const region = page.getByRole("region", { name: "Retained commands" });
          await region.locator("summary").click();
          await region
            .getByRole("button", {
              name: operation === "createChat" ? "Retry original Create" : "Retry original Stop",
              exact: true,
            })
            .click();
          await expect(region).toHaveCount(0);
        }
        const stats = await f.stats(),
          mutations = stats.mutations.filter((m) => m.operation === operation);
        expect(mutations.length).toBe(operation === "sendChat" ? 1 : 2);
        for (const call of mutations) expect(call.input).toEqual(retained.input);
        if (operation === "createChat") {
          expect(mutations[1].result).toEqual(mutations[0].result);
          expect(stats.calls).toBe(0);
        } else {
          expect(stats.commands.filter((c) => c === "sendChat")).toHaveLength(1);
          expect(stats.tools).toBe(1);
        }
        const latestConnection = await page.evaluate(
          async () =>
            await window.moonbaseChat.call("connection", "getConnection", {}, crypto.randomUUID()),
        );
        expect(latestConnection.ok && originalConnection.ok && latestConnection.value).not.toEqual(
          originalConnection.ok && originalConnection.value,
        );
        await writeFile(
          join(evidence, `${packaged ? "packaged" : "source"}-${operation}-generation.json`),
          JSON.stringify(
            {
              operation,
              retainedInput: retained.input,
              lossMessage: afterLoss.message,
              mutationInputs: mutations.map((m) => m.input),
              matchingReceipt:
                operation === "createChat"
                  ? JSON.stringify(mutations[0].result) === JSON.stringify(mutations[1].result)
                  : undefined,
              sendDispatches: stats.commands.filter((c) => c === "sendChat").length,
              tools: stats.tools,
            },
            null,
            2,
          ),
        );
        await shutdown(app);
        current = undefined;
      } finally {
        if (current) await current.close();
        await closeFixture(f);
      }
    });

for (const packaged of [false, true])
  test(`${packaged ? "packaged" : "source"} Create readiness: repeated reload/fill/refresh records the disabled-button symptom without bypass`, async () => {
    const f = await fixture(false);
    let current: ElectronApplication | undefined;
    const observations: unknown[] = [];
    try {
      const { app, page } = await launch(f, join(f.directory, "create-readiness"), packaged);
      current = app;
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.getByText("Verified host.", { exact: false })).toBeVisible();
      for (let i = 0; i < 12; i++) {
        if (i) {
          await page.reload();
          await expect(page.getByText("Verified host.", { exact: false })).toBeVisible();
        }
        await page.evaluate(() => {
          const events: { type: string; value: string; trusted: boolean; visibility: string }[] =
            [];
          (window as unknown as { createEvents: unknown }).createEvents = events;
          for (const type of ["input", "change"])
            document.getElementById("chat-title")!.addEventListener(type, (e) => {
              events.push({
                type: e.type,
                value: (e.target as HTMLInputElement).value,
                trusted: e.isTrusted,
                visibility: document.visibilityState,
              });
            });
        });
        const title = "Readiness " + i;
        await page.getByLabel("New saved chat").fill(title);
        if (i % 3 === 0) await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect(page.getByLabel("New saved chat")).toHaveValue(title);
        await expect(page.getByRole("button", { name: "Create chat", exact: true })).toBeEnabled({
          timeout: 2000,
        });
        observations.push(
          await page.evaluate(
            (i) => ({
              iteration: i,
              title: (document.getElementById("chat-title") as HTMLInputElement).value,
              disabled: Array.from(document.querySelectorAll("button")).find(
                (b) => b.textContent === "Create chat",
              )?.disabled,
              events: (window as unknown as { createEvents: unknown }).createEvents,
              visibility: document.visibilityState,
            }),
            i,
          ),
        );
        await page.getByRole("button", { name: "Create chat", exact: true }).click();
        await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      }
      expect((await f.stats()).commands.filter((c) => c === "createChat")).toHaveLength(12);
      expect((await f.stats()).calls).toBe(0);
      await shutdown(app);
      current = undefined;
    } catch (error) {
      const page = current?.windows()[0];
      if (page && !page.isClosed()) {
        await page.screenshot({
          path: join(evidence, `${packaged ? "packaged" : "source"}-create-readiness-failure.png`),
        });
        observations.push(
          await page.evaluate(() => ({
            body: document.body.innerText,
            title: (document.getElementById("chat-title") as HTMLInputElement)?.value,
            events: (window as unknown as { createEvents: unknown }).createEvents,
          })),
        );
      }
      throw error;
    } finally {
      await writeFile(
        join(evidence, `${packaged ? "packaged" : "source"}-create-readiness.json`),
        JSON.stringify(observations, null, 2),
      );
      if (current) await current.close();
      await closeFixture(f);
    }
  });
