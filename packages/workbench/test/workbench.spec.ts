import { test, expect } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import { resolve } from 'node:path';

async function openTabMenu(editor: Page | Locator) {
  await editor
    .getByRole('tablist', { name: 'Open files', exact: true })
    .getByRole('tab', { selected: true })
    .click({ button: 'right' });
}

async function saveFile(editor: Page | Locator) {
  await editor.getByRole('textbox', { name: / editor$/ }).press('Meta+s');
}

async function selectFileView(editor: Page | Locator, view: string) {
  const page = 'page' in editor ? editor.page() : editor;
  await openTabMenu(editor);
  await page.getByRole('menuitem', { name: 'File view', exact: true }).click();
  await page
    .getByRole('menuitemradio', { name: view === 'file' ? 'File' : view, exact: true })
    .click();
}

declare global {
  interface Window {
    releaseTabClose(): void;
    tabCloseHeld: boolean;
  }
}

const first = (page: Page) => page.getByRole('region', { name: 'First editor', exact: true });
/** Runs one of the explorer's "…" menu actions. */
async function explorerAction(scope: Locator | Page, name: string) {
  await scope.getByRole('button', { name: 'Explorer actions', exact: true }).click();
  const page = 'goto' in scope ? scope : scope.page();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function expectSaveEnabled(editor: Page | Locator, enabled: boolean) {
  const page = 'page' in editor ? editor.page() : editor;
  await openTabMenu(editor);
  const action = page.getByRole('menuitem', { name: 'Save', exact: true });
  if (enabled) await expect(action).toBeEnabled();
  else await expect(action).toBeDisabled();
  await page.keyboard.press('Escape');
}

async function edit(page: Page, text: string) {
  const input = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await input.focus();
  await input.press('Meta+a');
  await input.pressSequentially(text);
}

test('compact breadcrumbs show the checkout and path without toolbar actions', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const { first, checkout } = window.demo;
    return first.open({ checkout, path: 'src/example.ts' }, { intent: 'keep' });
  });
  const breadcrumbs = first(page).getByRole('navigation', { name: 'File breadcrumbs' });
  await expect(breadcrumbs.getByRole('listitem')).toHaveText(['moonbase', '/src', '/example.ts']);
  await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText('/example.ts');
  await expect(breadcrumbs).toHaveAttribute('title', '/demo/moonbase/src/example.ts');
  await expect(breadcrumbs).toHaveCSS('height', '28px');
  await expect(breadcrumbs.getByRole('button')).toHaveCount(0);
  await expect(first(page).getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(first(page).getByRole('button', { name: 'Tab actions', exact: true })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 543, height: 441 });
  await expect(breadcrumbs).toHaveCSS('height', '28px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await first(page).getByRole('button', { name: 'Close src/example.ts', exact: true }).click();
  await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText('/welcome.ts');
  await first(page).getByRole('button', { name: 'Close welcome.ts', exact: true }).click();
  await expect(breadcrumbs).toHaveCount(0);
});

test('the Changes view groups changed files by area, counts them and opens their comparison', async ({
  page,
}) => {
  await page.goto('/');
  const editor = first(page);
  const files = editor.getByRole('button', { name: 'Files', exact: true });
  const changes = editor.getByRole('button', { name: 'Changes', exact: true });
  await expect(files).toHaveAttribute('aria-pressed', 'true');
  const badge = changes.locator('[aria-hidden="true"]');
  await expect(badge).toHaveText(/^\d+$/);
  const count = Number(await badge.textContent());
  await changes.click();
  await expect(changes).toHaveAttribute('aria-pressed', 'true');
  const staged = editor.getByRole('region', { name: 'Staged', exact: true });
  const unstaged = editor.getByRole('region', { name: 'Changes', exact: true });
  await expect(staged.getByRole('heading')).toHaveText(/^Staged\s*1$/);
  // welcome.ts is both staged and changed again since; the badge counts it once.
  const rows = editor
    .getByRole('region', { name: /^(Staged|Changes|Untracked)$/ })
    .getByRole('listitem');
  const paths = await rows.evaluateAll((items) =>
    items.map((item) => item.querySelector('button')?.getAttribute('aria-label')),
  );
  expect(paths.filter((path) => path === 'welcome.ts')).toHaveLength(2);
  expect(new Set(paths).size).toBe(count);
  expect(paths.length).toBe(count + 1);
  const stagedWelcome = staged.getByRole('button', { name: 'welcome.ts', exact: true });
  const unstagedWelcome = unstaged.getByRole('button', { name: 'welcome.ts', exact: true });
  await stagedWelcome.click();
  await expect(
    editor.getByRole('textbox', { name: 'staged · welcome.ts original', exact: true }),
  ).toBeVisible();
  await expect(stagedWelcome).toHaveAttribute('aria-current', 'true');
  await expect(unstagedWelcome).not.toHaveAttribute('aria-current', 'true');
  await page.screenshot({ path: 'test-results/changes-view.png' });
  await files.click();
  await expect(editor.getByRole('tree')).toBeVisible();
});

test('the editor uses a subtle scroll shadow below the breadcrumbs', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const { first, checkout } = window.demo;
    first.edit(
      { checkout, path: 'welcome.ts' },
      Array.from({ length: 200 }, (_, line) => `// line ${line}`).join('\n'),
    );
  });
  await first(page)
    .getByRole('textbox', { name: 'welcome.ts editor', exact: true })
    .press('Meta+ArrowDown');
  const shadow = first(page).locator('.monaco-editor .scroll-decoration');
  await expect(shadow).toBeVisible();
  await expect(shadow).toHaveCSS('box-shadow', 'rgba(0, 0, 0, 0.2) 0px 6px 6px -6px inset');
});

test('a background tab context menu closes its captured file and keeps the current breadcrumbs', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.open({ checkout, path: 'README.md' }, { intent: 'keep' });
    await first.open({ checkout, path: 'src/example.ts' }, { intent: 'keep' });
  });
  const background = first(page).getByRole('tab', { name: 'README.md', exact: true });
  await background.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
  await expect(background).toHaveCount(0);
  await expect(
    first(page).getByRole('tab', { name: 'src/example.ts', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    first(page)
      .getByRole('navigation', { name: 'File breadcrumbs' })
      .locator('[aria-current="page"]'),
  ).toHaveText('/example.ts');
});

