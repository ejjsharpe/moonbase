import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

const first = (page: Page) => page.getByRole("region", { name: "First editor", exact: true });
async function edit(page: Page, text: string) {
  const input = first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true });
  await input.focus(); await input.press("Meta+a"); await input.pressSequentially(text);
}

test("real Monaco edits/save, shared diff model and isolated second instance", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/"); await expect(first(page).getByRole("tab", { name: "welcome.ts", exact: true })).toBeVisible();
  await edit(page, "export const value = 42;");
  await expect(first(page).getByText("welcome.ts · Unsaved", { exact: true })).toBeVisible();
  await first(page).getByLabel("File view", { exact: true }).selectOption("staged");
  await expect(first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.demo.first.buffer({ checkout: window.demo.checkout, path: "welcome.ts" })!.text)).toBe("export const value = 42;");
  expect(await page.evaluate(() => window.demo.second.buffer({ checkout: window.demo.checkout, path: "welcome.ts" })!.text)).toContain("Hello Moonbase");
  await first(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(first(page).getByText("welcome.ts · Unsaved", { exact: true })).toHaveCount(0);
  const modelCount = await page.evaluate(() => window.demo.modelCount());
  await page.getByRole("button", { name: "Hide first editor", exact: true }).click();
  expect(await page.evaluate(() => window.demo.modelCount())).toBe(modelCount);
  await page.getByRole("button", { name: "Show first editor", exact: true }).click();
  await expect(first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/editor-two-instances.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("external conflict Compare/Cancel and failed Save preserve edits in the visible UI", async ({ page }) => {
  await page.goto("/"); await edit(page, "my retained edits");
  await page.getByRole("button", { name: "External change", exact: true }).click();
  await first(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(first(page).getByText("welcome.ts changed on disk. Your edits are retained.")).toBeVisible();
  await first(page).getByRole("button", { name: "Compare", exact: true }).click();
  await expect(first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true })).toBeVisible();
  await first(page).getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await page.evaluate(() => window.demo.first.buffer({ checkout: window.demo.checkout, path: "welcome.ts" })!.text)).toBe("my retained edits");
  await page.getByRole("button", { name: "Fail next Save", exact: true }).click();
  await first(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(first(page).getByRole("alert").last()).toContainText("Demo Save failed");
  expect(await page.evaluate(() => window.demo.first.buffer({ checkout: window.demo.checkout, path: "welcome.ts" })!.text)).toBe("my retained edits");
});

test("close dialog Cancel then Discard; Reopen reads disk and disposal releases Monaco/subscriptions", async ({ page }) => {
  await page.goto("/"); await edit(page, "unsaved");
  await first(page).getByRole("button", { name: "Close welcome.ts", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(first(page).getByRole("tab", { name: "welcome.ts", exact: true })).toBeVisible();
  await first(page).getByRole("button", { name: "Close welcome.ts", exact: true }).click();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(first(page).getByRole("tab", { name: "welcome.ts", exact: true })).toHaveCount(0);
  await first(page).getByRole("button", { name: "Tab actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reopen Closed Files", exact: true }).click();
  await expect(first(page).getByRole("tab", { name: "welcome.ts", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.demo.first.buffer({ checkout: window.demo.checkout, path: "welcome.ts" })!.text)).toContain("Hello Moonbase");
  const before = await page.evaluate(() => window.demo.modelCount());
  await page.getByRole("button", { name: "Dispose second editor", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.demo.memory.stats.active)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.demo.modelCount())).toBe(before - 1);
});

test("lookup groups/highlights, previews, tree actions and constrained layout", async ({ page }) => {
  await page.goto("/"); await page.setViewportSize({ width: 760, height: 720 });
  await first(page).getByRole("button", { name: "Find file", exact: true }).click();
  await expect(page.getByRole("group", { name: "Recent files", exact: true }).getByRole("option")).toContainText("welcome.ts");
  await page.getByRole("combobox").fill("exmp");
  await expect(page.getByRole("option")).toContainText("src/example.ts");
  await expect(page.locator('[role="option"] mark')).toHaveCount(4);
  await page.getByRole("combobox").press("Enter");
  await expect(first(page).getByRole("tab", { name: "src/example.ts", exact: true })).toBeVisible();
  await first(page).getByRole("button", { name: "New File", exact: true }).click();
  await page.getByLabel("Destination relative path").fill("created.txt");
  await page.getByRole("dialog").getByRole("button", { name: "New File", exact: true }).click();
  await expect(first(page).getByRole("tab", { name: "created.txt", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/editor-constrained.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sidebar = first(page).getByRole("separator", { name: "Resize sidebar" });
  await sidebar.focus(); await sidebar.press("Home"); await expect(sidebar).toHaveAttribute("aria-valuenow", "190");
});
