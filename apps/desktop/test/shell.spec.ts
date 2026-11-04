import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const shell = (page: Page) => page.getByRole('region', { name: 'First editor', exact: true });
const tabs = (page: Page) =>
  shell(page).getByRole('tablist', { name: 'Workbench views', exact: true });
const project = (page: Page) =>
  tabs(page).getByRole('tab', { name: 'moonbase · main', exact: true });
const input = (page: Page) =>
  shell(page).getByRole('textbox', { name: 'welcome.ts editor', exact: true });
async function chat(page: Page) {
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  await shell(page).getByRole('button', { name: 'Connect', exact: true }).click();
  await shell(page)
    .getByRole('button', { name: /^Conversation/ })
    .click();
  await expect(shell(page).getByLabel('Message', { exact: true })).toBeEnabled();
}

test('bundled fonts load and Monaco realigns the cursor after a delayed editor font', async ({
  page,
}) => {
  let releaseFont!: () => void;
  const fontGate = new Promise<void>((resolve) => {
    releaseFont = resolve;
  });
  await page.route('**/space-mono-nerd-font-mono-regular.woff2', async (route) => {
    await fontGate;
    await route.continue();
  });
  try {
    await page.goto('/?chat', { waitUntil: 'domcontentloaded' });
    await project(page).click();
    await expect(input(page)).toBeVisible();
    await page.evaluate(() => {
      window.demo.first.edit(
        { checkout: window.demo.checkout, path: 'welcome.ts' },
        'i'.repeat(40),
      );
    });
    await input(page).focus();
    await input(page).press('Meta+ArrowRight');
    expect(
      await page.evaluate(() => document.fonts.check('400 13px "SpaceMono Nerd Font Mono"')),
    ).toBe(false);
    releaseFont();
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return Promise.all(
        ['400 13px "SpaceMono Nerd Font Mono"', '600 13px "Manrope"'].map(async (font) =>
          (await document.fonts.load(font)).map((face) => face.status),
        ),
      );
    });
    expect(fonts).toEqual([['loaded'], ['loaded']]);
    const editor = input(page).locator('xpath=ancestor::div[contains(@class,"monaco-editor")]');
    await expect
      .poll(() =>
        editor.evaluate((element) => {
          const line = element.querySelector('.view-line')!,
            cursor = element.querySelector('.cursor')!,
            range = document.createRange();
          range.selectNodeContents(line);
          const caret = cursor.getBoundingClientRect(),
            textEnd = range.getBoundingClientRect().right;
          return Math.max(caret.left - textEnd, textEnd - caret.right, 0);
        }),
      )
      .toBeLessThan(1);
  } finally {
    releaseFont();
  }
});

