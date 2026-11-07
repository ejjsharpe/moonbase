import { selectFileView } from './editor-regressions.ts';
import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

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
  // The demo chat is Settled, behind a toggle that starts closed.
  await shell(page)
    .getByRole('button', { name: /^Settled/ })
    .click();
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
  await selectFileView(shell(page), 'staged');
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
  // Go to opens from the composer too; dismissing it keeps the draft and its focus.
  await expect(page.getByRole('dialog', { name: 'Go to', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(shell(page).getByLabel('Message', { exact: true })).toBeFocused();
  await expect(shell(page).getByLabel('Message', { exact: true })).toHaveValue(
    'separate chat draft',
  );
  await shell(page).getByLabel('Message', { exact: true }).press('Meta+s');
  expect(await page.evaluate(() => window.demo.memory.stats.saves)).toBe(0);
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
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
  await expect(shell(page).getByRole('textbox', { name: /^staged · .* original$/ })).toBeVisible();
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
      await selectFileView(shell(page), mode);
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
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(project(page)).toBeFocused();
  await project(page).press('Meta+s');
  await expect.poll(() => page.evaluate(() => window.demo.memory.stats.saves)).toBe(1);
  await expect(project(page)).toBeFocused();
  await project(page).press('Meta+p');
  await expect(page.getByRole('dialog', { name: 'Go to', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await project(page).focus();
  await project(page).press('Meta+w');
  await expect(shell(page).getByRole('tab', { name: 'welcome.ts', exact: true })).toHaveCount(0);
  await project(page).focus();
  await project(page).press('Meta+Shift+t');
  await expect(input(page)).toBeVisible();
});

test('switching checkouts dismisses a file menu even when the relative paths match', async ({
  page,
}) => {
  await page.goto('/?chat&design');
  await page.evaluate(async () => {
    const { first, checkout } = window.demo;
    await first.openCheckout('/demo/other');
    const other = first
      .getSnapshot()
      .recovery.checkouts.find((target) => target.checkoutId === 'other')!;
    await first.mutate({
      checkout: other,
      kind: 'create-file',
      sources: [],
      destination: 'welcome.ts',
      text: 'Other checkout',
    });
    await first.open({ checkout: other, path: 'welcome.ts' }, { intent: 'keep' });
    await first.selectCheckout(checkout);
  });
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  await page.getByRole('tab', { name: 'welcome.ts', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await page.evaluate(() => {
    const { first } = window.demo;
    return first.selectCheckout(
      first.getSnapshot().recovery.checkouts.find((target) => target.checkoutId === 'other')!,
    );
  });
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const { views } = window.demo.first.getSnapshot().recovery;
      return { sample: views.sample.openFiles, other: views.other.openFiles };
    }),
  ).toEqual({ sample: ['welcome.ts'], other: ['welcome.ts'] });
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
  await projects
    .getByRole('button', { name: 'Close checkout /demo/other', exact: true })
    .locator('..')
    .hover();
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
    expect([...new Set(frames.map((frame) => frame.top))]).toEqual([0]);
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
  await page
    .getByRole('button', { name: 'Close checkout /demo/moonbase', exact: true })
    .locator('..')
    .hover();
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
    await page
      .getByRole('button', { name: 'Close checkout /demo/other', exact: true })
      .locator('..')
      .hover();
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
  await tabs(page)
    .getByRole('button', { name: 'Close Chat panel', exact: true })
    .locator('..')
    .hover();
  await tabs(page).getByRole('button', { name: 'Close Chat panel', exact: true }).click();
  await project(page).hover();
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
  await selectFileView(shell(page), 'staged');
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
  await expect(shell(page).getByRole('textbox', { name: /^staged · .* original$/ })).toBeVisible();
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
    await tabs(page)
      .getByRole('button', { name: 'Close Chat panel', exact: true })
      .locator('..')
      .hover();
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
  await page.getByRole('button', { name: 'Close Chat panel', exact: true }).locator('..').hover();
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
  expect(
    await shell(page)
      .getByRole('tree', { name: 'Files', exact: true })
      .evaluate((element) =>
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'v',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      ),
  ).toBe(false);
  await expect(page.getByRole('dialog', { name: 'Import files', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await input(page).focus();
  expect(
    await input(page).evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'v',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
  ).toBe(true);
  await page.keyboard.insertText('controlled ordinary text paste');
  await expect(shell(page).locator('.view-lines')).toContainText('controlled ordinary text paste');
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

test('the project rail shows coded tiles and peeks at a project on hover without moving', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  const rail = page.getByRole('tablist', { name: 'Workbench views', exact: true });
  await expect(rail).toHaveCSS('box-shadow', 'rgb(35, 37, 46) -1px 0px 0px 0px inset');
  await expect(rail).toHaveCSS('width', '72px');
  await page.evaluate(() => window.demo.first.openCheckout('/demo/other'));
  const agents = page.getByRole('tab', { name: 'Agents', exact: true });
  const project = page.getByRole('tab', { name: 'moonbase · main', exact: true });
  const other = page.getByRole('tab', { name: 'other · main', exact: true });
  const closeProject = page.getByRole('button', {
    name: 'Close checkout /demo/moonbase',
    exact: true,
  });
  const peek = page
    .locator('[data-side="right"] > [data-side="right"]')
    .filter({ hasText: '/demo/moonbase' });
  const tile = (tab: typeof project) => tab.locator('[data-initials]');
  await expect(tile(project)).toHaveAttribute('data-initials', 'mo');
  await expect(tile(other)).toHaveAttribute('data-initials', 'ot');
  await other.click();
  await page.mouse.move(900, 400);
  await expect(other).toHaveCSS('color', 'rgb(220, 223, 232)');
  await expect(project).toHaveCSS('color', 'rgb(180, 184, 198)');
  await expect(agents).toHaveCSS('color', 'rgb(180, 184, 198)');
  await expect(closeProject).toHaveCSS('opacity', '0');
  await expect(peek).toBeHidden();
  const tileBounds = await tile(project).boundingBox();
  await rail.screenshot({ path: '../../test-results/redesign-review/rail-idle.png' });
  await project.hover();
  await expect(peek).toBeVisible();
  await expect(peek).toContainText('moonbase');
  await expect(peek).toContainText('main');
  await expect(peek).toContainText('memory-demo · /demo/moonbase');
  await expect(closeProject).toHaveCSS('opacity', '1');
  await expect(rail).toHaveCSS('width', '72px');
  expect(await tile(project).boundingBox()).toEqual(tileBounds);
  expect((await peek.boundingBox())!.x).toBeGreaterThanOrEqual(72);
  await page.screenshot({ path: '../../test-results/redesign-review/rail-peek.png' });
  await page.mouse.move(900, 400);
  await expect(peek).toBeHidden();
  await expect(closeProject).toHaveCSS('opacity', '0');
  await closeProject.focus();
  await expect(closeProject).toBeFocused();
  await expect(closeProject).toHaveCSS('opacity', '1');
});

test('keyboard focus on a rail tile peeks at its project', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  const peek = page
    .locator('[data-side="right"] > [data-side="right"]')
    .filter({ hasText: '/demo/moonbase' });
  await page.getByRole('tab', { name: 'Agents', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'moonbase · main', exact: true })).toBeFocused();
  await expect(peek).toBeVisible();
  await expect(peek).toContainText('moonbase');
});

test('the rail keeps one tile per project and the sidebar header switches its worktrees', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    await window.demo.first.openCheckout('/demo/other');
    await window.demo.first.openCheckout('/demo/legend-list');
  });
  const projects = page.getByRole('group', { name: 'Project tabs', exact: true });
  // The worktree takes over its repository's tile instead of adding one.
  await expect(projects.getByRole('tab')).toHaveText([
    'legend-list · feat/legend-list',
    'other · main',
  ]);
  const worktree = projects.getByRole('tab', {
    name: 'legend-list · feat/legend-list',
    exact: true,
  });
  await worktree.hover();
  await expect(
    page
      .locator('[data-side="right"] > [data-side="right"]')
      .filter({ hasText: '/demo/legend-list' }),
  ).toContainText('2 worktrees open');
  await worktree.click();
  const header = page.getByRole('button', {
    name: 'Switch worktree, legend-list · feat/legend-list',
    exact: true,
  });
  await expect(header).toBeVisible();
  await header.click();
  const menu = page.getByRole('menu', { name: 'Worktrees', exact: true });
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await expect(
    menu.getByRole('menuitem', { name: 'legend-list · feat/legend-list, current', exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: '../../test-results/redesign-review/worktree-switcher.png' });
  await menu.getByRole('menuitem', { name: 'moonbase · main', exact: true }).click();
  const project = projects.getByRole('tab', { name: 'moonbase · main', exact: true });
  await expect(project).toHaveAttribute('aria-selected', 'true');
  await expect(projects.getByRole('tab')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Switch worktree, moonbase · main', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'welcome.ts editor', exact: true })).toBeVisible();
});

test('⇧⌘G and ⇧⌘E switch the project sidebar between Changes and Files', async ({ page }) => {
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await expect(editor).toBeVisible();
  const files = page.getByRole('button', { name: 'Files', exact: true });
  const changes = page.getByRole('button', { name: 'Changes', exact: true });
  await editor.press('Shift+Meta+g');
  await expect(changes).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Staged', exact: true })).toBeVisible();
  await editor.press('Shift+Meta+e');
  await expect(files).toHaveAttribute('aria-pressed', 'true');
});

test('the project dock shows only that project’s chats, with a back arrow to their list', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const dock = page.getByRole('complementary', { name: 'Project chats', exact: true });
  await expect(dock.getByRole('heading', { name: 'New chat', exact: true })).toBeVisible();
  await expect(
    dock.getByRole('button', { name: 'Choose working folder', exact: true }),
  ).toHaveAttribute('title', '/demo/moonbase');
  // One chat view at a time: the dock's, while Agents is hidden.
  await expect(page.locator('#message')).toHaveCount(1);
  await dock.getByLabel('Message', { exact: true }).fill('Tidy the rail peek spacing');
  await dock.getByRole('button', { name: 'Send message', exact: true }).click();
  const title = dock.getByRole('heading', { name: 'Tidy the rail peek spacing', exact: true });
  await expect(title).toBeVisible();
  await dock.getByRole('button', { name: 'All moonbase chats', exact: true }).click();
  const list = dock.getByRole('navigation', { name: 'moonbase conversations', exact: true });
  const chat = list.getByRole('button', { name: /Tidy the rail peek spacing/ });
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(chat).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: '../../test-results/redesign-review/project-dock-list.png' });
  await chat.click();
  await expect(title).toBeVisible();
  await page.evaluate(() => window.demo.first.openCheckout('/demo/other'));
  await expect(
    dock.getByRole('navigation', { name: 'other conversations', exact: true }),
  ).toContainText('No chats in other yet.');
  await dock.getByRole('button', { name: 'Hide project chats', exact: true }).click();
  await expect(dock.getByRole('button', { name: 'Show project chats', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Conversations', exact: true })
      .getByRole('button', { name: /Tidy the rail peek spacing/ }),
  ).toBeVisible();
});

test('the project dock resizes by dragging or keys, expands and closes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const dock = page.getByRole('complementary', { name: 'Project chats', exact: true });
  const edge = page.getByRole('separator', { name: 'Resize project chats', exact: true });
  const width = async () => (await dock.boundingBox())!.width;
  await expect.poll(width).toBe(400);
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 150, box.y + 200, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await width()) - 550)).toBeLessThanOrEqual(2);
  await edge.press('Home');
  await expect.poll(width).toBe(320);
  // The edge sits on the dock's left, so ArrowLeft widens it.
  await edge.press('ArrowLeft');
  await expect.poll(width).toBe(340);
  const widest = Number(await edge.getAttribute('aria-valuemax'));
  await dock.getByRole('button', { name: 'Expand project chats', exact: true }).click();
  await expect.poll(width).toBe(widest);
  await page.screenshot({ path: '../../test-results/redesign-review/project-dock-expanded.png' });
  await dock.getByRole('button', { name: 'Restore project chats width', exact: true }).click();
  await expect.poll(width).toBe(340);
  await dock.getByRole('button', { name: 'Hide project chats', exact: true }).click();
  await expect.poll(width).toBe(44);
  await page.getByRole('textbox', { name: 'welcome.ts editor', exact: true }).press('Meta+j');
  await expect.poll(width).toBe(340);
});

