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
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
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
  expect(errors).toEqual([]);
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
  await expect(first(page).getByRole("textbox", { name: "src/example.ts editor", exact: true })).toBeFocused();
  await first(page).getByRole("button", { name: "New File", exact: true }).click();
  await page.getByLabel("Destination relative path").fill("created.txt");
  await page.getByRole("dialog").getByRole("button", { name: "New File", exact: true }).click();
  await expect(first(page).getByRole("tab", { name: "created.txt", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/editor-constrained.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sidebar = first(page).getByRole("separator", { name: "Resize sidebar" });
  await sidebar.focus(); await sidebar.press("Home"); await expect(sidebar).toHaveAttribute("aria-valuenow", "190");
  await first(page).getByRole("treeitem", { name: "README.md", exact: true }).click();
  await expect(first(page).getByRole("tree", { name: "Files", exact: true })).toBeFocused();
});

test("R1 real close-checkout removes its Monaco models without a teardown exception", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/"); await expect(first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true })).toBeVisible();
  const before = await page.evaluate(() => window.demo.modelCount());
  await first(page).getByRole("button", { name: "Close checkout /demo/moonbase", exact: true }).click();
  await expect(first(page).getByText("Open a checkout to browse files and edit. Unsaved changes belong to this editor instance.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.demo.modelCount())).toBe(before - 1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "test-results/editor-checkout-closed.png", fullPage: true });
});

test("R2 rejected unchanged Rename/Move leaves explicit Save and Close usable", async ({ page }) => {
  await page.goto("/");
  await first(page).getByRole("treeitem", { name: "welcome.ts", exact: true }).click();
  await first(page).getByRole("button", { name: "Rename / Move", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Rename or move", exact: true }).click();
  await page.getByRole("button", { name: "Replace captured destination", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert").last()).toContainText("Cannot transfer an entry into itself");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await edit(page, "export const afterRejection = true;"); await first(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(first(page).getByText("welcome.ts · Unsaved", { exact: true })).toHaveCount(0);
  await first(page).getByRole("button", { name: "Close welcome.ts", exact: true }).click();
  await expect(first(page).getByRole("tab", { name: "welcome.ts", exact: true })).toHaveCount(0);
});

test("R2 close-all/reopen/close-active loads the surviving file instead of an unavailable placeholder", async ({ page }) => {
  await page.goto("/"); await first(page).getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  await first(page).getByRole("button", { name: "Tab actions", exact: true }).click(); await page.getByRole("menuitem", { name: "Close All", exact: true }).click();
  await expect(first(page).getByRole("tab", { name: "README.md", exact: true })).toHaveCount(0);
  await first(page).getByRole("button", { name: "Tab actions", exact: true }).click(); await page.getByRole("menuitem", { name: "Reopen Closed Files", exact: true }).click();
  await expect(first(page).getByRole("textbox", { name: "README.md editor", exact: true })).toBeVisible();
  await first(page).getByRole("button", { name: "Close README.md", exact: true }).click();
  await expect(first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true })).toBeVisible();
});

for (const navigation of ["visual", "recent"] as const) test(`R2 ${navigation} keyboard navigation restores typing focus and keeps tab-strip focus`, async ({ page }) => {
  await page.goto("/"); await first(page).getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  await first(page).getByRole("tab", { name: "welcome.ts", exact: true }).click();
  const editor = first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true }); await editor.focus();
  async function navigate() {
    if (navigation === "visual") await page.keyboard.press("Meta+Alt+ArrowRight");
    else { await page.keyboard.down("Control"); await page.keyboard.press("Tab"); await page.keyboard.up("Control"); }
  }
  await navigate();
  await expect(first(page).getByRole("textbox", { name: "README.md editor", exact: true })).toBeFocused();
  await page.keyboard.type("typed after " + navigation);
  await expect.poll(() => page.evaluate(() => window.demo.first.buffer({ checkout: window.demo.checkout, path: "README.md" })!.text)).toContain("typed after " + navigation);
  if (navigation === "visual") await page.screenshot({ path: "test-results/editor-keyboard-typing.png", fullPage: true });
  await first(page).getByRole("tab", { name: "README.md", exact: true }).focus(); await navigate();
  await expect(first(page).getByRole("tab", { name: "welcome.ts", exact: true })).toBeFocused();
});

test("R3 a checkout clicked during close publication remains selected live and durably", async ({ page }) => {
  await page.goto("/recovery-race.html");
  await expect(page.getByRole("textbox", { name: "b.ts editor", exact: true })).toBeVisible();
  await page.evaluate(() => window.recoveryRace.hold()); await page.getByRole("button", { name: "Close b.ts", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.recoveryRace.waiting)).toBe(true);
  await page.getByRole("tab", { name: "beta · main", exact: true }).click(); await page.evaluate(() => window.recoveryRace.release());
  await expect.poll(() => page.evaluate(() => window.recoveryRace.editor.getSnapshot().preserving)).toBe(false);
  expect(await page.evaluate(() => window.recoveryRace.editor.getSnapshot().recovery.selectedCheckoutId)).toBe("beta");
  expect(await page.evaluate(async () => (await window.recoveryRace.load()).state.selectedCheckoutId)).toBe("beta");
  await expect(page.getByRole("textbox", { name: "a.ts editor", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/editor-close-selection.png", fullPage: true });
});

for (const shortcut of ["close", "reopen"] as const) test(`R3 keyboard ${shortcut} hands off typing focus`, async ({ page }) => {
  await page.goto("/"); await first(page).getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  if (shortcut === "reopen") await first(page).getByRole("button", { name: "Close README.md", exact: true }).click();
  const previous = shortcut === "close" ? "README.md" : "welcome.ts", next = shortcut === "close" ? "welcome.ts" : "README.md";
  await first(page).getByRole("textbox", { name: previous + " editor", exact: true }).focus();
  await page.keyboard.press(shortcut === "close" ? "Meta+w" : "Meta+Shift+t");
  await expect(first(page).getByRole("textbox", { name: next + " editor", exact: true })).toBeFocused();
  await page.keyboard.type("typed after " + shortcut);
  await expect.poll(() => page.evaluate(path => window.demo.first.buffer({ checkout: window.demo.checkout, path })!.text, next)).toContain("typed after " + shortcut);
  await page.screenshot({ path: `test-results/editor-keyboard-${shortcut}.png`, fullPage: true });
});

test("R3 keyboard close cancellation and failed publication preserve typing focus and dialog scope", async ({ page }) => {
  await page.goto("/"); await edit(page, "dirty retained ");
  await page.keyboard.press("Meta+w"); const dialog = page.getByRole("dialog", { name: "Save changes before closing?", exact: true });
  await expect(dialog).toBeVisible(); await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Meta+Shift+t"); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true })).toBeFocused(); await page.keyboard.type("after cancel ");
  await page.getByRole("button", { name: "Fail next recovery", exact: true }).click();
  await first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true }).focus(); await page.keyboard.press("Meta+w");
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true })).toBeFocused(); await page.keyboard.type("after failed close ");
  expect(await page.evaluate(() => window.demo.first.buffer({ checkout: window.demo.checkout, path: "welcome.ts" })!.text)).toContain("after failed close");
});