async function holdLateClose(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.open({ checkout, path: 'README.md' }, { intent: 'keep' });
    const open = first.open.bind(first);
    let held = false;
    window.tabCloseHeld = false;
    window.releaseTabClose = () => {};
    first.open = async (...args) => {
      const result = await open(...args);
      if (!held) {
        held = true;
        window.tabCloseHeld = true;
        await new Promise<void>((resolve) => {
          window.releaseTabClose = resolve;
        });
      }
      return result;
    };
  });
  await openTabMenu(first(page));
  await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
  await expect(first(page).getByRole('tab', { name: 'README.md', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.tabCloseHeld)).toBe(true);
}
async function releaseLateClose(page: Page) {
  await page.evaluate(() => {
    window.releaseTabClose?.();
    return new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

for (const destination of ['tab menu', 'file menu', 'second editor'] as const)
  test(`late Close completion keeps newer focus in ${destination}`, async ({ page }) => {
    try {
      await holdLateClose(page);
      let focused: Locator;
      if (destination === 'tab menu') {
        const tab = first(page).getByRole('tab', { name: 'welcome.ts', exact: true });
        await tab.press('Shift+F10');
        focused = page.getByRole('menuitem', { name: 'Keep Open', exact: true });
      } else if (destination === 'file menu') {
        await first(page)
          .getByRole('treeitem', { name: 'welcome.ts, modified', exact: true })
          .click({ button: 'right' });
        await page.keyboard.press('Home');
        focused = page
          .getByRole('menu', { name: 'File actions', exact: true })
          .getByRole('menuitem')
          .first();
      } else {
        focused = page
          .getByRole('region', { name: 'Second editor', exact: true })
          .getByRole('textbox', { name: 'welcome.ts editor', exact: true });
        await focused.focus();
      }
      await expect(focused).toBeFocused();
      await releaseLateClose(page);
      await expect(focused).toBeFocused();
      if (destination === 'tab menu') {
        await page.keyboard.press('Enter');
        await expect(page.getByRole('menu')).toHaveCount(0);
      }
    } finally {
      await releaseLateClose(page);
    }
  });

test('late Close completion preserves newer editor typing and its first key', async ({ page }) => {
  try {
    await holdLateClose(page);
    const input = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
    await first(page)
      .locator('.monaco-editor .view-lines')
      .first()
      .click({ position: { x: 80, y: 10 } });
    await page.keyboard.type('before completion ');
    await expect(input).toBeFocused();
    await releaseLateClose(page);
    await page.screenshot({ path: test.info().outputPath('same-workbench-typing.png') });
    await page.keyboard.type('first key after completion ');
    const text = await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    );
    expect.soft(text).toContain('first key after completion ');
    await expect(input).toBeFocused();
  } finally {
    await releaseLateClose(page);
  }
});

test('late Close completion preserves newer tree navigation and its first arrow', async ({
  page,
}) => {
  try {
    await holdLateClose(page);
    const tree = first(page).getByRole('tree', { name: 'Files', exact: true });
    await first(page).getByRole('treeitem', { name: 'src', exact: true }).click();
    await tree.press('Home');
    await expect(tree).toBeFocused();
    await releaseLateClose(page);
    await page.screenshot({ path: test.info().outputPath('same-workbench-tree.png') });
    const before = await page.evaluate(
      () => window.demo.first.getSnapshot().recovery.views.sample.tree.focus,
    );
    await page.keyboard.press('ArrowDown');
    expect
      .soft(
        await page.evaluate(() => window.demo.first.getSnapshot().recovery.views.sample.tree.focus),
      )
      .not.toBe(before);
    await expect(tree).toBeFocused();
  } finally {
    await releaseLateClose(page);
  }
});

test('late Close completion preserves a newly chosen file and its first key', async ({ page }) => {
  try {
    await holdLateClose(page);
    await first(page).getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
    const input = first(page).getByRole('textbox', { name: 'README.md editor', exact: true });
    await first(page)
      .locator('.monaco-editor .view-lines')
      .first()
      .click({ position: { x: 80, y: 10 } });
    await expect(input).toBeFocused();
    await releaseLateClose(page);
    await page.keyboard.type('new file first key ');
    expect
      .soft(
        await page.evaluate(
          () =>
            window.demo.first.buffer({ checkout: window.demo.checkout, path: 'README.md' })!.text,
        ),
      )
      .toContain('new file first key ');
    await expect(input).toBeFocused();
  } finally {
    await releaseLateClose(page);
  }
});

test('late Close completion preserves newer sidebar resize and its first arrow', async ({
  page,
}) => {
  try {
    await holdLateClose(page);
    const separator = first(page).getByRole('separator', { name: 'Resize sidebar', exact: true });
    await separator.click();
    await expect(separator).toBeFocused();
    const width = Number(await separator.getAttribute('aria-valuenow'));
    await releaseLateClose(page);
    await page.keyboard.press('ArrowRight');
    await expect(separator).toHaveAttribute('aria-valuenow', String(width + 10));
  } finally {
    await releaseLateClose(page);
  }
});

for (const release of ['after keyup', 'before keyup'] as const)
  test(`late Close completion preserves new Tab entry from consumer chrome ${release}`, async ({
    page,
  }) => {
    try {
      await holdLateClose(page);
      const chrome = page.getByRole('button', { name: 'Dispose second editor', exact: true });
      await chrome.click();
      await expect(chrome).toBeFocused();
      if (release === 'before keyup') await page.keyboard.down('Tab');
      else await page.keyboard.press('Tab');
      const separator = first(page).getByRole('separator', { name: 'Resize sidebar', exact: true });
      await expect(separator).toBeFocused();
      await releaseLateClose(page);
      if (release === 'before keyup') await page.keyboard.up('Tab');
      await page.screenshot({ path: test.info().outputPath('tab-entry.png') });
      const width = Number(await separator.getAttribute('aria-valuenow'));
      expect(width).toBe(270);
      await page.keyboard.press('ArrowRight');
      await expect.soft(separator).toHaveAttribute('aria-valuenow', String(width + 10));
      await expect(separator).toBeFocused();
    } finally {
      await page.keyboard.up('Tab');
      await releaseLateClose(page);
    }
  });

for (const source of [
  'nonfocusable consumer surface',
  'disconnected consumer button',
  'menu',
] as const)
  for (const release of ['after keyup', 'before keyup'] as const)
    test(`late Close completion preserves Tab entry from ${source} ${release}`, async ({
      page,
    }) => {
      try {
        await holdLateClose(page);
        if (source === 'menu') {
          await page.evaluate(
            async (path) => import(/* @vite-ignore */ path),
            `/@fs/${resolve('test/fixtures/consumer-menu.tsx')}`,
          );
          await page.getByRole('button', { name: 'Consumer overlay', exact: true }).click();
          await page.keyboard.press('ArrowDown');
          await expect(
            page.getByRole('menuitem', { name: 'Last consumer action', exact: true }),
          ).toBeFocused();
        } else {
          await page.evaluate((kind) => {
            const last = [...document.querySelectorAll('button')].find(
              (button) => button.textContent === 'Dispose second editor',
            )!;
            const element = document.createElement(
              kind === 'nonfocusable consumer surface' ? 'span' : 'button',
            );
            element.textContent = 'Consumer navigation surface';
            last.after(element);
            if (kind === 'disconnected consumer button')
              element.addEventListener('blur', () => element.remove(), { once: true });
          }, source);
          await page.getByText('Consumer navigation surface', { exact: true }).click();
          if (source === 'nonfocusable consumer surface')
            expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
        }
        if (release === 'before keyup') await page.keyboard.down('Tab');
        else await page.keyboard.press('Tab');
        if (source === 'menu')
          await expect(
            page.getByRole('menu', { name: 'Consumer navigation', exact: true }),
          ).toHaveCount(0);
        const separator = first(page).getByRole('separator', {
          name: 'Resize sidebar',
          exact: true,
        });
        await expect(separator).toBeFocused();
        await expect(separator).toHaveAttribute('aria-valuenow', '270');
        await releaseLateClose(page);
        if (release === 'before keyup') await page.keyboard.up('Tab');
        await page.keyboard.press('ArrowRight');
        await expect.soft(separator).toHaveAttribute('aria-valuenow', '280');
        await expect(separator).toBeFocused();
      } finally {
        await page.keyboard.up('Tab');
        await releaseLateClose(page);
      }
    });

test('late Close completion preserves programmatic entry from consumer chrome', async ({
  page,
}) => {
  try {
    await holdLateClose(page);
    const separator = first(page).getByRole('separator', { name: 'Resize sidebar', exact: true });
    // A consumer moves focus into the view without Tab or pointer input, like a restored view switch.
    await separator.evaluate((target: HTMLElement) => {
      const last = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Dispose second editor',
      )!;
      const consumer = document.createElement('button');
      consumer.textContent = 'Consumer focus restore';
      last.after(consumer);
      consumer.focus();
      target.focus();
    });
    await expect(separator).toBeFocused();
    await expect(separator).toHaveAttribute('aria-valuenow', '270');
    await releaseLateClose(page);
    await page.keyboard.press('ArrowRight');
    await expect.soft(separator).toHaveAttribute('aria-valuenow', '280');
    await expect(separator).toBeFocused();
  } finally {
    await releaseLateClose(page);
  }
});

for (const survivor of [true, false])
  test(`keyboard context-menu Close restores ${survivor ? 'the surviving tab' : 'empty-editor'} focus and allows Reopen`, async ({
    page,
  }) => {
    await page.goto('/');
    const path = survivor ? 'README.md' : 'welcome.ts';
    if (survivor)
      await page.evaluate(() => {
        const { first, checkout } = window.demo;
        return first.open({ checkout, path: 'README.md' }, { intent: 'keep' });
      });
    const tab = first(page).getByRole('tab', { name: path, exact: true });
    await tab.focus();
    await tab.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Keep Open', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(tab).toHaveCount(0);
    const fallback = survivor
      ? first(page).getByRole('tab', { name: 'welcome.ts', exact: true })
      : first(page).getByRole('button', { name: 'Explorer actions', exact: true });
    await expect(fallback).toBeFocused();
    await page.keyboard.press('Meta+Shift+t');
    await expect(tab).toBeVisible();
    await expect(
      survivor ? tab : first(page).getByRole('textbox', { name: `${path} editor`, exact: true }),
    ).toBeFocused();
  });

test('buffer tabs are spaced pills that reveal only their own close control without moving', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.open({ checkout, path: 'README.md' }, { intent: 'keep' });
    await first.open({ checkout, path: 'src/example.ts' }, { intent: 'preview' });
  });
  const strip = first(page).getByRole('tablist', { name: 'Open files', exact: true });
  const welcome = strip.getByRole('tab', { name: 'welcome.ts', exact: true });
  const readme = strip.getByRole('tab', { name: 'README.md', exact: true });
  const example = strip.getByRole('tab', { name: 'src/example.ts', exact: true });
  const closeWelcome = strip.getByRole('button', { name: 'Close welcome.ts', exact: true });
  const closeReadme = strip.getByRole('button', { name: 'Close README.md', exact: true });
  const closeExample = strip.getByRole('button', { name: 'Close src/example.ts', exact: true });
  await expect(example).toHaveAttribute('aria-selected', 'true');
  await page.mouse.move(0, 0);
  await expect(closeExample).toHaveCSS('opacity', '1');
  await expect(closeWelcome).toHaveCSS('opacity', '0');
  await expect(closeReadme).toHaveCSS('opacity', '0');
  const geometry = await strip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const groups = [...element.children].map((group) => group.getBoundingClientRect());
    return {
      height: bounds.height,
      inset: groups[0]!.left - bounds.left,
      gaps: groups.slice(1).map((group, index) => group.left - groups[index]!.right),
    };
  });
  expect(geometry).toEqual({ height: 40, inset: 8, gaps: [3, 3] });
  await expect(welcome).toHaveCSS('border-radius', '8px');
  // Type marks stand in for the file icon; the name alone labels the tab.
  await expect(example).toContainText('TS');
  await expect(example).toContainText('example.ts');
  await expect(example).toHaveCSS('font-style', 'italic');
  // Measure once the tab's entry animation has settled.
  await expect
    .poll(() =>
      example.evaluate(async (element) => {
        const width = element.getBoundingClientRect().width;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return width === element.getBoundingClientRect().width;
      }),
    )
    .toBe(true);
  const originalBounds = await example.boundingBox();
  await welcome.hover();
  await expect(closeWelcome).toHaveCSS('opacity', '1');
  await expect(closeReadme).toHaveCSS('opacity', '0');
  expect(await example.boundingBox()).toEqual(originalBounds);
  await page.mouse.move(0, 0);
  await closeReadme.focus();
  await expect(closeReadme).toBeFocused();
  await expect(closeReadme).toHaveCSS('opacity', '1');
  await expect(closeWelcome).toHaveCSS('opacity', '0');
  await closeReadme.press('Enter');
  await expect(readme).toHaveCount(0);
  await expect(example).toHaveAttribute('aria-selected', 'true');
  const path = 'a-long-buffer-filename-that-must-leave-room-for-the-unsaved-dot-and-close.ts';
  await page.evaluate(async (path) => {
    const { first, checkout } = window.demo;
    await first.mutate({
      checkout,
      kind: 'create-file',
      sources: [],
      destination: path,
      text: '',
    });
    await first.open({ checkout, path }, { intent: 'keep' });
  }, path);
  await first(page)
    .getByRole('textbox', { name: `${path} editor`, exact: true })
    .press('a');
  const longTab = strip.getByRole('tab', { name: path, exact: true });
  await expect(longTab).toHaveAttribute('aria-description', 'Unsaved');
  // An unsaved tab keeps its control visible as a dot, which turns into × under the pointer.
  const closeLong = strip.getByRole('button', { name: `Close ${path}`, exact: true });
  await expect(closeLong).toBeVisible();
  await welcome.click();
  await page.mouse.move(0, 0);
  await expect(closeLong).toHaveCSS('opacity', '1');
  const dot = closeLong.locator('span[aria-hidden="true"]');
  await expect(dot).toHaveCSS('width', '7px');
  await expect(closeLong.locator('svg')).toBeHidden();
  await longTab.hover();
  await expect(dot).toBeHidden();
  await expect(closeLong.locator('svg')).toBeVisible();
});

