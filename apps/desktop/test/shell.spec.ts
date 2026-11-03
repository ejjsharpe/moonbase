import { test, expect, type Page } from '@playwright/test';

const shell = (page: Page) => page.getByRole('region', { name: 'First editor', exact: true });
const tabs = (page: Page) =>
  shell(page).getByRole('tablist', { name: 'Workbench views', exact: true });
const project = (page: Page) =>
  tabs(page).getByRole('tab', { name: 'moonbase · main', exact: true });
const input = (page: Page) =>
  shell(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
async function chat(page: Page) {
  await tabs(page).getByRole('tab', { name: 'Chat', exact: true }).click();
  await shell(page).getByRole('button', { name: 'Connect', exact: true }).click();
  await shell(page)
    .getByRole('button', { name: /^Conversation/ })
    .click();
  await expect(shell(page).getByLabel('Message', { exact: true })).toBeEnabled();
}

test('browser shell keeps dirty comparisons, cursor, scroll, Monaco undo and scoped keyboard/focus across project and Chat tabs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?chat');
  await expect(input(page)).toBeVisible();
  expect(
    await page.evaluate(() => ({ desktop: 'moonbase' in window, chat: 'moonbaseChat' in window })),
  ).toEqual({ desktop: false, chat: false });
  expect(await page.evaluate(() => window.demo.chat.calls)).toEqual([]);
  await page.evaluate(() => {
    const { first, checkout } = window.demo;
    first.edit(
      { checkout, path: 'welcome.ts' },
      Array.from({ length: 200 }, (_, i) => `// line ${i}`).join('\n'),
    );
  });
  await shell(page).getByLabel('File view', { exact: true }).selectOption('staged');
  await expect.poll(() => page.evaluate(() => window.demo.diffReady())).toBe(true);
  await input(page).focus();
  await input(page).press('Meta+ArrowDown');
  await input(page).press('X');
  const before = await page.evaluate(() => ({
    text: window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    position: window.demo.first.getSnapshot().recovery.views.sample.positions['welcome.ts'].staged!,
    models: window.demo.modelCount(),
  }));
  expect(before.position.line).toBe(200);
  expect(before.position.top).toBeGreaterThan(0);
  await input(page).evaluate((element) => element.setAttribute('data-retained-view', 'true'));
  await chat(page);
  await shell(page).getByLabel('Message', { exact: true }).fill('separate chat draft');
  await shell(page).getByLabel('Message', { exact: true }).press('Meta+p');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await shell(page).getByLabel('Message', { exact: true }).press('Meta+s');
  expect(await page.evaluate(() => window.demo.memory.stats.saves)).toBe(0);
  await tabs(page).getByRole('tab', { name: 'Chat', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(project(page)).toBeFocused();
  await expect(project(page)).toHaveAttribute('aria-selected', 'true');
  await expect(input(page)).toHaveAttribute('data-retained-view', 'true');
  expect(await page.evaluate(() => window.demo.modelCount())).toBe(before.models);
  expect(
    await page.evaluate(
      () => window.demo.first.getSnapshot().recovery.views.sample.positions['welcome.ts'].staged!,
    ),
  ).toEqual(before.position);
  await expect(shell(page).getByLabel('File view', { exact: true })).toHaveValue('staged');
  await input(page).focus();
  await tabs(page).getByRole('tab', { name: 'Chat', exact: true }).click();
  await project(page).click();
  await expect(input(page)).toBeFocused();
  await input(page).press('Meta+z');
  expect(
    await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    ),
  ).toBe(before.text.slice(0, -1));
  expect(
    await page.evaluate(() =>
      window.demo.chat.calls.filter((call) => ['sendChat', 'stopChat'].includes(call)),
    ),
  ).toEqual([]);
  await page.screenshot({ path: 'test-results/shared-workbench-project.png', fullPage: true });
  expect(errors).toEqual([]);
});