test('browser shell keeps dirty comparisons, cursor, scroll, Monaco undo and scoped keyboard/focus across project and Chat tabs', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?chat');
  await project(page).click();
  await expect(input(page)).toBeVisible();
  expect(
    await page.evaluate(() => ({ desktop: 'moonbase' in window, chat: 'moonbaseChat' in window })),
  ).toEqual({ desktop: false, chat: false });
  expect(
    await page.evaluate(() =>
      window.demo.chat.calls.filter((call) =>
        ['connect', 'createChat', 'sendChat', 'stopChat'].includes(call),
      ),
    ),
  ).toEqual([]);
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
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
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
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
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
      await project(page).click();
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
      await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
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
  await project(page).click();
  await expect(input(page)).toBeVisible();
  await page.evaluate(() =>
    window.demo.first.edit(
      { checkout: window.demo.checkout, path: 'welcome.ts' },
      'save from project tab',
    ),
  );
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
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

test('reopened projects append to the tab strip and open projects keep their slot', async ({
  page,
}) => {
  await page.goto('/?chat&design');
  await page.evaluate(async () => {
    await window.demo.first.openCheckout('/demo/other');
    await window.demo.first.openCheckout('/demo/third');
  });
  const projects = page.getByRole('group', { name: 'Project tabs', exact: true });
  const projectTabs = projects.getByRole('tab');
  await expect(projectTabs).toHaveText(['moonbase · main', 'other · main', 'third · main']);
  await projects.getByRole('tab', { name: 'other · main', exact: true }).hover();
  await projects.getByRole('button', { name: 'Close checkout /demo/other', exact: true }).click();
  await expect(projectTabs).toHaveText(['moonbase · main', 'third · main']);
  await page.evaluate(() => {
    window.demo.selectCheckout = async () => '/demo/other';
  });
  await projects.getByRole('button', { name: 'Open checkout', exact: true }).click();
  await expect(projectTabs).toHaveText(['moonbase · main', 'third · main', 'other · main']);
  expect(
    await page.evaluate(() => window.demo.first.getSnapshot().recovery.openCheckoutIds),
  ).toEqual(['sample', 'third', 'other']);
  await page.evaluate(() => {
    window.demo.selectCheckout = async () => '/demo/third';
  });
  await projects.getByRole('button', { name: 'Open checkout', exact: true }).click();
  await expect(projects.getByRole('tab', { name: 'third · main', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(projectTabs).toHaveText(['moonbase · main', 'third · main', 'other · main']);
  await expect(
    projects.getByRole('tab', { name: 'other · main', exact: true }).locator('..'),
  ).toHaveCSS('transform', 'none');
  await page.screenshot({ path: test.info().outputPath('reopened-project-tabs.png') });
});

for (const closed of ['moonbase', 'other', 'third']) {
  test(`closing the active ${closed} project selects the rightmost remaining tab`, async ({
    page,
  }) => {
    await page.goto('/?chat&design');
    await page.evaluate(async () => {
      await window.demo.first.openCheckout('/demo/other');
      await window.demo.first.openCheckout('/demo/third');
    });
    const projects = page.getByRole('group', { name: 'Project tabs', exact: true });
    await projects.getByRole('tab', { name: `${closed} · main`, exact: true }).click();
    await projects
      .getByRole('button', { name: `Close checkout /demo/${closed}`, exact: true })
      .click();
    const next = closed === 'third' ? 'other' : 'third';
    await expect(
      projects.getByRole('tab', { name: `${next} · main`, exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    const recovery = await page.evaluate(() =>
      window.demo.client.command('loadRecovery', { clientId: window.demo.first.clientId }),
    );
    expect(recovery.state.selectedCheckoutId).toBe(next);
    expect(recovery.state.openCheckoutIds.at(-1)).toBe(next);
  });
}

for (const selected of ['other · main', 'moonbase · main', 'Agents']) {
  test(`closing a project from ${selected} keeps the next view steady`, async ({ page }) => {
    await page.goto('/?chat&design');
    await page.evaluate(async () => {
      const checkout = await window.demo.first.openCheckout('/demo/other');
      await window.demo.first.open({ checkout, path: 'elsewhere.ts' }, { intent: 'keep' });
    });
    const other = page.getByRole('tab', { name: 'other · main', exact: true });
    await page.getByRole('tab', { name: selected, exact: true }).click();
    await expect(page.getByRole('tab', { name: selected, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(other.locator('..')).toHaveCSS('transform', 'none');
    const frames = await page.evaluate(async () => {
      const command = window.demo.client.command;
      window.demo.client.command = async (...args) => {
        if (args[0] === 'persistRecovery') await new Promise((resolve) => setTimeout(resolve, 50));
        return command(...args);
      };
      const frames: { selected: string | null; editors: string[]; top: number }[] = [];
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Close checkout /demo/other"]')!
        .click();
      for (let i = 0; i < 32; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frames.push({
          selected:
            document.querySelector(
              '[role="tablist"][aria-label="Workbench views"] [aria-selected="true"]',
            )?.textContent ?? null,
          editors: [
            ...document.querySelectorAll<HTMLElement>('.monaco-editor textarea[role="textbox"]'),
          ]
            .filter((element) => element.checkVisibility())
            .map((element) => element.getAttribute('aria-label')!),
          top: document
            .querySelector('[aria-label="Moonbase workbench"] > [role="tabpanel"]:not([hidden])')!
            .getBoundingClientRect().top,
        });
      }
      window.demo.client.command = command;
      return frames;
    });
    const next = selected === 'other · main' ? 'moonbase · main' : selected;
    for (const frame of frames) {
      expect(frame.selected).not.toBeNull();
      expect([selected, next]).toContain(frame.selected);
      expect(frame.editors).toEqual(
        frame.selected === 'Agents'
          ? []
          : [frame.selected === 'other · main' ? 'elsewhere.ts editor' : 'welcome.ts editor'],
      );
    }
    expect([...new Set(frames.map((frame) => frame.top))]).toEqual([40]);
    await expect(page.getByRole('tab', { name: next, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
}

test('closing the final project shows Agents directly without an empty editor frame', async ({
  page,
}) => {
  await page.goto('/?chat&design');
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const frames = await page.evaluate(async () => {
    const frames: string[] = [];
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Close checkout /demo/moonbase"]')!
      .click();
    for (let i = 0; i < 32; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push(
        document.querySelector(
          '[aria-label="Moonbase workbench"] > [role="tabpanel"]:not([hidden])',
        )?.textContent ?? '',
      );
    }
    return frames;
  });
  expect(
    frames.filter((frame) => !frame || frame.includes('Open a checkout to browse files')),
  ).toEqual([]);
  await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

for (const fromChat of [false, true]) {
  for (const choice of ['Save', 'Discard'] as const) {
    test(`shell project close ${fromChat ? 'from Chat ' : ''}Cancel retains work, then ${choice} uses the authoritative close gate`, async ({
      page,
    }) => {
      await page.goto('/?chat');
      await project(page).click();
      await expect(input(page)).toBeVisible();
      await input(page).focus();
      await input(page).press('Meta+a');
      await input(page).pressSequentially('dirty project close');
      if (fromChat) await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
      await project(page).hover();
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
      if (fromChat) await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
      await project(page).hover();
      await tabs(page)
        .getByRole('button', { name: 'Close checkout /demo/moonbase', exact: true })
        .click();
      await page.getByRole('dialog').getByRole('button', { name: choice, exact: true }).click();
      await expect(project(page)).toHaveCount(0);
      await expect(tabs(page).getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(await page.evaluate(() => window.demo.memory.stats.saves)).toBe(
        choice === 'Save' ? 1 : 0,
      );
      expect(
        await page.evaluate(() => window.demo.first.getSnapshot().recovery.checkouts),
      ).toHaveLength(1);
    });
  }
}

test('failed Open without a project stays visible in Agents and can be dismissed and retried', async ({
  page,
}) => {
  await page.goto('/?chat&design');
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  await page.getByRole('button', { name: 'Close checkout /demo/moonbase', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.evaluate(() => {
    window.demo.selectCheckout = async () => '/demo/other';
    window.demo.memory.failNext('openCheckout', 'Controlled empty Open failure');
  });
  await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: 'Controlled empty Open failure' });
  await expect(error).toBeVisible();
  await error.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(error).toHaveCount(0);
  await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'other · main', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

for (const fromChat of [false, true]) {
  test(`a background close Save conflict from ${fromChat ? 'Agents' : 'another project'} reveals the captured project and recovery controls`, async ({
    page,
  }) => {
    await page.goto('/?chat&design');
    await page.evaluate(async () => {
      const checkout = await window.demo.first.openCheckout('/demo/other');
      const target = { checkout, path: 'elsewhere.ts' };
      await window.demo.first.open(target, { intent: 'keep' });
      window.demo.first.edit(target, 'retained background edit');
      window.demo.memory.externalWrite(target, 'external background edit');
    });
    await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
    if (fromChat) await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    const other = page.getByRole('tab', { name: 'other · main', exact: true });
    await other.hover();
    await page.getByRole('button', { name: 'Close checkout /demo/other', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(other).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByRole('textbox', { name: 'elsewhere.ts editor', exact: true }),
    ).toBeVisible();
    for (const name of ['Compare', 'Overwrite observed version', 'Reload'])
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Overwrite observed version', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.demo.memory.stats.saves)).toBe(1);
    expect(
      await page.evaluate(() => {
        const checkout = window.demo.first
          .getSnapshot()
          .recovery.checkouts.find((checkout) => checkout.checkoutId === 'other')!;
        return window.demo.client.command('readFile', { checkout, path: 'elsewhere.ts' });
      }),
    ).toMatchObject({ text: 'retained background edit' });
    await expect(other).toHaveAttribute('aria-selected', 'true');
  });
}

test('failed project close from Chat reveals recovery errors and retains the project', async ({
  page,
}) => {
  await page.goto('/?chat');
  await page.evaluate(() =>
    window.demo.memory.failNext('persistRecovery', 'Controlled close failure'),
  );
  await project(page).hover();
  await tabs(page)
    .getByRole('button', { name: 'Close checkout /demo/moonbase', exact: true })
    .click();
  await expect(project(page)).toHaveAttribute('aria-selected', 'true');
  await expect(shell(page).getByRole('alert').last()).toContainText('Controlled close failure');
  expect(
    await page.evaluate(() => window.demo.first.getSnapshot().recovery.openCheckoutIds),
  ).toEqual(['sample']);
});

test('closing every view leaves the editor empty state available', async ({ page }) => {
  await page.goto('/?chat');
  await tabs(page).getByRole('button', { name: 'Close Chat panel', exact: true }).click();
  await tabs(page)
    .getByRole('button', { name: 'Close checkout /demo/moonbase', exact: true })
    .click();
  await expect(
    shell(page).getByText(
      'Open a checkout to browse files and edit. Unsaved changes belong to this editor instance.',
    ),
  ).toBeVisible();
});

test('opening an exact project from Chat selects it and retains the other project and its comparisons', async ({
  page,
}) => {
  await page.goto('/?chat');
  await project(page).click();
  await expect(input(page)).toBeVisible();
  await shell(page).getByLabel('File view', { exact: true }).selectOption('staged');
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.evaluate(() => {
    window.demo.selectCheckout = async () => '/demo/other';
    window.demo.memory.failNext('openCheckout', 'Controlled project Open failure');
  });
  await shell(page).getByRole('button', { name: 'Open checkout', exact: true }).click();
  await expect(shell(page).getByRole('alert').last()).toContainText(
    'Controlled project Open failure',
  );
  await expect(project(page)).toHaveAttribute('aria-selected', 'true');
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
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
  await project(page).click();
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
    await project(page).click();
    await chat(page);
    await page.evaluate((fail) => {
      const pending = Promise.withResolvers<void>();
      window.demo.chat.controls.release = () => pending.promise;
      window.demo.retryChat = () =>
        fail ? pending.reject(Error('Controlled observation cleanup failure')) : pending.resolve();
    }, fail);
    await tabs(page).getByRole('button', { name: 'Close Chat panel', exact: true }).click();
    await expect(tabs(page).getByRole('tab', { name: 'Agents', exact: true })).toHaveCount(0);
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
      await expect(tabs(page).getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute(
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
  await project(page).click();
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

test('Agents opens first and accepts a preserved draft without a project or saved chat', async ({
  page,
}) => {
  await page.goto('/?chat');
  await expect(tabs(page).getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(input(page)).toBeHidden();
  await page.evaluate(() => window.demo.first.closeCheckout(window.demo.checkout));
  await expect(project(page)).toHaveCount(0);
  const message = shell(page).getByLabel('Message', { exact: true });
  await message.fill('Start by talking');
  expect(await page.evaluate(() => JSON.parse(window.demo.chat.storage.value!).newDraft)).toBe(
    'Start by talking',
  );
  expect(
    await page.evaluate(() =>
      window.demo.chat.calls.filter((call) => ['createChat', 'sendChat'].includes(call)),
    ),
  ).toEqual([]);
  await shell(page).getByRole('button', { name: 'Connect', exact: true }).click();
  await shell(page).getByRole('button', { name: 'Send message', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.demo.chat.calls.filter((call) => ['createChat', 'sendChat'].includes(call)),
      ),
    )
    .toEqual(['createChat', 'sendChat']);
  await expect(message).toHaveValue('');
  await expect(
    shell(page).getByRole('heading', { name: 'Conversation', exact: true }),
  ).toBeVisible();
  const plus = tabs(page).getByRole('button', { name: 'Open checkout', exact: true });
  await expect(plus.locator('svg')).toBeVisible();
  await expect(shell(page).getByRole('button', { name: 'Import files', exact: true })).toHaveCount(
    0,
  );
});

test('local model and effort defaults yield to preferences across new chats and panel reopening', async ({
  page,
}) => {
  await page.goto('/?local&design');
  const model = page.getByRole('combobox', { name: 'Conversation model', exact: true });
  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true });
  await expect(model).toContainText('Demo model');
  await expect(effort).toContainText('Medium');
  await model.click();
  await page
    .getByRole('option', { name: 'Demo coding model · Demo provider', exact: true })
    .click();
  await effort.click();
  await page.getByRole('option', { name: 'Extra high', exact: true }).click();
  await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Remember my coding model');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('demo-coding · Extra high', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(model).toContainText('Demo coding model');
  await expect(effort).toContainText('Extra high');
  await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
  await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
  await expect(model).toContainText('Demo coding model');
  await expect(effort).toContainText('Extra high');
  const preference = await page.evaluate(
    () => window.demo.application.chat!.getSnapshot().modelPreference,
  );
  expect(preference).toEqual({
    model: { provider: 'openai', modelId: 'demo-coding' },
    reasoningEffort: 'xhigh',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(effort).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  await page.screenshot({
    path: '../../test-results/redesign-review/model-preferences-compact.png',
  });
  await page.evaluate(() =>
    window.demo.application.chat!.setModelPreference({
      model: { provider: 'openai', modelId: 'retired-model' },
      reasoningEffort: 'xhigh',
    }),
  );
  await expect(page.getByText(/Your saved model \(retired-model\) is unavailable/)).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Do not silently switch');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.evaluate(() =>
    window.demo.application.chat!.setModelPreference({
      model: { provider: 'openai', modelId: 'demo-model' },
      reasoningEffort: 'xhigh',
    }),
  );
  await expect(
    page.getByText(
      'Your saved reasoning effort is unavailable for this model. Choose another effort to send.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
});

test('first-message recovery shows the captured text, Send identity and effort after newer edits', async ({
  page,
}) => {
  await page.goto('/?local&design');
  await expect(
    page.getByRole('combobox', { name: 'Conversation model', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.demo.application.chat!.setModelPreference({
      model: { provider: 'openai', modelId: 'demo-coding' },
      reasoningEffort: 'xhigh',
    });
    const chat = window.demo.chat.dependencies.chat;
    const original = chat.command;
    chat.command = (async (operation, input, options) => {
      if (operation === 'createChat') throw Error('Controlled lost Create response');
      return original(operation, input, options);
    }) as typeof chat.command;
    window.demo.retryChat = () => {
      chat.command = original;
    };
  });
  await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
  const original = 'A short title\nThe original complete first message';
  const message = page.getByLabel('Message', { exact: true });
  await message.fill(original);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const retained = page.getByRole('region', { name: 'Retained commands', exact: true });
  await expect(retained).toBeVisible();
  await message.fill('Newer unsent edit');
  await retained.locator('summary').click();
  await expect(retained.locator('pre')).toHaveText(original);
  const id = await page.evaluate(() => {
    const pending = window.demo.application.chat!.getSnapshot().pending[0]!;
    return pending.operation === 'createChat' ? pending.firstMessage?.requestId : undefined;
  });
  expect(id).toBeTruthy();
  await expect(retained.getByText(`Send · ${id}`, { exact: true })).toBeVisible();
  await expect(retained.getByText(/openai\/demo-coding · Extra high/)).toBeVisible();
  await page.evaluate(() => window.demo.retryChat());
  await retained.getByRole('button', { name: 'Retry original Create', exact: true }).click();
  await expect(retained).toHaveCount(0);
  await expect(message).toHaveValue('Newer unsent edit');
});

test('file paste uses the exact sidebar checkout and leaves editor text paste alone', async ({
  page,
}) => {
  await page.goto('/?chat');
  await project(page).click();
  await page.evaluate(() => {
    window.demo.selectClipboardImports = async (checkout) => {
      if (JSON.stringify(checkout) !== JSON.stringify(window.demo.checkout))
        throw Error('Wrong paste checkout');
      return ['native-reference'];
    };
  });
  await shell(page).getByRole('tree', { name: 'Files', exact: true }).focus();
  await page.keyboard.press('Meta+v');
  await expect(page.getByRole('dialog', { name: 'Import files', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await input(page).focus();
  await input(page).press('Meta+v');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    shell(page).getByRole('button', { name: 'New File', exact: true }).locator('svg'),
  ).toBeVisible();
});

test('compact Agents navigation uses a keyboard-dismissable drawer and keeps Send reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?chat');
  const first = shell(page);
  await expect(first.getByLabel('Message', { exact: true })).toBeInViewport();
  await first.getByRole('button', { name: 'Show conversations', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Conversations', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(
    first.getByRole('button', { name: 'Show conversations', exact: true }),
  ).toBeFocused();
  await expect(first.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('main tabs dim inactive labels, reveal close on hover or focus and separate inactive neighbors', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.evaluate(() => window.demo.first.openCheckout('/demo/other'));
  const agents = page.getByRole('tab', { name: 'Agents', exact: true });
  const project = page.getByRole('tab', { name: 'moonbase · main', exact: true });
  const other = page.getByRole('tab', { name: 'other · main', exact: true });
  const closeProject = page.getByRole('button', {
    name: 'Close checkout /demo/moonbase',
    exact: true,
  });
  const closeAgents = page.getByRole('button', { name: 'Close Chat panel', exact: true });
  const groupBounds = async (tab: typeof project) =>
    tab.evaluate((element) => {
      const bounds = element.parentElement!.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right };
    });
  const [agentsBounds, projectBounds] = await Promise.all([
    groupBounds(agents),
    groupBounds(project),
  ]);
  expect(projectBounds.left - agentsBounds.right).toBe(6);
  await expect
    .poll(async () => (await groupBounds(other)).left - (await groupBounds(project)).right)
    .toBe(6);
  const divider = (tab: typeof project) =>
    tab.evaluate((element) => {
      const style = getComputedStyle(element.parentElement!, '::after');
      return { content: style.content, width: style.width, height: style.height };
    });
  await expect(agents).toHaveAttribute('aria-selected', 'true');
  expect(await divider(project)).toEqual({ content: '""', width: '1px', height: '16px' });
  await other.click();
  await page.mouse.move(900, 400);
  await expect(project).toHaveCSS('color', 'rgb(151, 151, 159)');
  await expect(agents).toHaveCSS('color', 'rgb(151, 151, 159)');
  await expect(other).toHaveCSS('color', 'rgb(229, 229, 231)');
  await expect(closeProject).toHaveCSS('opacity', '0');
  await expect(closeAgents).toHaveCSS('opacity', '0');
  await expect(
    page.getByRole('button', { name: 'Close checkout /demo/other', exact: true }),
  ).toHaveCSS('opacity', '1');
  expect((await divider(agents)).height).toBe('16px');
  expect((await divider(project)).content).toBe('none');
  const originalBounds = await project.boundingBox();
  await page
    .getByRole('tablist', { name: 'Workbench views', exact: true })
    .screenshot({ path: '../../test-results/redesign-review/tabs-idle.png' });
  await project.hover();
  await expect(project).toHaveCSS('color', 'rgb(229, 229, 231)');
  await expect(closeProject).toHaveCSS('opacity', '1');
  expect(
    await project.evaluate((element) => getComputedStyle(element.parentElement!).backgroundColor),
  ).toBe('rgb(34, 34, 36)');
  await expect(closeAgents).toHaveCSS('opacity', '0');
  expect(await project.boundingBox()).toEqual(originalBounds);
  await page
    .getByRole('tablist', { name: 'Workbench views', exact: true })
    .screenshot({ path: '../../test-results/redesign-review/tabs-hover.png' });
  await page.mouse.move(900, 400);
  await expect(closeProject).toHaveCSS('opacity', '0');
  await closeProject.focus();
  await expect(closeProject).toBeFocused();
  await expect(closeProject).toHaveCSS('opacity', '1');
  await expect(project).toHaveCSS('color', 'rgb(229, 229, 231)');
});

for (const scrolled of [false, true]) {
  test(`removing a middle tab moves survivors smoothly ${scrolled ? 'inside a scrolled strip' : 'without vertical movement'}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setViewportSize({ width: scrolled ? 768 : 1440, height: 900 });
    await page.goto('/?local&design');
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    await page.evaluate(() => window.demo.first.openCheckout('/demo/other'));
    const other = page.getByRole('tab', { name: 'other · main', exact: true });
    await expect(other.locator('..')).toHaveCSS('transform', 'none');
    if (scrolled) {
      await page.evaluate(() => window.demo.first.openCheckout('/demo/third'));
      await expect(
        page.getByRole('tab', { name: 'third · main', exact: true }).locator('..'),
      ).toHaveCSS('transform', 'none');
      await page.getByRole('group', { name: 'Project tabs', exact: true }).evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
    }
    await page
      .getByRole('tab', { name: scrolled ? 'other · main' : 'moonbase · main', exact: true })
      .click();
    const frames = await page.evaluate(async (scrolled) => {
      const other = () =>
        [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
          (tab) => tab.textContent === (scrolled ? 'third · main' : 'other · main'),
        )!.parentElement!;
      const plus = document.querySelector<HTMLElement>('button[aria-label="Open checkout"]')!;
      const read = () => {
        const bounds = other().getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, plus: plus.getBoundingClientRect().x };
      };
      const frames = [read()];
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="Close checkout /demo/${scrolled ? 'other' : 'moonbase'}"]`,
        )!
        .click();
      for (let i = 0; i < 32; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        frames.push(read());
      }
      return frames;
    }, scrolled);
    await mkdir(resolve('../../test-results/redesign-review'), { recursive: true });
    await writeFile(
      resolve(
        `../../test-results/redesign-review/tab-motion-middle${scrolled ? '-scrolled' : ''}.json`,
      ),
      JSON.stringify(frames, null, 2),
    );
    const first = frames[0],
      last = frames.at(-1)!;
    if (!scrolled) expect(first.x - last.x).toBeCloseTo(222, 0);
    expect(first.x - last.x).toBeGreaterThan(1);
    expect(frames.some((frame) => frame.x > last.x + 1 && frame.x < first.x - 1)).toBe(true);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].y).toBeCloseTo(first.y, 1);
      expect(frames[i].x).toBeLessThanOrEqual(frames[i - 1].x + 1);
      expect(frames[i].x).toBeGreaterThanOrEqual(last.x - 1);
      expect(frames[i].plus).toBeLessThanOrEqual(frames[i - 1].plus + 1);
    }
  });
}

for (const reducedMotion of [false, true]) {
  test(`tab addition and removal ${reducedMotion ? 'respect reduced motion' : 'slide neighboring tabs'}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?local&design');
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    await page.evaluate(() => {
      window.demo.selectCheckout = async () => '/demo/other';
    });
    const capture = async (action: 'open' | 'close') =>
      page.evaluate(async (action) => {
        const plus = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Open checkout"]',
        )!;
        const close = () =>
          document.querySelector<HTMLButtonElement>(
            'button[aria-label="Close checkout /demo/other"]',
          );
        const frames = [{ x: plus.getBoundingClientRect().x, inert: false, disabled: false }];
        (action === 'open' ? plus : close()!).click();
        for (let i = 0; i < 32; i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const exiting = close();
          frames.push({
            x: plus.getBoundingClientRect().x,
            inert: Boolean(exiting?.closest('[inert]')),
            disabled: exiting?.disabled ?? false,
          });
        }
        return frames;
      }, action);
    const opened = await capture('open');
    await expect(page.getByRole('tab', { name: 'other · main', exact: true })).toBeVisible();
    const closed = await capture('close');
    await expect(page.getByRole('tab', { name: 'other · main', exact: true })).toHaveCount(0);
    for (const frames of [opened, closed]) {
      const start = frames[0].x,
        end = frames.at(-1)!.x;
      expect(Math.abs(end - start)).toBeCloseTo(222, 0);
      const intermediate = frames.some(
        (frame) => frame.x > Math.min(start, end) + 1 && frame.x < Math.max(start, end) - 1,
      );
      expect(intermediate).toBe(!reducedMotion);
    }
    if (!reducedMotion) expect(closed.some((frame) => frame.inert && frame.disabled)).toBe(true);
    await mkdir(resolve('../../test-results/redesign-review'), { recursive: true });
    await writeFile(
      resolve(
        `../../test-results/redesign-review/tab-motion-${reducedMotion ? 'reduced' : 'normal'}.json`,
      ),
      JSON.stringify({ reducedMotion, opened, closed }, null, 2),
    );
    if (!reducedMotion) {
      await page.evaluate(async () => {
        const plus = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Open checkout"]',
        )!;
        const close = () =>
          document.querySelector<HTMLButtonElement>(
            'button[aria-label="Close checkout /demo/other"]',
          );
        const waitFor = async (ready: () => boolean) => {
          for (let i = 0; i < 60; i++) {
            if (ready()) return;
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          throw Error('Tab command did not settle');
        };
        plus.click();
        await waitFor(() => Boolean(close() && !close()!.disabled && !close()!.closest('[inert]')));
        close()!.click();
        await waitFor(
          () =>
            !window.demo.first.getSnapshot().recovery.openCheckoutIds.includes('other') &&
            !plus.disabled,
        );
        plus.click();
      });
      const reopened = page.getByRole('tab', { name: 'other · main', exact: true });
      await expect(reopened).toHaveAttribute('aria-selected', 'true');
      await expect(reopened.locator('..')).toHaveCSS('transform', 'none');
      await expect(page.locator('button[aria-label="Close checkout /demo/other"]')).toHaveCount(1);
      await expect(
        page.getByRole('button', { name: 'Close checkout /demo/other', exact: true }),
      ).toBeEnabled();
    }
  });
}

test('design fixture renders first-message composition, pinned navigation and compact layouts', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  const message = page.getByLabel('Message', { exact: true });
  await expect(message).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Choose working folder', exact: true }),
  ).toHaveAttribute('title', '/demo/moonbase');
  expect(
    await page
      .getByRole('main', { name: 'Agent workspace' })
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe('rgb(20, 20, 21)');
  expect(
    await page
      .getByRole('complementary', { name: 'Saved chats', exact: true })
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe('rgb(22, 22, 24)');
  expect(
    await message.evaluate((element) => element.closest('form')!.getBoundingClientRect().width),
  ).toBe(640);
  expect(
    await page
      .getByRole('tablist', { name: 'Workbench views', exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(40);
  const border = await message.evaluate((element) => {
    const style = getComputedStyle(element.closest('form')!);
    return [style.borderTopWidth, style.borderTopStyle];
  });
  expect(border).toEqual(['1px', 'solid']);
  for (const name of ['Agents', 'moonbase · main']) {
    const geometry = await page.getByRole('tab', { name, exact: true }).evaluate((element) => {
      const tab = element.parentElement!;
      const strip = element.closest('[role="tablist"]')!.getBoundingClientRect();
      const bounds = tab.getBoundingClientRect();
      const icon = element.querySelector('svg')!.getBoundingClientRect();
      const close = element.nextElementSibling!.querySelector('svg')!.getBoundingClientRect();
      const label = element.querySelector('span')!.getBoundingClientRect();
      const style = getComputedStyle(tab);
      return {
        top: bounds.top - strip.top,
        bottom: strip.bottom - bounds.bottom,
        left: icon.left - bounds.left,
        right: bounds.right - close.right,
        centers: icon.top + icon.height / 2 - (close.top + close.height / 2),
        labelGap: label.left - icon.right,
        textAlign: getComputedStyle(element).textAlign,
        radius: style.borderRadius,
        iconClass: element.querySelector('svg')!.getAttribute('class'),
      };
    });
    expect(geometry.top).toBe(4);
    expect(geometry.bottom).toBe(4);
    expect(geometry.left).toBeCloseTo(geometry.right, 1);
    expect(geometry.centers).toBeCloseTo(0, 1);
    expect(geometry.labelGap).toBe(8);
    expect(geometry.textAlign).toBe('left');
    expect(geometry.radius).toBe('8px');
    expect(geometry.iconClass).toContain('tabler-icon');
  }
  await page.screenshot({ path: '../../test-results/redesign-review/desktop.png', fullPage: true });
  await message.fill('Review the desktop shell and editor');
  await message.press('Meta+Enter');
  await expect(
    page.getByRole('heading', { name: 'Review the desktop shell and editor', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('I’ll inspect the desktop shell', { exact: false })).toBeVisible();
  await expect(message).toHaveValue('');
  expect(
    await page.evaluate(() =>
      window.demo.chat.calls.filter((call) => ['createChat', 'sendChat'].includes(call)),
    ),
  ).toEqual(['createChat', 'sendChat']);
  await page.screenshot({
    path: '../../test-results/redesign-review/conversation.png',
    fullPage: true,
  });
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'New File', exact: true }).locator('svg'),
  ).toBeVisible();
  const tree = page.getByRole('tree', { name: 'Files', exact: true });
  const folder = tree.getByRole('treeitem', { name: 'src', exact: true });
  const file = tree.getByRole('treeitem', { name: 'welcome.ts', exact: true });
  await expect(folder.locator('svg.tabler-icon-folder')).toBeVisible();
  await expect(file.locator('svg.tabler-icon-file')).toBeVisible();
  expect((await folder.getByText('src', { exact: true }).boundingBox())!.x).toBe(
    (await file.getByText('welcome.ts', { exact: true }).boundingBox())!.x,
  );
  await folder.click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await expect(folder.locator('svg.tabler-icon-folder-open')).toBeVisible();
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.screenshot({ path: '../../test-results/redesign-review/editor.png', fullPage: true });
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(message).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `../../test-results/redesign-review/${width}.png`,
      fullPage: true,
    });
  }
  await page.evaluate(() => window.demo.first.openCheckout('/demo/other'));
  await expect(
    page.getByRole('tab', { name: 'other · main', exact: true }).locator('..'),
  ).toHaveCSS('transform', 'none');
  const agents = page.getByRole('tab', { name: 'Agents', exact: true });
  const before = await agents.boundingBox();
  await page.getByRole('group', { name: 'Project tabs', exact: true }).evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  expect((await agents.boundingBox())!.x).toBe(before!.x);
  await page.getByRole('button', { name: 'Show conversations', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Conversations', exact: true })).toBeVisible();
  const close = await page
    .getByRole('button', { name: 'Close conversations', exact: true })
    .boundingBox();
  const fresh = await page
    .getByRole('dialog')
    .getByRole('button', { name: 'New chat', exact: true })
    .boundingBox();
  expect(close!.y + close!.height).toBeLessThanOrEqual(fresh!.y);
  await page.screenshot({ path: '../../test-results/redesign-review/drawer.png', fullPage: true });
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