test('tabs that share a file name show the folder that tells them apart', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.mutate({
      checkout,
      kind: 'create-file',
      sources: [],
      destination: 'src/welcome.ts',
      text: '',
    });
    await first.open({ checkout, path: 'src/welcome.ts' }, { intent: 'keep' });
  });
  const strip = first(page).getByRole('tablist', { name: 'Open files', exact: true });
  const nested = strip.getByRole('tab', { name: 'src/welcome.ts', exact: true });
  await expect(nested).toHaveText('TSwelcome.tssrc');
  await expect(strip.getByRole('tab', { name: 'welcome.ts', exact: true })).toHaveText(
    'TSwelcome.ts',
  );
  await strip.getByRole('button', { name: 'Close src/welcome.ts', exact: true }).click();
  await expect(strip.getByRole('tab', { name: 'welcome.ts', exact: true })).toHaveText(
    'TSwelcome.ts',
  );
});

test('opening, editing and saving a UTF-8 BOM file preserves its marker', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.mutate({
      checkout,
      kind: 'create-file',
      sources: [],
      destination: 'bom.txt',
      text: '\ufeffhello\n',
    });
    await first.open({ checkout, path: 'bom.txt' }, { intent: 'keep' });
  });
  const input = first(page).getByRole('textbox', { name: 'bom.txt editor', exact: true });
  await expect(input).toBeVisible();
  const buffer = () =>
    page.evaluate(() => {
      const value = window.demo.first.buffer({ checkout: window.demo.checkout, path: 'bom.txt' })!;
      return { text: value.text, dirty: value.text !== value.disk.text };
    });
  expect(await buffer()).toEqual({ text: '\ufeffhello\n', dirty: false });
  await input.focus();
  await input.press('Control+Home');
  await input.pressSequentially('edited ');
  await expect.poll(buffer).toEqual({ text: '\ufeffedited hello\n', dirty: true });
  await saveFile(first(page));
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            await window.demo.client.command('readFile', {
              checkout: window.demo.checkout,
              path: 'bom.txt',
            })
          ).text,
      ),
    )
    .toBe('\ufeffedited hello\n');
  await expect.poll(buffer).toEqual({ text: '\ufeffedited hello\n', dirty: false });
});

test('real Monaco edits/save, shared diff model and isolated second instance', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(first(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toBeVisible();
  await edit(page, 'export const value = 42;');
  await expect(first(page).getByText('welcome.ts · Unsaved', { exact: true })).toBeVisible();
  await selectFileView(first(page), 'staged');
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    ),
  ).toBe('export const value = 42;');
  expect(
    await page.evaluate(
      () => window.demo.second.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    ),
  ).toContain('Hello Moonbase');
  await saveFile(first(page));
  await expect(first(page).getByText('welcome.ts · Unsaved', { exact: true })).toHaveCount(0);
  const modelCount = await page.evaluate(() => window.demo.modelCount());
  await page.getByRole('button', { name: 'Hide first editor', exact: true }).click();
  expect(await page.evaluate(() => window.demo.modelCount())).toBe(modelCount);
  await page.getByRole('button', { name: 'Show first editor', exact: true }).click();
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/editor-two-instances.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('external conflict Compare/Cancel and failed Save preserve edits in the visible UI', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await edit(page, 'my retained edits');
  await page.getByRole('button', { name: 'External change', exact: true }).click();
  await saveFile(first(page));
  await expect(
    first(page).getByText('welcome.ts changed on disk. Your edits are retained.'),
  ).toBeVisible();
  await first(page).getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeVisible();
  await first(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(
    await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    ),
  ).toBe('my retained edits');
  await page.getByRole('button', { name: 'Fail next Save', exact: true }).click();
  await saveFile(first(page));
  await expect(first(page).getByRole('alert').last()).toContainText('Demo Save failed');
  expect(
    await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    ),
  ).toBe('my retained edits');
  expect(errors).toEqual([]);
});