test('removing a middle project moves survivors smoothly up the rail', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.evaluate(() => window.demo.first.openCheckout('/demo/other'));
  const other = page.getByRole('tab', { name: 'other · main', exact: true });
  await expect(other.locator('..')).toHaveCSS('transform', 'none');
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  await page.mouse.move(900, 400);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
  const read = () =>
    page.evaluate(() => {
      const survivor = document.querySelector<HTMLElement>(
        '[role="tab"][aria-label="other · main"]',
      )!.parentElement!;
      const plus = document.querySelector<HTMLElement>('button[aria-label="Open checkout"]')!;
      const bounds = survivor.getBoundingClientRect();
      return {
        at: performance.now(),
        x: bounds.x,
        y: bounds.y,
        plus: plus.getBoundingClientRect().y,
      };
    });
  const frames = [await read()];
  await page.evaluate(() => {
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Close checkout /demo/moonbase"]')!
      .click();
  });
  for (let i = 0; i < 32; i++) {
    await page.clock.runFor(16);
    frames.push(await read());
  }
  await mkdir(test.info().outputDir, { recursive: true });
  const framesPath = test.info().outputPath('middle-project-motion-frames.json');
  await writeFile(framesPath, JSON.stringify(frames, null, 2));
  await test
    .info()
    .attach('middle-project-motion-frames', { path: framesPath, contentType: 'application/json' });
  const first = frames[0],
    last = frames.at(-1)!;
  expect(first.y - last.y).toBeCloseTo(52, 0);
  expect(frames.some((frame) => frame.y < first.y - 1 && frame.y > last.y + 1)).toBe(true);
  for (let i = 1; i < frames.length; i++) {
    expect(frames[i].x).toBeCloseTo(first.x, 1);
    expect(frames[i].y).toBeLessThanOrEqual(frames[i - 1].y + 1);
    expect(frames[i].y).toBeGreaterThanOrEqual(last.y - 1);
    expect(frames[i].plus).toBeLessThanOrEqual(frames[i - 1].plus + 1);
  }
  await page.clock.resume();
});

