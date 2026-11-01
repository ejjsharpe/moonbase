import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const first = (page: Page) => page.getByRole('region', { name: 'First editor', exact: true });
async function edit(page: Page, text: string) {
  const input = first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await input.focus();
  await input.press('Meta+a');
  await input.pressSequentially(text);
}

test('real Monaco edits/save, shared diff model and isolated second instance', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(first(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toBeVisible();
  await edit(page, 'export const value = 42;');
  await expect(first(page).getByText('welcome.ts · Unsaved', { exact: true })).toBeVisible();
  await first(page).getByLabel('File view', { exact: true }).selectOption('staged');
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
  await first(page).getByRole('button', { name: 'Save', exact: true }).click();
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
  await first(page).getByRole('button', { name: 'Save', exact: true }).click();
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
  await first(page).getByRole('button', { name: 'Save', exact: true }).click();
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
  await first(page).getByRole('button', { name: 'Tab actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reopen Closed Files', exact: true }).click();
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

test('lookup groups/highlights, previews, tree actions and constrained layout', async ({
  page,
}) => {
  await page.goto('/');
  await page.setViewportSize({ width: 760, height: 720 });
  await first(page).getByRole('button', { name: 'Find file', exact: true }).click();
  await expect(
    page.getByRole('group', { name: 'Recent files', exact: true }).getByRole('option'),
  ).toContainText('welcome.ts');
  await page.getByRole('combobox').fill('exmp');
  await expect(page.getByRole('option')).toContainText('src/example.ts');
  await expect(page.locator('[role="option"] mark')).toHaveCount(4);
  await page.getByRole('combobox').press('Enter');
  await expect(first(page).getByRole('tab', { name: 'src/example.ts', exact: true })).toBeVisible();
  await expect(
    first(page).getByRole('textbox', { name: 'src/example.ts editor', exact: true }),
  ).toBeFocused();
  await first(page).getByRole('button', { name: 'New File', exact: true }).click();
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

test('R1 real close-checkout removes its Monaco models without a teardown exception', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeVisible();
  const before = await page.evaluate(() => window.demo.modelCount());
  await first(page)
    .getByRole('button', { name: 'Close checkout /demo/moonbase', exact: true })
    .click();
  await expect(
    first(page).getByText(
      'Open a checkout to browse files and edit. Unsaved changes belong to this editor instance.',
    ),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.demo.modelCount())).toBe(before - 1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/editor-checkout-closed.png', fullPage: true });
});

test('R2 rejected unchanged Rename/Move leaves explicit Save and Close usable', async ({
  page,
}) => {
  await page.goto('/');
  await first(page).getByRole('treeitem', { name: 'welcome.ts', exact: true }).click();
  await first(page).getByRole('button', { name: 'Rename / Move', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Rename or move', exact: true })
    .click();
  await page.getByRole('button', { name: 'Replace captured destination', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert').last()).toContainText(
    'Cannot transfer an entry into itself',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await edit(page, 'export const afterRejection = true;');
  await first(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(first(page).getByText('welcome.ts · Unsaved', { exact: true })).toHaveCount(0);
  await first(page).getByRole('button', { name: 'Close welcome.ts', exact: true }).click();
  await expect(first(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toHaveCount(0);
});

test('R2 close-all/reopen/close-active loads the surviving file instead of an unavailable placeholder', async ({
  page,
}) => {
  await page.goto('/');
  await first(page).getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  await first(page).getByRole('button', { name: 'Tab actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Close All', exact: true }).click();
  await expect(first(page).getByRole('tab', { name: 'README.md', exact: true })).toHaveCount(0);
  await first(page).getByRole('button', { name: 'Tab actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reopen Closed Files', exact: true }).click();
  await expect(
    first(page).getByRole('textbox', { name: 'README.md editor', exact: true }),
  ).toBeVisible();
  await first(page).getByRole('button', { name: 'Close README.md', exact: true }).click();
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeVisible();
});

for (const navigation of ['visual', 'recent'] as const)
  test(`R2 ${navigation} keyboard navigation restores typing focus and keeps tab-strip focus`, async ({
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

test('R3 a checkout clicked during close publication remains selected live and durably', async ({
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
  test(`R3 keyboard ${shortcut} hands off typing focus`, async ({ page }) => {
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

test('R3 keyboard close cancellation and failed publication preserve typing focus and dialog scope', async ({
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

test('R3 keyboard close/reopen retains tree or strip origin and meaningful empty-editor focus', async ({
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
  await expect(first(page).getByRole('button', { name: 'Find file', exact: true })).toBeFocused();
  await page.keyboard.press('Meta+Shift+t');
  await expect(
    first(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Hide first editor', exact: true }).click();
  const before = await page.evaluate(() => window.demo.first.getSnapshot().recovery);
  await page.keyboard.press('Meta+Shift+t');
  expect(await page.evaluate(() => window.demo.first.getSnapshot().recovery)).toEqual(before);
});

test('R4 returning to a background-closed checkout loads the survivor', async ({ page }) => {
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
  test(`R4 actual typing after close into remembered ${area} comparison`, async ({ page }) => {
    await page.goto('/');
    await first(page).getByLabel('File view', { exact: true }).selectOption(area);
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

test('R4 uncertain final close is visible, blocks Quit and resolves by exact receipt before focusing its survivor', async ({
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
  expect(
    await page.evaluate(() => window.recoveryRace.editor.prepareQuit(async () => 'discard')),
  ).toBe(false);
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

test('R5 selecting an absent survivor during another close loads it after preservation releases', async ({
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

test('R6 delayed public Copy cannot reopen a destination closed through Monaco UI', async ({
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
  await page.getByRole('treeitem', { name: 'copy.ts', exact: true }).dblclick();
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
  test(`R6 restored dirty ${area} survivor shows its original and accepts typing`, async ({
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
  test(`R7 recreated ${area} working file becomes editable with Save enabled`, async ({ page }) => {
    await page.goto('/recovery-race.html?missing=' + area);
    const original = page.getByRole('textbox', { name: area + ' · a.ts original', exact: true }),
      modified = page.getByRole('textbox', { name: 'a.ts editor', exact: true });
    await expect(original).toHaveJSProperty('readOnly', true);
    await expect(modified).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: 'beta · main', exact: true }).click();
    await page.evaluate(() => window.recoveryRace.recreateWorking());
    await page.getByRole('tab', { name: 'alpha · main', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
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
    await page.getByRole('button', { name: 'Save', exact: true }).click();
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

test('R9 lost and reordered Save receipts keep Retry Save visible until exact recovery settles', async ({
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
  await first(page).getByRole('button', { name: 'Save', exact: true }).click();
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
  await first(page).getByRole('button', { name: 'Save', exact: true }).click();
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
  await expect(first(page).getByRole('button', { name: 'Save', exact: true })).toBeVisible();
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
  await expect(first(page).getByRole('button', { name: 'Save', exact: true })).toBeVisible();
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

test('R10 Resolve recovers a rejected metadata publication after an already-started Save', async ({
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
  await page.getByRole('button', { name: 'Save', exact: true }).click();
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
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
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
  await page.getByRole('button', { name: 'Save', exact: true }).click();
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
      await first(page).getByRole('treeitem', { name: path, exact: true }).dblclick();
      const input = first(page).getByRole('textbox', { name: path + ' editor', exact: true });
      await expect(input).toBeVisible();
      await input.focus();
      await input.press('ArrowRight');
      expect(await page.evaluate(() => Object.hasOwn(Object.prototype, 'file'))).toBe(false);
      await input.press('Meta+a');
      await input.pressSequentially('saved ' + path);
      await first(page).getByRole('button', { name: 'Save', exact: true }).click();
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
      await first.close([{ checkout, path: 'README.md' }], async () => 'discard');
      await first.open({ checkout, path: 'src/example.ts' }, { intent: 'preview' });
    });
    const trigger = first(page).getByRole('button', { name: 'Tab actions', exact: true });
    await trigger.focus();
    await trigger.press('Enter');
    const menu = page.getByRole('menu'),
      firstItem = page.getByRole('menuitem', { name: 'Keep Open', exact: true }),
      lastItem = page.getByRole('menuitem', { name: 'Reopen Closed Files', exact: true });
    const within = async (item: ReturnType<Page['getByRole']>) =>
      item.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      });
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
    await trigger.click();
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
  await second.getByRole('button', { name: 'New File', exact: true }).click();
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