test('close dialog Cancel then Discard; Reopen reads disk and disposal releases Monaco/subscriptions', async ({
  page,
}) => {
  await page.goto('/');
  await edit(page, 'unsaved');
  await first(page).getByRole('button', { name: 'Close welcome.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(first(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toBeVisible();
  await first(page).getByRole('button', { name: 'Close welcome.ts', exact: true }).click();
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(first(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toHaveCount(0);
  await first(page).getByLabel('Moonbase editor', { exact: true }).press('Meta+Shift+t');
  await expect(first(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    ),
  ).toContain('Hello Moonbase');
  const before = await page.evaluate(() => window.demo.modelCount());
  await page.getByRole('button', { name: 'Dispose second editor', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.demo.memory.stats.active)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.demo.modelCount())).toBe(before - 1);
});

for (const origin of ['editor', 'file tab', 'Explorer actions button'] as const)
  test(`Go to restores ${origin} focus and reopens after dismissal`, async ({ page }) => {
    await page.goto('/');
    let focused = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
    if (origin === 'file tab')
      focused = first(page)
        .getByRole('tablist', { name: 'Open files', exact: true })
        .getByRole('tab', { name: 'welcome.ts', exact: true });
    else if (origin === 'Explorer actions button')
      focused = first(page).getByRole('button', { name: 'Explorer actions', exact: true });
    await focused.focus();
    const dialog = page.getByRole('dialog', { name: 'Go to', exact: true });
    for (const dismiss of ['Escape', 'outside click'] as const) {
      await page.keyboard.press('ControlOrMeta+p');
      await expect(dialog.getByRole('combobox')).toBeFocused();
      if (dismiss === 'Escape') await page.keyboard.press('Escape');
      else await page.mouse.click(4, 4);
      await expect(dialog).toHaveCount(0);
      await expect(focused).toBeFocused();
    }
    await page.keyboard.press('ControlOrMeta+p');
    await expect(dialog.getByRole('combobox')).toBeFocused();
    await dialog.getByRole('combobox').fill('README');
    await expect(dialog.getByRole('option', { name: 'README.md', exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(
      first(page).getByRole('textbox', { name: 'README.md editor', exact: true }),
    ).toBeFocused();
  });

test('Go to lists recent files first, highlights matches and opens an exact path at once', async ({
  page,
}) => {
  await page.goto('/');
  await page.setViewportSize({ width: 760, height: 720 });
  await explorerAction(first(page), 'Go to File…');
  const dialog = page.getByRole('dialog', { name: 'Go to', exact: true });
  await expect(dialog.getByRole('option').first()).toHaveAccessibleName('welcome.ts');
  await dialog.getByRole('combobox').fill('exmp');
  await expect(dialog.getByRole('option').first()).toHaveAccessibleName('src/example.ts');
  await expect(dialog.locator('[role="option"]').first().locator('mark')).toHaveCount(4);
  await dialog.getByRole('combobox').press('Enter');
  await expect(first(page).getByRole('tab', { name: 'src/example.ts', exact: true })).toBeVisible();
  await expect(
    first(page).getByRole('textbox', { name: 'src/example.ts editor', exact: true }),
  ).toBeFocused();
  // Enter right after typing waits for that query instead of opening the previous top row.
  await page.keyboard.press('ControlOrMeta+p');
  await dialog.getByRole('combobox').fill('README.md');
  await dialog.getByRole('combobox').press('Enter');
  await expect(
    first(page).getByRole('textbox', { name: 'README.md editor', exact: true }),
  ).toBeFocused();
  await explorerAction(first(page), 'New File…');
  await page.getByLabel('Destination relative path').fill('created.txt');
  await page.getByRole('dialog').getByRole('button', { name: 'New File', exact: true }).click();
  await expect(first(page).getByRole('tab', { name: 'created.txt', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/editor-constrained.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sidebar = first(page).getByRole('separator', { name: 'Resize sidebar' });
  await sidebar.focus();
  await sidebar.press('Home');
  await expect(sidebar).toHaveAttribute('aria-valuenow', '190');
  await first(page).getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await expect(first(page).getByRole('tree', { name: 'Files', exact: true })).toBeFocused();
});

test('Tab switches to Find, which previews matches and opens the file at the match', async ({
  page,
}) => {
  await page.goto('/');
  const editor = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+p');
  await page
    .getByRole('dialog', { name: 'Go to', exact: true })
    .getByRole('combobox')
    .fill('value');
  await page.keyboard.press('Tab');
  const find = page.getByRole('dialog', { name: 'Find in files', exact: true });
  await expect(find.getByRole('tab', { name: 'Find', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // What was typed in Go to carries over.
  await expect(find.getByRole('combobox')).toHaveValue('value');
  await expect(find.getByRole('group', { name: 'src/example.ts', exact: true })).toBeVisible();
  const matches = find.getByRole('option');
  await expect(matches).toHaveCount(2);
  await expect(matches.first()).toHaveAccessibleName(
    'Line 1: export function double(value: number) {',
  );
  await expect(find.getByRole('region', { name: 'Preview', exact: true })).toContainText(
    'return value * 2;',
  );
  await page.keyboard.press('ArrowDown');
  await expect(matches.nth(1)).toHaveAttribute('aria-selected', 'true');
  await find.getByRole('button', { name: 'Match case', exact: true }).click();
  await expect(find.getByRole('button', { name: 'Match case', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await find.getByRole('combobox').fill('VALUE');
  await expect(find.getByRole('status')).toHaveText('No matches.');
  await find.getByRole('combobox').press('Alt+c');
  await expect(matches).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(find).toHaveCount(0);
  const opened = first(page).getByRole('textbox', { name: 'src/example.ts editor', exact: true });
  await expect(opened).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.demo.first.getSnapshot().recovery.views.sample.positions['src/example.ts']?.file
            ?.line,
      ),
    )
    .toBe(2);
  // ⌘⇧F starts from the selected text; ⇥ goes back to Go to.
  await page.keyboard.press('ControlOrMeta+Shift+f');
  await expect(find.getByRole('combobox')).toHaveValue('value');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('dialog', { name: 'Go to', exact: true })).toBeVisible();
});

test('a change on disk refreshes picker results without moving the selected row', async ({
  page,
}) => {
  await page.goto('/');
  await first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+Shift+f');
  const find = page.getByRole('dialog', { name: 'Find in files', exact: true });
  await find.getByRole('combobox').fill('value');
  const matches = find.getByRole('option');
  await expect(matches).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await expect(matches.nth(1)).toHaveAttribute('aria-selected', 'true');
  // Another writer (an agent, a build) changes the checkout while the picker is open.
  await page.evaluate(() =>
    window.demo.memory.externalWrite(
      { checkout: window.demo.checkout, path: 'src/example.ts' },
      'export function double(value: number) {\n  return value * 2;\n}\n// value\n',
    ),
  );
  await expect(matches).toHaveCount(3);
  // Let React settle any selection effects the new results trigger.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  expect(
    await matches.evaluateAll((rows) =>
      rows.findIndex((row) => row.getAttribute('aria-selected') === 'true'),
    ),
  ).toBe(1);
  // A new query still starts at the top.
  await find.getByRole('combobox').fill('valu');
  await expect(matches.first()).toHaveAttribute('aria-selected', 'true');
});

test('Enter opens the highlighted row while changes on disk keep refreshing Go to', async ({
  page,
}) => {
  await page.goto('/');
  const editor = first(page);
  await editor.getByRole('textbox', { name: 'welcome.ts editor', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+p');
  const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
  await goTo.getByRole('combobox').fill('.ts');
  const rows = goTo.getByRole('option');
  await expect(rows.nth(1)).toBeVisible();
  // An agent or a build writes to the checkout faster than a search answers, as it can while
  // an agent works in a worktree of the project.
  await page.evaluate(() => {
    const write = () =>
      window.demo.memory.externalWrite(
        { checkout: window.demo.checkout, path: 'README.md' },
        `# Written at ${performance.now()}\n`,
      );
    Object.assign(window, { storm: setInterval(write, 30) });
  });
  try {
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    const highlighted = (await rows.nth(1).getAttribute('aria-label'))!;
    expect(highlighted).not.toBe(await rows.first().getAttribute('aria-label'));
    await page.keyboard.press('Enter');
    await expect(goTo).toHaveCount(0);
    await expect(
      editor.getByRole('textbox', { name: `${highlighted} editor`, exact: true }),
    ).toBeFocused();
    // Enter right after typing still waits for that query, which the refreshes cannot hold off.
    await page.keyboard.press('ControlOrMeta+p');
    await goTo.getByRole('combobox').fill('example');
    await goTo.getByRole('combobox').press('Enter');
    await expect(goTo).toHaveCount(0);
    await expect(
      editor.getByRole('textbox', { name: 'src/example.ts editor', exact: true }),
    ).toBeFocused();
  } finally {
    await page.evaluate(() => clearInterval((window as unknown as { storm: number }).storm));
  }
});

test('a deferred Enter never opens a row in place of one the new results dropped', async ({
  page,
}) => {
  await page.goto('/');
  const editor = first(page);
  const files = editor.getByRole('button', { name: 'Files', exact: true });
  await editor.getByRole('button', { name: 'Changes', exact: true }).click();
  await editor.getByRole('textbox', { name: 'welcome.ts editor', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+p');
  const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
  const field = goTo.getByRole('combobox');
  const rows = goTo.getByRole('option');
  // 'file' names no file, only commands: Show Files first, then Refresh files.
  await field.fill('file');
  await expect(rows.first()).toHaveAccessibleName('Show Files');
  await expect(rows.nth(1)).toHaveAccessibleName('Refresh files');
  await field.fill('.ts');
  await expect(rows.nth(1)).toHaveAccessibleName('src/example.ts');
  // Until 'file' answers, the old file rows stay listed above its commands. The reader moves onto
  // one, src/example.ts, which the new results drop, and presses Enter.
  await field.fill('file');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(goTo).toHaveCount(0);
  // The top row ran (Show Files), not whatever took the second place (Refresh files).
  await expect(files).toHaveAttribute('aria-pressed', 'true');
});

test('shortcuts switch an open picker, and a failed open stays on screen', async ({ page }) => {
  await page.goto('/');
  await first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+p');
  await page.keyboard.press('Tab');
  const find = page.getByRole('dialog', { name: 'Find in files', exact: true });
  await expect(find).toBeVisible();
  // ⌘P after ⇥ returns to Go to; ⌘⇧P from there lists commands.
  await page.keyboard.press('ControlOrMeta+p');
  const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
  await expect(goTo).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+p');
  await expect(goTo.getByRole('combobox')).toHaveValue('>');
  await page.keyboard.press('ControlOrMeta+Shift+f');
  await expect(find).toBeVisible();
  await page.keyboard.press('Tab');
  await goTo.getByRole('combobox').fill('README');
  await expect(goTo.getByRole('option', { name: 'README.md', exact: true })).toBeVisible();
  await page.evaluate(() => window.demo.memory.failNext('readFile', 'Injected IO failure'));
  await page.keyboard.press('Enter');
  await expect(goTo.getByRole('status')).toContainText(/Injected IO failure|File unavailable/);
  await expect(goTo).toBeVisible();
});

test('Go to with > lists editor commands with their shortcuts and runs them', async ({ page }) => {
  await page.goto('/');
  await first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+Shift+p');
  const dialog = page.getByRole('dialog', { name: 'Go to', exact: true });
  await expect(dialog.getByRole('combobox')).toHaveValue('>');
  await expect(dialog.getByRole('option', { name: 'Show Changes', exact: true })).toContainText(
    '⌘⇧G',
  );
  await dialog.getByRole('combobox').fill('>chang');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(first(page).getByRole('button', { name: /^Changes/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.keyboard.press('ControlOrMeta+Shift+p');
  await dialog.getByRole('combobox').fill('>nothing like this');
  await expect(dialog.getByRole('status')).toHaveText('No commands match.');
});

test("⇧⌘G stays the editor's Find Previous and switches to Changes from elsewhere", async ({
  page,
}) => {
  await page.goto('/');
  const editor = first(page);
  const files = editor.getByRole('button', { name: 'Files', exact: true });
  const changes = editor.getByRole('button', { name: 'Changes', exact: true });
  const input = editor.getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await input.focus();
  // Monaco takes the Mac keymap from the user agent, so its find keys use ⌘ on every platform.
  await input.press('Meta+f');
  const find = editor.getByRole('textbox', { name: 'Find', exact: true });
  await expect(find).toBeFocused();
  await find.fill('Moonbase');
  const count = editor.locator('.find-widget .matchesCount');
  await expect(count).toHaveText(/^1 of 2$/);
  await find.press('Meta+Shift+g');
  await expect(count).toHaveText(/^2 of 2$/);
  await expect(files).toHaveAttribute('aria-pressed', 'true');
  await find.press('Escape');
  // ⇧⌘E, which the editor leaves alone, works from inside it.
  await changes.click();
  await input.focus();
  await input.press('Meta+Shift+e');
  await expect(files).toHaveAttribute('aria-pressed', 'true');
  await editor.getByRole('tree', { name: 'Files', exact: true }).press('Meta+Shift+g');
  await expect(changes).toHaveAttribute('aria-pressed', 'true');
});

test("only the platform's command key opens the picker from the editor", async ({ page }) => {
  await page.goto('/');
  const input = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await input.focus();
  // ⌃P is the previous line in macOS text; off a Mac, ⊞/Super is not the command key.
  const other = process.platform === 'darwin' ? 'Control' : 'Meta';
  for (const keys of [`${other}+p`, `${other}+Shift+p`, `${other}+Shift+f`]) {
    await input.press(keys);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await input.press('ControlOrMeta+p');
  await expect(page.getByRole('dialog', { name: 'Go to', exact: true })).toBeVisible();
});

test('real close-checkout removes its Monaco models without a teardown exception', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeVisible();
  const before = await page.evaluate(() => window.demo.modelCount());
  await page.evaluate(() => window.demo.first.closeCheckout(window.demo.checkout));
  await expect(
    first(page).getByText(
      'Open a checkout to browse files and edit. Unsaved changes belong to this editor instance.',
    ),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.demo.modelCount())).toBe(before - 1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/editor-checkout-closed.png', fullPage: true });
});

test('rejected unchanged Rename leaves explicit Save and Close usable', async ({ page }) => {
  await page.goto('/');
  await first(page).getByRole('treeitem', { name: 'welcome.ts, modified', exact: true }).click();
  await first(page).getByRole('tree', { name: 'Files', exact: true }).press('ContextMenu');
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByRole('button', { name: 'Replace captured destination', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert').last()).toContainText(
    'Cannot transfer an entry into itself',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await edit(page, 'export const afterRejection = true;');
  await saveFile(first(page));
  await expect(first(page).getByText('welcome.ts · Unsaved', { exact: true })).toHaveCount(0);
  await first(page).getByRole('button', { name: 'Close welcome.ts', exact: true }).click();
  await expect(first(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toHaveCount(0);
});

test('close-all/reopen/close-active loads the surviving file instead of an unavailable placeholder', async ({
  page,
}) => {
  await page.goto('/');
  await first(page).getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  await openTabMenu(first(page));
  await page.getByRole('menuitem', { name: 'Close All', exact: true }).click();
  await expect(first(page).getByRole('tab', { name: 'README.md', exact: true })).toHaveCount(0);
  await first(page).getByLabel('Moonbase editor', { exact: true }).press('Meta+Shift+t');
  await expect(
    first(page).getByRole('textbox', { name: 'README.md editor', exact: true }),
  ).toBeVisible();
  await first(page).getByRole('button', { name: 'Close README.md', exact: true }).click();
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeVisible();
});

for (const via of ['button', 'keyboard', 'menu'] as const)
  test(`closing via ${via} loads the supplied checkout's survivor when another checkout is selected`, async ({
    page,
  }) => {
    await page.goto('/');
    await first(page).getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
    await openTabMenu(first(page));
    await page.getByRole('menuitem', { name: 'Close All', exact: true }).click();
    await expect(first(page).getByRole('tab')).toHaveCount(0);
    await first(page).getByLabel('Moonbase editor', { exact: true }).press('Meta+Shift+t');
    await expect(
      first(page).getByRole('textbox', { name: 'README.md editor', exact: true }),
    ).toBeVisible();
    await page.evaluate(() => window.demo.first.openCheckout('/demo/other'));
    expect(
      await page.evaluate(() => window.demo.first.getSnapshot().recovery.selectedCheckoutId),
    ).toBe('other');
    expect(
      await page.evaluate(() =>
        window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' }),
      ),
    ).toBeUndefined();
    if (via === 'button')
      await first(page).getByRole('button', { name: 'Close README.md', exact: true }).click();
    else if (via === 'keyboard') {
      await first(page).getByRole('textbox', { name: 'README.md editor', exact: true }).focus();
      await page.keyboard.press('Meta+w');
    } else {
      await openTabMenu(first(page));
      await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
    }
    const survivor = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
    await expect(survivor).toBeVisible();
    if (via === 'keyboard') await expect(survivor).toBeFocused();
    await expect(first(page).getByRole('button', { name: 'Retry file', exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({ path: `test-results/editor-project-close-${via}.png`, fullPage: true });
  });

for (const navigation of ['visual', 'recent'] as const)
  test(`${navigation} keyboard navigation restores typing focus and keeps tab-strip focus`, async ({
    page,
  }) => {
    await page.goto('/');
    await first(page).getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
    await first(page).getByRole('tab', { name: 'welcome.ts', exact: true }).click();
    const editor = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
    await editor.focus();
    async function navigate() {
      if (navigation === 'visual') await page.keyboard.press('Meta+Alt+ArrowRight');
      else {
        await page.keyboard.down('Control');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Control');
      }
    }
    await navigate();
    await expect(
      first(page).getByRole('textbox', { name: 'README.md editor', exact: true }),
    ).toBeFocused();
    await page.keyboard.type('typed after ' + navigation);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.demo.first.buffer({ checkout: window.demo.checkout, path: 'README.md' })!.text,
        ),
      )
      .toContain('typed after ' + navigation);
    if (navigation === 'visual')
      await page.screenshot({ path: 'test-results/editor-keyboard-typing.png', fullPage: true });
    await first(page).getByRole('tab', { name: 'README.md', exact: true }).focus();
    await navigate();
    await expect(first(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toBeFocused();
  });

test('a checkout clicked during close publication remains selected live and durably', async ({
  page,
}) => {
  await page.goto('/recovery-race.html');
  await expect(page.getByRole('textbox', { name: 'b.ts editor', exact: true })).toBeVisible();
  await page.evaluate(() => window.recoveryRace.hold());
  await page.getByRole('button', { name: 'Close b.ts', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.recoveryRace.waiting)).toBe(true);
  await page.getByRole('tab', { name: 'beta · main', exact: true }).click();
  await page.evaluate(() => window.recoveryRace.release());
  await expect
    .poll(() => page.evaluate(() => window.recoveryRace.editor.getSnapshot().preserving))
    .toBe(false);
  expect(
    await page.evaluate(() => window.recoveryRace.editor.getSnapshot().recovery.selectedCheckoutId),
  ).toBe('beta');
  expect(
    await page.evaluate(async () => (await window.recoveryRace.load()).state.selectedCheckoutId),
  ).toBe('beta');
  await expect(page.getByRole('textbox', { name: 'a.ts editor', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/editor-close-selection.png', fullPage: true });
});

for (const shortcut of ['close', 'reopen'] as const)
  test(`keyboard ${shortcut} hands off typing focus`, async ({ page }) => {
    await page.goto('/');
    await first(page).getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
    if (shortcut === 'reopen')
      await first(page).getByRole('button', { name: 'Close README.md', exact: true }).click();
    const previous = shortcut === 'close' ? 'README.md' : 'welcome.ts',
      next = shortcut === 'close' ? 'welcome.ts' : 'README.md';
    await first(page)
      .getByRole('textbox', { name: previous + ' editor', exact: true })
      .focus();
    await page.keyboard.press(shortcut === 'close' ? 'Meta+w' : 'Meta+Shift+t');
    await expect(
      first(page).getByRole('textbox', { name: next + ' editor', exact: true }),
    ).toBeFocused();
    await page.keyboard.type('typed after ' + shortcut);
    await expect
      .poll(() =>
        page.evaluate(
          (path) => window.demo.first.buffer({ checkout: window.demo.checkout, path })!.text,
          next,
        ),
      )
      .toContain('typed after ' + shortcut);
    await page.screenshot({ path: `test-results/editor-keyboard-${shortcut}.png`, fullPage: true });
  });

test('keyboard close cancellation and failed publication preserve typing focus and dialog scope', async ({
  page,
}) => {
  await page.goto('/');
  await edit(page, 'dirty retained ');
  await page.keyboard.press('Meta+w');
  const dialog = page.getByRole('dialog', { name: 'Save changes before closing?', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Meta+Shift+t');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeFocused();
  await page.keyboard.type('after cancel ');
  // Let Close consume the fault instead of the draft's debounced publication.
  await page.evaluate(() => window.demo.first.flush());
  await page.getByRole('button', { name: 'Fail next recovery', exact: true }).click();
  await first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }).focus();
  await page.keyboard.press('Meta+w');
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeFocused();
  await page.keyboard.type('after failed close ');
  expect(
    await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    ),
  ).toContain('after failed close');
});

test('Tab traversal within the preservation prompt keeps its survivor focus', async ({ page }) => {
  await page.goto('/');
  await first(page).getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const input = first(page).getByRole('textbox', { name: 'README.md editor', exact: true });
  await input.focus();
  await input.press('Meta+a');
  await input.pressSequentially('dirty readme ');
  await page.keyboard.press('Meta+w');
  const dialog = page.getByRole('dialog', { name: 'Save changes before closing?', exact: true });
  await dialog.getByRole('button', { name: 'Save', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Discard', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeFocused();
  await page.keyboard.type('after tab discard ');
  expect(
    await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    ),
  ).toContain('after tab discard');
});

test('keyboard close/reopen retains tree or strip origin and meaningful empty-editor focus', async ({
  page,
}) => {
  await page.goto('/');
  await first(page).getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  for (const origin of ['strip', 'tree'] as const) {
    const focused =
      origin === 'strip'
        ? first(page).getByRole('tab', { name: 'README.md', exact: true })
        : first(page).getByRole('tree', { name: 'Files', exact: true });
    await focused.focus();
    await page.keyboard.press('Meta+w');
    await expect(
      origin === 'strip'
        ? first(page).getByRole('tab', { name: 'welcome.ts', exact: true })
        : focused,
    ).toBeFocused();
    await page.keyboard.press('Meta+Shift+t');
    await expect(focused).toBeFocused();
  }
  await first(page).getByRole('textbox', { name: 'README.md editor', exact: true }).focus();
  await page.keyboard.press('Meta+w');
  await first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }).focus();
  await page.keyboard.press('Meta+w');
  await expect(
    first(page).getByRole('button', { name: 'Explorer actions', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Meta+Shift+t');
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Hide first editor', exact: true }).click();
  const before = await page.evaluate(() => window.demo.first.getSnapshot().recovery);
  await page.keyboard.press('Meta+Shift+t');
  expect(await page.evaluate(() => window.demo.first.getSnapshot().recovery)).toEqual(before);
});

test('returning to a background-closed checkout loads the survivor', async ({ page }) => {
  await page.goto('/recovery-race.html');
  await expect(page.getByRole('textbox', { name: 'b.ts editor', exact: true })).toBeVisible();
  await page.evaluate(() => window.recoveryRace.hold());
  await page.getByRole('button', { name: 'Close b.ts', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.recoveryRace.waiting)).toBe(true);
  await page.getByRole('tab', { name: 'beta · main', exact: true }).click();
  await page.evaluate(() => window.recoveryRace.release());
  await expect
    .poll(() => page.evaluate(() => window.recoveryRace.editor.getSnapshot().preserving))
    .toBe(false);
  await page.getByRole('tab', { name: 'alpha · main', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'a.ts editor', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/editor-background-return.png', fullPage: true });
});

for (const area of ['staged', 'unstaged'] as const)
  test(`actual typing after close into remembered ${area} comparison`, async ({ page }) => {
    await page.goto('/');
    await selectFileView(first(page), area);
    await first(page).getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
    await first(page).getByRole('textbox', { name: 'README.md editor', exact: true }).focus();
    await page.keyboard.press('Meta+w');
    const input = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
    await expect(input).toBeFocused();
    await page.keyboard.type('typing into ' + area + ' survivor ');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
        ),
      )
      .toContain('typing into ' + area + ' survivor');
    const original = first(page).getByRole('textbox', {
      name: area + ' · welcome.ts original',
      exact: true,
    });
    await expect(original).toHaveJSProperty('readOnly', true);
    await expect(input).toHaveJSProperty('readOnly', false);
    await page.screenshot({ path: `test-results/editor-${area}-close.png`, fullPage: true });
  });

test('uncertain final close is visible, blocks Quit and resolves by exact receipt before focusing its survivor', async ({
  page,
}) => {
  await page.goto('/recovery-race.html');
  await expect(page.getByRole('textbox', { name: 'b.ts editor', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const editor = window.recoveryRace.editor,
      checkout = editor
        .getSnapshot()
        .recovery.checkouts.find((target) => target.checkoutId === 'alpha')!;
    editor.edit({ checkout, path: 'b.ts' }, 'captured pending close draft');
    await editor.flush();
    window.recoveryRace.loseFinalResponse();
  });
  await page.getByRole('textbox', { name: 'b.ts editor', exact: true }).focus();
  await page.keyboard.press('Meta+w');
  await page
    .getByRole('dialog', { name: 'Save changes before closing?', exact: true })
    .getByRole('button', { name: 'Discard', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.recoveryRace.editor.prepareQuit())).toBe(false);
  expect(
    await page.evaluate(
      () =>
        window.recoveryRace.editor
          .getSnapshot()
          .buffers.find((buffer) => buffer.target.path === 'b.ts')?.text,
    ),
  ).toBe('captured pending close draft');
  await page.screenshot({ path: 'test-results/editor-pending-publication.png', fullPage: true });
  await page.getByRole('button', { name: 'Resolve recovery publication', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'a.ts editor', exact: true })).toBeFocused();
  await page.keyboard.type('after exact close resolution ');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.recoveryRace.editor
            .getSnapshot()
            .buffers.find(
              (buffer) =>
                buffer.target.checkout.checkoutId === 'alpha' && buffer.target.path === 'a.ts',
            )?.text,
      ),
    )
    .toContain('after exact close resolution');
  await expect(
    page.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
  ).toHaveCount(0);
});

test('selecting an absent survivor during another close loads it after preservation releases', async ({
  page,
}) => {
  await page.goto('/recovery-race.html?both');
  await expect(page.getByRole('textbox', { name: 'b.ts editor', exact: true })).toBeVisible();
  for (const next of ['beta', 'alpha']) {
    await page.evaluate(() => window.recoveryRace.hold());
    await page.getByRole('button', { name: 'Close b.ts', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.recoveryRace.waiting)).toBe(true);
    await page.getByRole('tab', { name: next + ' · main', exact: true }).click();
    await page.evaluate(() => window.recoveryRace.release());
    await expect
      .poll(() => page.evaluate(() => window.recoveryRace.editor.getSnapshot().preserving))
      .toBe(false);
  }
  const input = page.getByRole('textbox', { name: 'a.ts editor', exact: true });
  await expect(input).toBeVisible();
  await input.focus();
  await page.keyboard.type('after deferred selection ');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.recoveryRace.editor
            .getSnapshot()
            .buffers.find(
              (buffer) =>
                buffer.target.checkout.checkoutId === 'alpha' && buffer.target.path === 'a.ts',
            )?.text,
      ),
    )
    .toContain('after deferred selection');
  await page.screenshot({ path: 'test-results/editor-preservation-selection.png', fullPage: true });
});

test('delayed public Copy cannot reopen a destination closed through Monaco UI', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/recovery-race.html');
  await page.getByRole('treeitem', { name: 'a.ts', exact: true }).dblclick();
  await page.evaluate(() => window.recoveryRace.copy.start());
  await expect.poll(() => page.evaluate(() => window.recoveryRace.copy.phase)).toBe('preflight');
  await page.evaluate(() => {
    const editor = window.recoveryRace.editor,
      checkout = editor
        .getSnapshot()
        .recovery.checkouts.find((target) => target.checkoutId === 'alpha')!;
    editor.edit({ checkout, path: 'a.ts' }, 'source changed after preflight');
    window.recoveryRace.copy.releasePreflight();
  });
  await expect.poll(() => page.evaluate(() => window.recoveryRace.copy.phase)).toBe('read');
  await page.getByRole('treeitem', { name: 'copy.ts, untracked', exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'copy.ts editor', exact: true }).focus();
  await page.keyboard.type('destination discarded ');
  await page.getByRole('button', { name: 'Close copy.ts', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Save changes before closing?', exact: true })
    .getByRole('button', { name: 'Discard', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: 'copy.ts', exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    window.recoveryRace.copy.releaseRead();
    await window.recoveryRace.copy.finish();
    await window.recoveryRace.editor.reconcileRecovery();
  });
  await expect(page.getByRole('tab', { name: 'copy.ts', exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(async () =>
      (await window.recoveryRace.load()).state.drafts.some(
        (draft) => draft.target.path === 'copy.ts',
      ),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(async () => (await window.recoveryRace.load()).operations.length),
  ).toBe(0);
  await page.screenshot({ path: 'test-results/editor-copy-closed.png', fullPage: true });
  expect(errors).toEqual([]);
});

for (const area of ['staged', 'unstaged'] as const)
  test(`restored dirty ${area} survivor shows its original and accepts typing`, async ({
    page,
  }) => {
    await page.goto('/recovery-race.html?dirty=' + area);
    await page.getByRole('textbox', { name: 'b.ts editor', exact: true }).focus();
    await page.keyboard.press('Meta+w');
    const original = page.getByRole('textbox', { name: area + ' · a.ts original', exact: true }),
      modified = page.getByRole('textbox', { name: 'a.ts editor', exact: true });
    await expect(original).toBeVisible();
    await expect(original).toHaveJSProperty('readOnly', true);
    await expect(modified).toBeFocused();
    await expect(modified).toHaveJSProperty('readOnly', false);
    await page.keyboard.type('typed dirty ' + area + ' ');
    const state = await page.evaluate(() => window.recoveryRace.editor.getSnapshot());
    expect(
      state.buffers.find(
        (buffer) => buffer.target.checkout.checkoutId === 'alpha' && buffer.target.path === 'a.ts',
      )?.text,
    ).toContain('restored dirty A');
    expect(
      state.buffers.find(
        (buffer) => buffer.target.checkout.checkoutId === 'alpha' && buffer.target.path === 'a.ts',
      )?.text,
    ).toContain('typed dirty ' + area);
    expect(
      Object.values(state.comparisons).some(
        (comparison) => comparison.original === (area === 'staged' ? 'HEAD A' : 'INDEX A'),
      ),
    ).toBe(true);
    await expect(
      page
        .locator('.monaco-diff-editor .line-delete-selectable .view-line')
        .filter({ hasText: area === 'staged' ? /HEAD\s+A/ : /INDEX\s+A/ })
        .first(),
    ).toBeVisible();
    await page.screenshot({ path: `test-results/editor-restored-${area}.png`, fullPage: true });
  });

for (const area of ['staged', 'unstaged'] as const)
  test(`recreated ${area} working file becomes editable with Save enabled`, async ({ page }) => {
    await page.goto('/recovery-race.html?missing=' + area);
    const original = page.getByRole('textbox', { name: area + ' · a.ts original', exact: true }),
      modified = page.getByRole('textbox', { name: 'a.ts editor', exact: true });
    await expect(original).toHaveJSProperty('readOnly', true);
    await expect(modified).toBeVisible();
    await expectSaveEnabled(page, false);
    await page.getByRole('tab', { name: 'beta · main', exact: true }).click();
    await page.evaluate(() => window.recoveryRace.recreateWorking());
    await page.getByRole('tab', { name: 'alpha · main', exact: true }).click();
    await explorerAction(page, 'Refresh');
    await expectSaveEnabled(page, true);
    await expect(original).toHaveJSProperty('readOnly', true);
    await expect(modified).toHaveJSProperty('readOnly', false);
    await modified.focus();
    await page.keyboard.type('typed after recreation ' + area + ' ');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.recoveryRace.editor
              .getSnapshot()
              .buffers.find(
                (buffer) =>
                  buffer.target.checkout.checkoutId === 'alpha' && buffer.target.path === 'a.ts',
              )?.text,
        ),
      )
      .toContain('typed after recreation ' + area);
    await saveFile(page);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.recoveryRace.editor
              .getSnapshot()
              .buffers.find(
                (buffer) =>
                  buffer.target.checkout.checkoutId === 'alpha' && buffer.target.path === 'a.ts',
              )?.disk.text,
        ),
      )
      .toContain('typed after recreation ' + area);
    await expect(
      page
        .locator('.monaco-diff-editor .line-delete-selectable .view-line')
        .filter({ hasText: area === 'staged' ? /HEAD\s+A/ : /INDEX\s+A/ })
        .first(),
    ).toBeVisible();
    await page.screenshot({ path: `test-results/editor-recreated-${area}.png`, fullPage: true });
  });

test('lost and reordered Save receipts keep Retry Save visible until exact recovery settles', async ({
  page,
}) => {
  await page.goto('/');
  await edit(page, 'captured welcome');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.open({ checkout, path: 'README.md' }, { intent: 'keep' });
    first.edit({ checkout, path: 'README.md' }, 'captured README');
    await first.open({ checkout, path: 'welcome.ts' });
    await first.flush();
  });
  await page.evaluate(() =>
    window.demo.memory.failNext('saveFile', 'Lost committed Save reply', true),
  );
  await saveFile(first(page));
  await expect(first(page).getByRole('button', { name: 'Retry Save', exact: true })).toBeVisible();
  const pendingA = await page.evaluate(
    () =>
      window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!
        .pendingSave!,
  );
  await edit(page, 'newer welcome');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.open({ checkout, path: 'README.md' }, { intent: 'keep' });
    first.edit({ checkout, path: 'README.md' }, 'captured README');
  });
  await saveFile(first(page));
  await expect
    .poll(() =>
      page.evaluate(() => {
        const buffer = window.demo.first.buffer({
          checkout: window.demo.checkout,
          path: 'README.md',
        });
        return !!buffer?.pendingSave && !buffer.saving;
      }),
    )
    .toBe(true);
  const pendingB = await page.evaluate(
    () =>
      window.demo.first.buffer({ checkout: window.demo.checkout, path: 'README.md' })!.pendingSave!,
  );
  // A legitimate background flush may replace the alert; pending identities and controls stay stable.
  await page.evaluate(() => window.demo.first.flush().catch(window.demo.first.report));
  expect(
    await page.evaluate(
      () =>
        window.demo.first.buffer({ checkout: window.demo.checkout, path: 'README.md' })!
          .pendingSave,
    ),
  ).toEqual(pendingB);
  expect(
    await page.evaluate(
      () =>
        window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!
          .pendingSave,
    ),
  ).toEqual(pendingA);
  await expect(first(page).getByRole('button', { name: 'Retry Save', exact: true })).toBeVisible();
  const readme = first(page).getByRole('textbox', { name: 'README.md editor', exact: true });
  await readme.focus();
  await readme.press('Meta+a');
  await readme.pressSequentially('newer README');
  await first(page).getByRole('tab', { name: 'welcome.ts', exact: true }).click();
  await first(page).getByRole('button', { name: 'Retry Save', exact: true }).click();
  await expect(first(page).getByRole('button', { name: 'Retry Save', exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        window.demo.first.buffer({ checkout: window.demo.checkout, path: 'README.md' })!
          .pendingSave,
    ),
  ).toBeUndefined();
  expect(pendingB.target.path).toBe('README.md');
  await page.evaluate(() => window.demo.first.flush());
  expect(
    await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })?.text,
    ),
  ).toBe('newer welcome');
  expect(
    await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'README.md' })?.text,
    ),
  ).toBe('newer README');
  await first(page).getByRole('tab', { name: 'README.md', exact: true }).click();
  await expect(first(page).getByRole('button', { name: 'Retry Save', exact: true })).toHaveCount(0);
  await readme.focus();
  await readme.press('End');
  await readme.pressSequentially(' typed after reconciliation');
  expect(await page.evaluate(() => window.demo.memory.stats.saves)).toBe(2);
  for (const dismiss of await first(page)
    .getByRole('button', { name: 'Dismiss error', exact: true })
    .all())
    await dismiss.click();
  await page.screenshot({ path: 'test-results/save-receipts.png', fullPage: true });
});

test('Resolve recovers a rejected metadata publication after an already-started Save', async ({
  page,
}) => {
  await page.goto('/save-race.html');
  const input = page.getByRole('textbox', { name: 'a.ts editor', exact: true });
  await expect(input).toBeVisible();
  await page.evaluate(() => window.saveRace.startB());
  await page.evaluate(() =>
    window.saveRace.memory.failNext(
      'persistRecovery',
      'Controlled before-commit publication failure',
    ),
  );
  await saveFile(page);
  await expect(
    page.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.saveRace.releaseB());
  await input.focus();
  await input.press('Meta+a');
  await input.pressSequentially('NEWER A');
  await page.getByRole('tab', { name: 'b.ts', exact: true }).click();
  const b = page.getByRole('textbox', { name: 'b.ts editor', exact: true });
  await b.focus();
  await b.press('Meta+a');
  await b.pressSequentially('NEWER B');
  const ids = await page.evaluate(() =>
    window.saveRace.editor.getSnapshot().buffers.map((buffer) => buffer.pendingSave!.requestId),
  );
  await page.getByRole('button', { name: 'Resolve recovery publication', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Resolve recovery publication', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    await window.saveRace.editor.reconcileRecovery();
    await window.saveRace.editor.flush();
  });
  expect(await page.evaluate(() => window.saveRace.memory.stats.saves)).toBe(2);
  expect(
    await page.evaluate(() => window.saveRace.requests.map((request) => request.requestId).sort()),
  ).toEqual(ids.sort());
  await page.evaluate(() => window.saveRace.restart());
  await expect(b).toBeVisible();
  await expectSaveEnabled(page, true);
  expect(
    await page.evaluate(() =>
      window.saveRace.editor
        .getSnapshot()
        .buffers.map((buffer) => [buffer.target.path, buffer.text, buffer.disk.text])
        .sort(),
    ),
  ).toEqual([
    ['a.ts', 'NEWER A', 'CAPTURE a.ts'],
    ['b.ts', 'NEWER B', 'CAPTURE b.ts'],
  ]);
  await b.focus();
  await b.press('End');
  await b.pressSequentially(' typed after resolution');
  await saveFile(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.saveRace.editor.buffer({ checkout: window.saveRace.checkout, path: 'b.ts' })?.disk
            .text,
      ),
    )
    .toBe('NEWER B typed after resolution');
  await page.screenshot({ path: 'test-results/publication-rejoined.png', fullPage: true });
});

test('valid prototype-shaped filenames edit and save without changing browser prototypes', async ({
  page,
}) => {
  await page.goto('/');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    for (const path of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      await page.evaluate(
        (path) =>
          window.demo.first.mutate({
            checkout: window.demo.checkout,
            kind: 'create-file',
            sources: [],
            destination: path,
            text: 'baseline ' + path,
          }),
        path,
      );
      await first(page)
        .getByRole('treeitem', { name: path + ', untracked', exact: true })
        .dblclick();
      const input = first(page).getByRole('textbox', { name: path + ' editor', exact: true });
      await expect(input).toBeVisible();
      await input.focus();
      await input.press('ArrowRight');
      expect(await page.evaluate(() => Object.hasOwn(Object.prototype, 'file'))).toBe(false);
      await input.press('Meta+a');
      await input.pressSequentially('saved ' + path);
      await saveFile(first(page));
      await expect
        .poll(() =>
          page.evaluate(
            async (path) =>
              (
                await window.demo.client.command('readFile', {
                  checkout: window.demo.checkout,
                  path,
                })
              ).text,
            path,
          ),
        )
        .toBe('saved ' + path);
    }
    expect(errors).toEqual([]);
  } finally {
    await page
      .evaluate(() => {
        delete (Object.prototype as { file?: unknown }).file;
      })
      .catch(() => {});
  }
});

for (const viewport of [
  { width: 1600, height: 1000 },
  { width: 760, height: 650 },
  { width: 543, height: 441 },
])
  test(`Tab actions first/last keyboard selection and Close click fit ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.evaluate(async () => {
      const { first, checkout } = window.demo;
      await first.open({ checkout, path: 'README.md' }, { intent: 'keep' });
      await first.close([{ checkout, path: 'README.md' }]);
      await first.open({ checkout, path: 'src/example.ts' }, { intent: 'preview' });
    });
    const trigger = first(page)
      .getByRole('tablist', { name: 'Open files', exact: true })
      .getByRole('tab', { selected: true });
    await trigger.focus();
    await trigger.press('Shift+F10');
    const menu = page.getByRole('menu'),
      firstItem = page.getByRole('menuitem', { name: 'Keep Open', exact: true }),
      lastItem = page.getByRole('menuitem', { name: 'Reopen Closed Files', exact: true });
    const within = async (item: ReturnType<Page['getByRole']>) =>
      item.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      });
    await expect(firstItem).toBeFocused();
    await page.keyboard.press('Home');
    await expect(firstItem).toBeFocused();
    expect(await within(firstItem)).toBe(true);
    await page.screenshot({
      path: `test-results/tab-menu-first-${viewport.width}.png`,
      fullPage: true,
    });
    await page.keyboard.press('End');
    await expect(lastItem).toBeFocused();
    expect(await within(lastItem)).toBe(true);
    await page.screenshot({ path: `test-results/tab-menu-${viewport.width}.png`, fullPage: true });
    await page.keyboard.press('Enter');
    await expect(first(page).getByRole('tab', { name: 'README.md', exact: true })).toBeVisible();
    await trigger.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await expect(first(page).getByRole('tab', { name: 'README.md', exact: true })).toHaveCount(0);
    await expect(menu).toHaveCount(0);
  });

test('delayed Create reply after disposal does not open the created file', async ({ page }) => {
  await page.goto('/');
  const second = page.getByRole('region', { name: 'Second editor', exact: true });
  await expect(second.getByRole('tab', { name: 'welcome.ts', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const editor = window.demo.second,
      mutate = editor.mutate.bind(editor);
    editor.mutate = async (input) => {
      const result = await mutate(input);
      await new Promise<void>((resolve) => {
        window.addEventListener('release-create', () => resolve(), { once: true });
        document.body.dataset.createReply = 'waiting';
      });
      return result;
    };
    editor.open = async () => {
      document.body.dataset.detachedCreateOpen = 'true';
      return false;
    };
  });
  await explorerAction(second, 'New File…');
  await page.getByRole('textbox', { name: 'Destination relative path' }).fill('delayed.ts');
  await page
    .getByRole('dialog', { name: 'New File', exact: true })
    .getByRole('button', { name: 'New File', exact: true })
    .click();
  await expect(page.locator('body')).toHaveAttribute('data-create-reply', 'waiting');
  // Simulate shell teardown while the modal owns focus.
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent === 'Dispose second editor')!
      .click(),
  );
  await expect(second).toHaveCount(0);
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('release-create'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(await page.locator('body').getAttribute('data-detached-create-open')).toBeNull();
  expect(
    await page.evaluate(
      async () =>
        (
          await window.demo.client.command('readFile', {
            checkout: window.demo.checkout,
            path: 'delayed.ts',
          })
        ).text,
    ),
  ).toBe('');
});

test('StrictMode lookup searches and opens a result after effect replay', async ({ page }) => {
  await page.goto('/?strict');
  await explorerAction(first(page), 'Go to File…');
  await page.getByRole('combobox').fill('README');
  await expect(page.getByRole('option', { name: 'README.md', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/strict-lookup.png', fullPage: true });
  await page.getByRole('combobox').press('Enter');
  await expect(page.getByRole('dialog', { name: 'Find file', exact: true })).toHaveCount(0);
  await expect(first(page).getByRole('tab', { name: 'README.md', exact: true })).toBeVisible();
});

test('Shift tree ranges extend and shrink from a stable anchor before Trash', async ({ page }) => {
  await page.goto('/');
  const tree = first(page).getByRole('tree', { name: 'Files', exact: true });
  await tree.focus();
  await tree.press('Home');
  const paths = await tree
    .getByRole('treeitem')
    .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  const selected = () =>
    tree
      .locator('[role="treeitem"][aria-selected="true"]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  await tree.press('Shift+ArrowDown');
  expect(await selected()).toEqual(paths.slice(0, 2));
  await tree.press('Shift+ArrowDown');
  expect(await selected()).toEqual(paths.slice(0, 3));
  await tree.press('Shift+ArrowUp');
  expect(await selected()).toEqual(paths.slice(0, 2));
  await tree.press('Shift+End');
  expect(await selected()).toEqual(paths);
  await tree.press('Shift+ArrowUp');
  expect(await selected()).toEqual(paths.slice(0, -1));
  await tree.press('Home');
  await tree.press('Shift+ArrowDown');
  expect(await selected()).toEqual(paths.slice(0, 2));
  await tree.press('ContextMenu');
  await page.getByRole('menuitem', { name: 'Move 2 Items to Trash', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Move to Trash', exact: true })).toContainText(
    paths.slice(0, 2).join(', '),
  );
  await page.screenshot({ path: 'test-results/tree-range-trash.png', fullPage: true });
  await page
    .getByRole('dialog', { name: 'Move to Trash', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await tree.press('Shift+ArrowDown');
  expect(await selected()).toEqual(paths.slice(2));
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.openCheckout('/demo/other');
    await first.selectCheckout(checkout);
  });
  await tree.focus();
  await tree.press('Shift+ArrowUp');
  expect(await selected()).toEqual(paths.slice(2, 3));
  await tree.press('ArrowUp');
  await tree.press('Shift+ArrowDown');
  expect(await selected()).toEqual(paths.slice(1, 3));
});

test('Reveal starts a new Shift tree range and captures only that Trash batch', async ({
  page,
}) => {
  await page.goto('/');
  const tree = first(page).getByRole('tree', { name: 'Files', exact: true });
  const selected = () =>
    tree
      .locator('[role="treeitem"][aria-selected="true"]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  await tree.focus();
  await tree.press('Home');
  await tree.press('Shift+ArrowDown');
  await explorerAction(first(page), 'Reveal Active File');
  await expect.poll(selected).toEqual(['welcome.ts, modified']);
  await tree.focus();
  await tree.press('Shift+ArrowUp');
  expect(await selected()).toEqual(['README.md', 'welcome.ts, modified']);
  await tree.press('Shift+ArrowDown');
  expect(await selected()).toEqual(['welcome.ts, modified']);
  await tree.press('Shift+ArrowUp');
  expect(await selected()).toEqual(['README.md', 'welcome.ts, modified']);
  await tree.press('ContextMenu');
  await page.getByRole('menuitem', { name: 'Move 2 Items to Trash', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to Trash', exact: true });
  await expect(dialog).toContainText('README.md, welcome.ts');
  await expect(dialog).not.toContainText('ignored.txt');
  await expect(dialog).not.toContainText('src');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await tree.focus();
  await tree.press('Shift+ArrowDown');
  expect(await selected()).toEqual(['welcome.ts, modified']);
  await tree.press('Shift+ArrowUp');
  expect(await selected()).toEqual(['README.md', 'welcome.ts, modified']);
});

test('workbench renders its supplied checkout independently of application navigation', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await window.demo.first.openCheckout('/demo/other');
  });
  expect(
    await page.evaluate(() => window.demo.first.getSnapshot().recovery.selectedCheckoutId),
  ).toBe('other');
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeVisible();
  await expect(
    first(page).getByRole('treeitem', { name: 'elsewhere.ts', exact: true }),
  ).toHaveCount(0);
  await expect(
    first(page).getByRole('tablist', { name: 'Workbench views', exact: true }),
  ).toHaveCount(0);
  await expect(first(page).getByRole('tab', { name: 'Chat', exact: true })).toHaveCount(0);
  await explorerAction(first(page), 'Go to File…');
  await page.getByRole('combobox').fill('elsewhere');
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('No results.');
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(page.getByLabel('All open checkouts', { exact: true })).toHaveCount(0);
});

test('editor remains usable when the app omits the explorer from its layout', async ({ page }) => {
  await page.goto('/?editor-only');
  const input = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await expect(input).toBeVisible();
  await expect(first(page).getByRole('tree', { name: 'Files', exact: true })).toHaveCount(0);
  await expect(
    first(page).getByRole('complementary', { name: 'Editor sidebar', exact: true }),
  ).toHaveCount(0);
  await input.focus();
  await input.press('Meta+a');
  await input.pressSequentially('editor without explorer');
  await input.press('Meta+s');
  await expect.poll(() => page.evaluate(() => window.demo.memory.stats.saves)).toBe(1);
  await input.press('ControlOrMeta+p');
  await page.getByRole('combobox').fill('README');
  await page.getByRole('option', { name: 'README.md', exact: true }).click();
  await expect(
    first(page).getByRole('textbox', { name: 'README.md editor', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Meta+w');
  await expect(input).toBeFocused();
  await page.keyboard.press('Meta+w');
  await expect(first(page).locator('[aria-label="Moonbase editor"]')).toBeFocused();
  await page.keyboard.press('Meta+Shift+t');
  await expect(input).toBeFocused();
});

test("the explorer's … menu holds its file actions and collapses every folder", async ({
  page,
}) => {
  await page.goto('/');
  const folder = first(page)
    .getByRole('tree', { name: 'Files', exact: true })
    .getByRole('treeitem', { name: 'src', exact: true });
  await folder.focus();
  await folder.press('ArrowRight');
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await first(page).getByRole('button', { name: 'Explorer actions', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Explorer actions', exact: true });
  for (const name of [
    'New File…',
    'New Folder…',
    'Import Files…',
    'Collapse All Folders',
    'Reveal Active File',
    'Go to File…',
    'Refresh',
  ])
    await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Collapse All Folders', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
});

test('with no file open, the editor lists its main shortcuts', async ({ page }) => {
  await page.goto('/');
  const tabs = first(page).getByRole('tablist', { name: 'Open files', exact: true });
  await expect(tabs.getByRole('tab').first()).toBeVisible();
  while (await tabs.getByRole('tab').count()) {
    await tabs.getByRole('tab').first().focus();
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(250);
  }
  const sheet = first(page).getByRole('region', { name: 'Keyboard shortcuts', exact: true });
  await expect(sheet.getByRole('term')).toHaveText(['Go to file', 'Commands', 'Find in files']);
  await expect(sheet.getByRole('definition')).toHaveText(
    process.platform === 'darwin'
      ? ['⌘P', '⇧⌘P', '⇧⌘F']
      : ['Ctrl+P', 'Shift+Ctrl+P', 'Shift+Ctrl+F'],
  );
  await page.keyboard.press('Meta+Shift+t');
  await expect(sheet).toHaveCount(0);
});

test('a hidden sidebar slides the explorer away and leaves the editor usable', async ({ page }) => {
  await page.goto('/?sidebar-hidden');
  const sidebar = first(page).locator('aside[aria-label="Editor sidebar"]');
  await expect
    .poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
    .toBe(0);
  expect(await sidebar.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  const input = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await input.focus();
  await input.pressSequentially('with the sidebar hidden ');
  await input.press('Meta+s');
  await expect.poll(() => page.evaluate(() => window.demo.memory.stats.saves)).toBe(1);
});

test('commands that need the hidden explorer ask the app to show it', async ({ page }) => {
  // Three fresh pages, each with the explorer hidden.
  test.slow();
  const sidebar = first(page).locator('aside[aria-label="Editor sidebar"]');
  const shown = async () => {
    await expect
      .poll(() => sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)))
      .toBeGreaterThan(100);
    expect(await sidebar.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  };
  const input = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  const command = async (name: string) => {
    await input.focus();
    await page.keyboard.press('ControlOrMeta+Shift+p');
    const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
    await goTo.getByRole('combobox').fill('>' + name);
    await goTo.getByRole('option', { name, exact: true }).click();
    await expect(goTo).toHaveCount(0);
  };
  await page.goto('/?sidebar-hidden');
  await input.focus();
  await input.press('Meta+Shift+e');
  await shown();
  await page.goto('/?sidebar-hidden');
  await command('Show Changes');
  await shown();
  await expect(first(page).getByRole('button', { name: 'Changes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Reveal Active File shows the file tree, from Changes too.
  await command('Reveal Active File');
  await expect(first(page).getByRole('button', { name: 'Files', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const active = first(page).getByRole('treeitem', { name: 'welcome.ts', exact: true });
  await expect(active).toHaveAttribute('aria-selected', 'true');
  await page.goto('/?sidebar-hidden');
  await command('Reveal Active File');
  await shown();
  await expect(active).toHaveAttribute('aria-selected', 'true');
});