test("R3 keyboard close/reopen retains tree or strip origin and meaningful empty-editor focus", async ({ page }) => {
  await page.goto("/"); await first(page).getByRole("treeitem", { name: "README.md", exact: true }).dblclick();
  for (const origin of ["strip", "tree"] as const) {
    const focused = origin === "strip" ? first(page).getByRole("tab", { name: "README.md", exact: true }) : first(page).getByRole("tree", { name: "Files", exact: true });
    await focused.focus(); await page.keyboard.press("Meta+w");
    await expect(origin === "strip" ? first(page).getByRole("tab", { name: "welcome.ts", exact: true }) : focused).toBeFocused();
    await page.keyboard.press("Meta+Shift+t"); await expect(focused).toBeFocused();
  }
  await first(page).getByRole("textbox", { name: "README.md editor", exact: true }).focus(); await page.keyboard.press("Meta+w");
  await first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true }).focus(); await page.keyboard.press("Meta+w");
  await expect(first(page).getByRole("button", { name: "Find file", exact: true })).toBeFocused();
  await page.keyboard.press("Meta+Shift+t"); await expect(first(page).getByRole("textbox", { name: "welcome.ts editor", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Hide first editor", exact: true }).click();
  const before = await page.evaluate(() => window.demo.first.getSnapshot().recovery);
  await page.keyboard.press("Meta+Shift+t"); expect(await page.evaluate(() => window.demo.first.getSnapshot().recovery)).toEqual(before);
});