for (const mode of ['file', 'staged'] as const) {
  for (const selection of ['range', 'multiple cursors'] as const) {
    test(`Chat round trip preserves ${selection} in ${mode} view`, async ({ page }) => {
      await page.goto('/?chat');
      await expect(input(page)).toBeVisible();
      await page.evaluate(() =>
        window.demo.first.edit(
          { checkout: window.demo.checkout, path: 'welcome.ts' },
          'first\nsecond',
        ),
      );
      await shell(page).getByLabel('File view', { exact: true }).selectOption(mode);
      if (mode === 'staged')
        await expect.poll(() => page.evaluate(() => window.demo.diffReady())).toBe(true);
      await input(page).focus();
      await input(page).press('Meta+a');
      if (selection === 'multiple cursors') {
        await input(page).press('ArrowLeft');
        await input(page).press('Meta+Alt+ArrowDown');
      }
      await tabs(page).getByRole('tab', { name: 'Chat', exact: true }).click();
      await project(page).click();
      await expect(input(page)).toBeFocused();
      await input(page).press('Q');
      expect(
        await page.evaluate(
          () =>
            window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
        ),
      ).toBe(selection === 'range' ? 'Q' : 'Qfirst\nQsecond');
    });
  }
}

test('project-tab shortcuts use the editor handler after keyboard navigation from Chat', async ({
  page,
}) => {
  await page.goto('/?chat');
  await expect(input(page)).toBeVisible();
  await page.evaluate(() =>
    window.demo.first.edit(
      { checkout: window.demo.checkout, path: 'welcome.ts' },
      'save from project tab',
    ),
  );
  await tabs(page).getByRole('tab', { name: 'Chat', exact: true }).click();
  await tabs(page).getByRole('tab', { name: 'Chat', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(project(page)).toBeFocused();
  await project(page).press('Meta+s');
  await expect.poll(() => page.evaluate(() => window.demo.memory.stats.saves)).toBe(1);
  await expect(project(page)).toBeFocused();
  await project(page).press('Meta+p');
  await expect(page.getByRole('dialog', { name: 'Find file', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await project(page).focus();
  await project(page).press('Meta+w');
  await expect(shell(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toHaveCount(0);
  await project(page).focus();
  await project(page).press('Meta+Shift+t');
  await expect(input(page)).toBeVisible();
});

for (const choice of ['Save', 'Discard'] as const) {
  test(`shell project close Cancel retains work, then ${choice} uses the authoritative close gate`, async ({
    page,
  }) => {
    await page.goto('/?chat');
    await expect(input(page)).toBeVisible();
    await input(page).focus();
    await input(page).press('Meta+a');
    await input(page).pressSequentially('dirty project close');
    await tabs(page)
      .getByRole('button', { name: 'Close checkout /demo/moonbase', exact: true })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(project(page)).toHaveAttribute('aria-selected', 'true');
    expect(
      await page.evaluate(
        () =>
          window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
      ),
    ).toBe('dirty project close');
    await tabs(page)
      .getByRole('button', { name: 'Close checkout /demo/moonbase', exact: true })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: choice, exact: true }).click();
    await expect(project(page)).toHaveCount(0);
    await expect(
      shell(page).getByText(
        'Open a checkout to browse files and edit. Unsaved changes belong to this editor instance.',
      ),
    ).toBeVisible();
    expect(await page.evaluate(() => window.demo.memory.stats.saves)).toBe(
      choice === 'Save' ? 1 : 0,
    );
    expect(
      await page.evaluate(() => window.demo.first.getSnapshot().recovery.checkouts),
    ).toHaveLength(1);
  });
}

test('opening an exact project from Chat selects it and retains the other project and its comparisons', async ({
  page,
}) => {
  await page.goto('/?chat');
  await expect(input(page)).toBeVisible();
  await shell(page).getByLabel('File view', { exact: true }).selectOption('staged');
  await tabs(page).getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.evaluate(() => {
    window.demo.selectCheckout = async () => '/demo/other';
    window.demo.memory.failNext('openCheckout', 'Controlled project Open failure');
  });
  await shell(page).getByRole('button', { name: 'Open checkout', exact: true }).click();
  await expect(shell(page).getByRole('alert').last()).toContainText(
    'Controlled project Open failure',
  );
  await expect(project(page)).toHaveAttribute('aria-selected', 'true');
  await tabs(page).getByRole('tab', { name: 'Chat', exact: true }).click();
  await shell(page).getByRole('button', { name: 'Open checkout', exact: true }).click();
  await expect(tabs(page).getByRole('tab', { name: 'other · main', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await shell(page).getByRole('treeitem', { name: 'elsewhere.ts', exact: true }).dblclick();
  await project(page).click();
  await expect(input(page)).toBeVisible();
  await expect(shell(page).getByLabel('File view', { exact: true })).toHaveValue('staged');
  expect(
    await page.evaluate(() => window.demo.first.getSnapshot().recovery.openCheckoutIds),
  ).toEqual(['sample', 'other']);
});

test('Quit from Chat reveals exact editor prompts and Cancel returns live admission', async ({
  page,
}) => {
  await page.goto('/?chat');
  await expect(input(page)).toBeVisible();
  await page.evaluate(() =>
    window.demo.first.edit(
      { checkout: window.demo.checkout, path: 'welcome.ts' },
      'retained on Quit',
    ),
  );
  await chat(page);
  await page.evaluate(() => {
    void window.demo.workbench().prepareQuit();
  });
  await expect(page.getByRole('dialog')).toContainText('welcome.ts has unsaved changes.');
  expect(
    await page.getByRole('dialog').evaluate((element) => getComputedStyle(element).fontFamily),
  ).toBe(
    await page
      .locator('[aria-label="First editor"]')
      .evaluate((element) => getComputedStyle(element).fontFamily),
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.demo.application.getSnapshot().phase))
    .toBe('live');
  await expect(project(page)).toHaveAttribute('aria-selected', 'true');
  await input(page).focus();
  await input(page).press('End');
  await input(page).pressSequentially(' still editable');
  expect(
    await page.evaluate(
      () => window.demo.first.buffer({ checkout: window.demo.checkout, path: 'welcome.ts' })!.text,
    ),
  ).toContain('still editable');
});

for (const fail of [false, true]) {
  test(`Chat removal retains ${fail ? 'failing' : 'held'} cleanup visibility and its namespace gate`, async ({
    page,
  }) => {
    await page.goto('/?chat');
    await chat(page);
    await page.evaluate((fail) => {
      const pending = Promise.withResolvers<void>();
      window.demo.chat.controls.release = () => pending.promise;
      window.demo.retryChat = () =>
        fail ? pending.reject(Error('Controlled observation cleanup failure')) : pending.resolve();
    }, fail);
    await tabs(page).getByRole('button', { name: 'Close Chat panel', exact: true }).click();
    await expect(tabs(page).getByRole('tab', { name: 'Chat', exact: true })).toHaveCount(0);
    const reopen = shell(page).getByRole('button', { name: 'Open Chat panel', exact: true });
    await expect(reopen).toBeDisabled();
    await expect(shell(page).getByText('Finishing panel cleanup…')).toBeVisible();
    await expect(input(page)).toBeVisible();
    await page.evaluate(() => window.demo.retryChat());
    if (fail) {
      await expect(
        shell(page).getByRole('alert', { name: 'Panel cleanup errors', exact: true }),
      ).toBeVisible();
      await expect(reopen).toBeDisabled();
    } else {
      await expect(reopen).toBeEnabled();
      await page.evaluate(() => {
        window.demo.chat.controls.release = async () => {};
      });
      await reopen.click();
      await expect(tabs(page).getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    }
    expect(
      await page.evaluate(() => window.demo.chat.calls.filter((call) => call === 'stopChat')),
    ).toEqual([]);
  });
}

test('optional Chat initialization failure remains visible and explicit retry opens the actual shared Chat view', async ({
  page,
}) => {
  await page.goto('/?chat&fail-chat');
  await expect(input(page)).toBeVisible();
  await expect(
    shell(page).getByRole('alert', { name: 'Chat initialization failed', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.demo.application.canUnload())).toBe(false);
  await page.evaluate(() => window.demo.retryChat());
  await shell(page).getByRole('button', { name: 'Open Chat panel', exact: true }).click();
  await expect(shell(page).getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/shared-workbench-chat.png', fullPage: true });
});