for (const reducedMotion of [false, true]) {
  test(`project addition and removal ${reducedMotion ? 'respect reduced motion' : 'slide neighboring rail rows'}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
    await page.clock.install();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?local&design');
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    await page.evaluate(() => {
      window.demo.selectCheckout = async () => '/demo/other';
    });
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000));
    const capture = async (action: 'open' | 'close') => {
      const frames = [
        await page.evaluate((action) => {
          const plus = document.querySelector<HTMLButtonElement>(
            'button[aria-label="Open checkout"]',
          )!;
          const frame = {
            at: performance.now(),
            y: plus.getBoundingClientRect().y,
            inert: false,
            disabled: false,
          };
          (action === 'open'
            ? plus
            : document.querySelector<HTMLButtonElement>(
                'button[aria-label="Close checkout /demo/other"]',
              )!
          ).click();
          return frame;
        }, action),
      ];
      for (let i = 0; i < 32; i++) {
        await page.clock.runFor(16);
        frames.push(
          await page.evaluate(() => {
            const plus = document.querySelector<HTMLButtonElement>(
              'button[aria-label="Open checkout"]',
            )!;
            const exiting = document.querySelector<HTMLButtonElement>(
              'button[aria-label="Close checkout /demo/other"]',
            );
            return {
              at: performance.now(),
              y: plus.getBoundingClientRect().y,
              inert: Boolean(exiting?.closest('[inert]')),
              disabled: exiting?.disabled ?? false,
            };
          }),
        );
      }
      return frames;
    };
    const opened = await capture('open');
    await expect(page.getByRole('tab', { name: 'other · main', exact: true })).toBeVisible();
    const closed = await capture('close');
    await expect(page.getByRole('tab', { name: 'other · main', exact: true })).toHaveCount(0);
    await mkdir(test.info().outputDir, { recursive: true });
    const framesPath = test.info().outputPath('rail-motion-frames.json');
    await writeFile(framesPath, JSON.stringify({ reducedMotion, opened, closed }, null, 2));
    await test
      .info()
      .attach('rail-motion-frames', { path: framesPath, contentType: 'application/json' });
    for (const frames of [opened, closed]) {
      const start = frames[0].y,
        end = frames.at(-1)!.y;
      expect(Math.abs(end - start)).toBeCloseTo(52, 0);
      const intermediate = frames.some(
        (frame) => frame.y > Math.min(start, end) + 1 && frame.y < Math.max(start, end) - 1,
      );
      expect(intermediate).toBe(!reducedMotion);
    }
    if (!reducedMotion) expect(closed.some((frame) => frame.inert && frame.disabled)).toBe(true);
    await page.clock.resume();
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
          throw Error('Rail command did not settle');
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
      await reopened.hover();
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
  await expect(
    page.getByRole('heading', { name: 'What should we work on?', exact: true }),
  ).toBeVisible();
  const folderChoice = page.getByRole('button', { name: 'Choose working folder', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  // The folder, host and model sit in the composer's own toolbar, on the send button's row.
  expect(await folderChoice.evaluate((element) => !!element.closest('form'))).toBe(true);
  await folderChoice.click();
  await expect(folderChoice).toHaveAttribute('title', '/demo/moonbase');
  await expect(folderChoice.getByText('moonbase', { exact: true })).toBeVisible();
  await expect(folderChoice.locator('[data-initials="mo"]')).toBeVisible();
  const [folderBox, sendBox] = await Promise.all([folderChoice.boundingBox(), send.boundingBox()]);
  expect(
    Math.abs(folderBox!.y + folderBox!.height / 2 - (sendBox!.y + sendBox!.height / 2)),
  ).toBeLessThan(2);
  expect(
    await page
      .getByRole('main', { name: 'Agent workspace' })
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe('rgb(20, 21, 27)');
  expect(
    await page
      .getByRole('complementary', { name: 'Saved chats', exact: true })
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe('rgb(11, 12, 16)');
  expect(
    await message.evaluate((element) => element.closest('form')!.getBoundingClientRect().width),
  ).toBe(720);
  expect(
    await page
      .getByRole('tablist', { name: 'Workbench views', exact: true })
      .evaluate((element) => element.getBoundingClientRect().width),
  ).toBe(72);
  const border = await message.evaluate((element) => {
    const style = getComputedStyle(element.closest('form')!);
    return [style.borderTopWidth, style.borderTopStyle];
  });
  expect(border).toEqual(['1px', 'solid']);
  for (const name of ['Agents', 'moonbase · main']) {
    const geometry = await page.getByRole('tab', { name, exact: true }).evaluate((element) => {
      const rail = element.closest('[role="tablist"]')!.getBoundingClientRect();
      const tile = element.querySelector('span')!;
      const bounds = tile.getBoundingClientRect();
      const close = element.nextElementSibling!.getBoundingClientRect();
      return {
        size: [bounds.width, bounds.height],
        left: bounds.left - rail.left,
        right: rail.right - bounds.right,
        // The close button is centred on the tile's top-right corner, nudged 4px down.
        closeX: close.left + close.width / 2 - bounds.right,
        closeY: close.top + close.height / 2 - bounds.top,
        radius: getComputedStyle(tile).borderRadius,
      };
    });
    expect(geometry.size).toEqual([40, 40]);
    expect(geometry.left).toBe(16);
    expect(geometry.right).toBe(16);
    expect(geometry.closeX).toBeCloseTo(0, 1);
    expect(geometry.closeY).toBeCloseTo(4, 1);
    expect(geometry.radius).toBe('9px');
  }
  expect(
    await page
      .getByRole('tab', { name: 'Agents', exact: true })
      .locator('svg')
      .getAttribute('class'),
  ).toContain('tabler-icon');
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
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
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

test('⌘P jumps between chats, projects and files, and > runs app commands', async ({ page }) => {
  await page.goto('/?chat');
  await chat(page);
  const message = shell(page).getByLabel('Message', { exact: true });
  await message.press('Meta+p');
  const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
  await expect(goTo.getByRole('option', { name: 'welcome.ts', exact: true })).toBeVisible();
  await expect(goTo.getByRole('option', { name: 'Conversation', exact: true })).toBeVisible();
  await expect(goTo.getByRole('option', { name: 'moonbase', exact: true })).toContainText('main');
  await goTo.getByRole('combobox').fill('welc');
  await page.keyboard.press('Enter');
  await expect(goTo).toHaveCount(0);
  // A file opened from Agents brings its project into view with the editor focused.
  await expect(project(page)).toHaveAttribute('aria-selected', 'true');
  await expect(input(page)).toBeFocused();
  await page.keyboard.press('Meta+Shift+p');
  await expect(goTo.getByRole('option', { name: 'Hide project chats', exact: true })).toContainText(
    '⌘J',
  );
  await goTo.getByRole('combobox').fill('>agents');
  await page.keyboard.press('Enter');
  await expect(tabs(page).getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await message.press('Meta+p');
  await goTo.getByRole('combobox').fill('>new chat');
  await page.keyboard.press('Enter');
  await expect(message).toBeFocused();
  await expect(message).toHaveValue('');
  await message.press('Meta+p');
  await goTo.getByRole('combobox').fill('conv');
  await expect(goTo.getByRole('option').first()).toHaveAccessibleName('Conversation');
  await page.keyboard.press('Enter');
  await expect(goTo).toHaveCount(0);
  // The chat opens; it is Settled, so the sidebar keeps it behind the closed toggle.
  await expect(
    shell(page).getByRole('heading', { level: 1, name: 'Conversation', exact: true }),
  ).toBeVisible();
});

test('@ in the composer searches the chat folder and sends picked files as mentions', async ({
  page,
}) => {
  await page.goto('/?chat');
  await chat(page);
  const message = shell(page).getByRole('textbox', { name: 'Message', exact: true });
  const files = shell(page).getByRole('listbox', { name: 'Files', exact: true });
  await message.fill('Compare @vie');
  await expect(files.getByRole('option').first()).toHaveAccessibleName(/view\.tsx/);
  await expect(message).toHaveAttribute('aria-activedescendant', /option-0$/);
  await message.press('Enter');
  await expect(message).toHaveValue('Compare @apps/desktop/src/renderer/chat/view.tsx ');
  await expect(files).toBeHidden();
  await message.pressSequentially('with @rel');
  await expect(files.getByRole('option').first()).toHaveAccessibleName(/Release notes\.md/);
  // Escape closes only the picker; the @ text stays as typed.
  await message.press('Escape');
  await expect(files).toBeHidden();
  await expect(message).toHaveValue(/with @rel$/);
  await message.pressSequentially('e');
  await message.press('ArrowDown');
  await message.press('ArrowUp');
  await message.press('Tab');
  await expect(message).toHaveValue(
    'Compare @apps/desktop/src/renderer/chat/view.tsx with @"docs/Release notes.md" ',
  );
  await expect(shell(page).locator('mark')).toHaveCount(2);
  // Backspace at a mention's end removes the whole mention.
  await message.press('Backspace');
  await message.press('Backspace');
  await expect(message).toHaveValue('Compare @apps/desktop/src/renderer/chat/view.tsx with ');
  await expect(shell(page).locator('mark')).toHaveCount(1);
  await message.pressSequentially('care');
  await message.press('ControlOrMeta+Enter');
  await expect(message).toHaveValue('');
  expect(await page.evaluate(() => window.demo.chat.sent.at(-1))).toMatchObject({
    text: 'Compare @apps/desktop/src/renderer/chat/view.tsx with care',
    mentions: [{ path: 'apps/desktop/src/renderer/chat/view.tsx' }],
  });
});

test('/ at the start of a message lists commands that switch model and effort, clear or start a chat', async ({
  page,
}) => {
  await page.goto('/?local&design');
  const model = page.getByRole('combobox', { name: 'Conversation model', exact: true });
  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true });
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  const commands = page.getByRole('listbox', { name: 'Commands', exact: true });
  await expect(effort).toContainText('Medium');
  await message.fill('/');
  await expect(commands.getByRole('option')).toHaveText([/^\/model/, /^\/effort/, /^\/clear/]);
  await message.press('ArrowDown');
  await message.press('Enter');
  await expect(message).toHaveValue('/effort ');
  const efforts = page.getByRole('listbox', { name: 'Reasoning efforts', exact: true });
  await expect(efforts.getByRole('option', { name: 'Medium Current' })).toBeVisible();
  await message.pressSequentially('hi');
  await expect(efforts.getByRole('option')).toHaveText(['High']);
  await message.press('Enter');
  await expect(message).toHaveValue('');
  await expect(effort).toContainText('High');
  // A typed command runs on Send instead of reaching the agent; the lines after it stay.
  await message.fill('/model coding\nKeep this');
  await message.press('ControlOrMeta+Enter');
  await expect(model).toContainText('Demo coding model');
  await expect(message).toHaveValue('Keep this');
  await message.fill('/stop');
  await message.press('ControlOrMeta+Enter');
  await expect(page.getByRole('alert').filter({ hasText: '/stop' })).toHaveText(
    "/stop isn't available here.",
  );
  await expect(message).toHaveValue('/stop');
  // The error belongs to that line; editing it hides the error.
  await message.fill('Fix the login bug');
  await expect(page.getByRole('alert').filter({ hasText: '/stop' })).toBeHidden();
  // A / typed before existing text lists nothing, so picking cannot replace that text.
  await message.press('Home');
  await message.pressSequentially('/');
  await expect(commands).toBeHidden();
  await expect(message).toHaveValue('/Fix the login bug');
  await message.fill('/cl');
  await message.press('Enter');
  await expect(message).toHaveValue('');
  await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
  await message.fill('Start a chat');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('demo-coding · Medium', { exact: true })).toBeVisible();
  await message.fill('/ne');
  await expect(commands.getByRole('option')).toHaveText([/^\/new/]);
  await message.press('Tab');
  await expect(page.getByText('What should we work on?')).toBeVisible();
  await expect(model).toContainText('Demo coding model');
});

test('a new worktree is made only when a new chat sends, and its chat stays with the project', async ({
  page,
}) => {
  await page.goto('/?local&design');
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  const worktree = page.getByRole('combobox', { name: 'Worktree', exact: true });
  await expect(message).toHaveAttribute(
    'placeholder',
    'Describe a task — @ to mention files, / for commands',
  );
  // A local folder chosen in Agents.
  await expect(worktree).toBeHidden();
  await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
  await worktree.click();
  await page.getByRole('option', { name: 'New worktree', exact: true }).click();
  await message.fill("Tidy the composer's spacing");
  expect(await page.evaluate(() => window.demo.chat.worktrees)).toEqual([]);
  await message.press('ControlOrMeta+Enter');
  await expect(
    page.getByRole('heading', { name: "Tidy the composer's spacing", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().snapshot?.conversation.cwd,
    ),
  ).toBe('/demo/moonbase-worktrees/chat-tidy-the-composers-spacing');
  expect(await page.evaluate(() => window.demo.chat.worktrees)).toEqual([
    '/demo/moonbase chat/tidy-the-composers-spacing',
  ]);
  // A project's docked chat: the worktree joins the switcher and the chat stays in the dock.
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const dock = page.getByRole('main', { name: 'Agent workspace', exact: true });
  await expect(dock.getByText('In moonbase', { exact: true })).toBeVisible();
  await dock.getByRole('combobox', { name: 'Worktree', exact: true }).click();
  await page.getByRole('option', { name: 'New worktree', exact: true }).click();
  await dock.getByRole('textbox', { name: 'Message', exact: true }).fill('Fix the rail peek');
  await dock.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(dock.getByRole('heading', { name: 'Fix the rail peek', exact: true })).toBeVisible();
  await expect(dock.getByTitle(/moonbase-worktrees\/chat-fix-the-rail-peek/)).toBeVisible();
  await page.getByRole('button', { name: /^Switch worktree, moonbase/ }).click();
  await expect(
    page.getByRole('menuitem', { name: /chat-fix-the-rail-peek · chat\/fix-the-rail-peek/ }),
  ).toBeVisible();
});

test('Settings holds hosts and providers; the sidebar keeps only a Connect line', async ({
  page,
}) => {
  await page.goto('/?chat');
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  const sidebar = shell(page).getByRole('complementary', { name: 'Saved chats', exact: true });
  await expect(sidebar.getByRole('status')).toHaveText('Not connected');
  await expect(sidebar.getByText('Connection details', { exact: true })).toHaveCount(0);
  await shell(page).getByLabel('Message', { exact: true }).press('Meta+,');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const hosts = settings.getByRole('list', { name: 'Chat hosts', exact: true });
  await expect(hosts.getByRole('status')).toHaveText('Disconnected');
  await hosts.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(hosts.getByRole('button', { name: 'Disconnect', exact: true })).toBeEnabled();
  await expect(settings).toContainText('Remote work continues until you Stop it.');
  await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
  await expect(settings).toContainText('A remote host signs in to model providers itself.');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  // Connected, the Connect line goes and the chats are listed.
  await expect(sidebar.getByRole('status')).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: /^Settled/ })).toHaveText(/Settled\s*1/);
});

test('the local model menu opens provider setup in Settings', async ({ page }) => {
  await page.goto('/?local');
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  await shell(page).getByRole('combobox', { name: 'Conversation model', exact: true }).click();
  await page.getByRole('button', { name: 'Set up providers…', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('tab', { name: 'Providers', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    settings.getByRole('button', { name: 'Refresh providers', exact: true }),
  ).toBeVisible();
  // Each vendor is a card listing its ways to connect, each with its state and one action.
  const vendor = settings
    .getByRole('list', { name: 'Model providers', exact: true })
    .getByRole('listitem', { name: 'OpenAI', exact: true });
  await expect(vendor).toContainText('1 connected');
  const key = vendor.getByRole('listitem', { name: 'Demo provider', exact: true });
  await expect(key).toContainText('API key');
  await expect(key).toContainText('2 models');
  await expect(
    key.getByRole('button', { name: 'Remove key for Demo provider', exact: true }),
  ).toBeVisible();
  await settings.getByRole('tab', { name: 'Hosts', exact: true }).click();
  await expect(settings.getByRole('status').first()).toHaveText('Local ready');
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await shell(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings).toBeVisible();
});

test('the chats sidebar orders by activity: Ready, Working, then a Settled toggle', async ({
  page,
}) => {
  await page.goto('/?chat&activity');
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  await shell(page).getByRole('button', { name: 'Connect', exact: true }).click();
  const list = shell(page).getByRole('navigation', { name: 'Conversations', exact: true });
  await expect(list.getByRole('heading', { name: 'Ready 4' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Working 2' })).toBeVisible();
  const rows = list.getByRole('button', { pressed: false });
  await expect(rows.nth(0)).toContainText('Fix the dock resize handle');
  await expect(rows.nth(0)).toContainText('moonbase · failed');
  await expect(rows.nth(1)).toContainText('Summarise this repository');
  await expect(rows.nth(1)).toContainText('finished');
  await expect(rows.nth(2)).toContainText('stopped');
  await expect(rows.nth(4)).toContainText('Move the transcript to Legend List');
  await expect(rows.nth(4)).toContainText('running');
  const settled = list.getByRole('button', { name: /^Settled/ });
  await expect(settled).toHaveAttribute('aria-expanded', 'false');
  // The chat seen before anything else listed is settled and hidden behind the toggle.
  await expect(list.getByRole('button', { name: /^Conversation/ })).toHaveCount(0);
  // Opening a Ready chat settles it; it stays in view under the closed toggle while it is open.
  await list.getByRole('button', { name: /^Summarise this repository/ }).click();
  await expect(list.getByRole('heading', { name: 'Ready 3' })).toBeVisible();
  await expect(settled).toHaveText(/Settled\s*2/);
  await expect(list.getByRole('button', { name: /^Summarise this repository/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Closed, the toggle sits at the foot of the list.
  const bottom = async (locator: typeof list) => {
    const box = (await locator.boundingBox())!;
    return box.y + box.height;
  };
  expect((await bottom(list)) - (await bottom(settled))).toBeLessThan(80);
  await settled.click();
  await expect(settled).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByRole('button', { name: /^Conversation/ })).toBeVisible();
  await settled.click();
  await expect(settled).toHaveAttribute('aria-expanded', 'false');
  await expect(list.getByRole('button', { name: /^Conversation/ })).toHaveCount(0);
  await settled.click();
  // The toggle is remembered.
  await page.reload();
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  await shell(page).getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(list.getByRole('button', { name: /^Settled/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  // ⌘N starts a new chat from anywhere in the shell.
  await project(page).click();
  await project(page).press('Meta+n');
  await expect(shell(page).getByLabel('Message', { exact: true })).toBeFocused();
  await expect(tabs(page).getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
