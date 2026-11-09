import { selectFileView } from './editor-regressions.ts';
import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

/** Opens the composer's folder menu and chooses a folder with the native picker. */
async function chooseFolderNatively(page: Page) {
  await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
  await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
}

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
  await shell(page).getByLabel('Message', { exact: true }).press('ControlOrMeta+p');
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
  await project(page).press('ControlOrMeta+p');
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
  // A closed project reopens from +'s menu, without the native picker.
  await projects.getByRole('button', { name: 'Open checkout', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Open project', exact: true })
    .getByRole('button', { name: /^other/ })
    .click();
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
    // Views sit under the title bar.
    expect([...new Set(frames.map((frame) => frame.top))]).toEqual([44]);
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
  // moonbase is closed, so + offers it in a menu; Open folder… is the native picker.
  const openFolder = async () => {
    await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
    await page.getByRole('button', { name: 'Open folder…', exact: true }).click();
  };
  await openFolder();
  const error = page.getByRole('alert').filter({ hasText: 'Controlled empty Open failure' });
  await expect(error).toBeVisible();
  await error.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(error).toHaveCount(0);
  await openFolder();
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
  // The chat view offers no file actions; the explorer's are behind its own menu.
  await expect(
    shell(page).getByRole('button', { name: 'Explorer actions', exact: true }),
  ).toHaveCount(0);
});

test('local model and effort defaults yield to preferences across new chats and panel reopening', async ({
  page,
}) => {
  await page.goto('/?local&design');
  // One chip shows the model and its effort; its popover chooses both.
  const model = page.getByRole('button', { name: 'Chat model', exact: true });
  const effort = model;
  const picker = page.getByRole('dialog', { name: 'Choose model', exact: true });
  await expect(model).toContainText('Demo model');
  await expect(effort).toContainText('Medium');
  await model.click();
  await expect(picker.getByRole('button', { name: 'OpenAI', exact: false })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await picker.getByRole('button', { name: 'Demo coding model', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await model.click();
  await picker.getByRole('radio', { name: 'Extra high', exact: true }).click();
  await expect(picker.getByRole('radio', { name: 'Extra high', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  await chooseFolderNatively(page);
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
  await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toBeEnabled();
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
  await chooseFolderNatively(page);
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
    shell(page).getByRole('button', { name: 'Explorer actions', exact: true }).locator('svg'),
  ).toBeVisible();
});

test('files dropped on the tree import into its folder once; elsewhere they import at the root', async ({
  page,
}) => {
  await page.goto('/?chat');
  await project(page).click();
  const calls = () =>
    page.evaluate(
      () => (window as unknown as { drops: { approved: string[][]; imported: unknown[] } }).drops,
    );
  await page.evaluate(() => {
    const drops = { approved: [] as string[][], imported: [] as unknown[] };
    Object.assign(window, { drops });
    window.demo.selectDroppedImports = async (_checkout, files) => {
      drops.approved.push(files.map((file) => file.name));
      return files.map((file) => `ref:${file.name}`);
    };
    // The demo workspace has no native file authority; record the import instead.
    const { first } = window.demo,
      mutate = first.mutate.bind(first);
    first.mutate = async (input) => {
      if (input.kind !== 'import') return mutate(input);
      drops.imported.push({
        destination: input.destination,
        nativeReferences: input.nativeReferences,
      });
      return {
        ...input,
        id: input.id!,
        clientId: first.clientId,
        recoveryChanges: [],
        outcome: 'completed',
        items: [],
      };
    };
  });
  /** Drops a Finder file named `name` on `selector`, as the OS does. */
  const drop = (selector: string, name: string) =>
    page.evaluate(
      ({ selector, name }) => {
        const target = document.querySelector(selector)!,
          dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(['x'], name));
        for (const type of ['dragenter', 'dragover', 'drop'])
          target.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }),
          );
      },
      { selector, name },
    );
  const src = shell(page).getByRole('treeitem', { name: /^src(,|$)/ });
  await drop(`[id="${await src.getAttribute('id')}"]`, 'a.txt');
  await expect.poll(calls).toEqual({
    approved: [['a.txt']],
    imported: [{ destination: 'src/a.txt', nativeReferences: ['ref:a.txt'] }],
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Outside the tree, the window still takes a drop and imports it at the root.
  await drop('[aria-label="Window title bar"]', 'b.txt');
  await expect(page.getByRole('dialog', { name: 'Import files', exact: true })).toBeVisible();
  expect((await calls()).approved).toEqual([['a.txt'], ['b.txt']]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await calls()).imported).toHaveLength(1);
});

test('files dropped on an open file’s tab import at the root', async ({ page }) => {
  await page.goto('/?chat');
  await project(page).click();
  await page.evaluate(() => {
    const approved: string[][] = [];
    Object.assign(window, { approved });
    window.demo.selectDroppedImports = async (_checkout, files) => {
      approved.push(files.map((file) => file.name));
      return files.map((file) => `ref:${file.name}`);
    };
  });
  const tab = shell(page).getByRole('tab', { name: 'welcome.ts', exact: true });
  await expect(tab).toBeVisible();
  // Tabs reorder only tab drags; a Finder drop on one is still the window's.
  await page.evaluate(() => {
    const target = document.querySelector('[role="tab"][aria-label="welcome.ts"]')!,
      dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['x'], 'a.txt'));
    for (const type of ['dragenter', 'dragover', 'drop'])
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
  });
  await expect(page.getByRole('dialog', { name: 'Import files', exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { approved: string[][] }).approved),
  ).toEqual([['a.txt']]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Import files', exact: true })).toHaveCount(0);
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
  // The rail is part of the window's frame: the title bar's colour, with no edge of its own.
  await expect(rail).toHaveCSS('background-color', 'rgb(11, 12, 16)');
  await expect(rail).toHaveCSS('box-shadow', 'none');
  await expect(rail).toHaveCSS('width', '52px');
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
  await expect(rail).toHaveCSS('width', '52px');
  expect(await tile(project).boundingBox()).toEqual(tileBounds);
  expect((await peek.boundingBox())!.x).toBeGreaterThanOrEqual(52);
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
  // Inside the editor ⇧⌘G stays Monaco's Find Previous.
  await editor.press('Shift+Meta+g');
  await expect(files).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('tree', { name: 'Files', exact: true }).press('Shift+Meta+g');
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
  await expect(
    page.getByRole('button', { name: 'Toggle project chats', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Conversations', exact: true })
      .getByRole('button', { name: /Tidy the rail peek spacing/ }),
  ).toBeVisible();
});

test('the file menu mentions files in the dock’s chat and copies and reveals through the shell', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const dock = page.getByRole('complementary', { name: 'Project chats', exact: true });
  const message = dock.getByLabel('Message', { exact: true });
  await message.fill('Look at');
  await dock.getByRole('button', { name: 'Hide project chats', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Files', exact: true });
  const fileMenu = page.getByRole('menu', { name: 'File actions', exact: true });
  await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click({ button: 'right' });
  await fileMenu.getByRole('menuitem', { name: 'Mention in Chat', exact: true }).click();
  // The hidden dock opens with the draft kept, the mention after it and the caret at the end.
  await expect(message).toBeFocused();
  await expect(message).toHaveValue('Look at @README.md ');
  expect(await message.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(
    'Look at @README.md '.length,
  );
  // A file already mentioned isn't repeated.
  await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await tree.press('Shift+ArrowDown');
  await tree.press('ContextMenu');
  await fileMenu.getByRole('menuitem', { name: 'Mention 2 Files in Chat', exact: true }).click();
  await expect(message).toHaveValue('Look at @README.md @welcome.ts ');
  // Right-clicking inside a selection keeps it, so select one file first.
  await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await tree.getByRole('treeitem', { name: 'README.md', exact: true }).click({ button: 'right' });
  await fileMenu.getByRole('menuitem', { name: 'Copy Path', exact: true }).click();
  await expect(tree).toBeFocused();
  await tree.press('ControlOrMeta+Alt+r');
  expect(await page.evaluate(() => [window.demo.copied, window.demo.revealed])).toEqual([
    ['/demo/moonbase/README.md'],
    ['/demo/moonbase/README.md'],
  ]);
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
  await expect.poll(width).toBe(0);
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
  expect(first.y - last.y).toBeCloseTo(40, 0);
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
      expect(Math.abs(end - start)).toBeCloseTo(40, 0);
      const intermediate = frames.some(
        (frame) => frame.y > Math.min(start, end) + 1 && frame.y < Math.max(start, end) - 1,
      );
      expect(intermediate).toBe(!reducedMotion);
    }
    if (!reducedMotion) expect(closed.some((frame) => frame.inert && frame.disabled)).toBe(true);
    await page.clock.resume();
    if (!reducedMotion) {
      await page.evaluate(async () => {
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
        // Closed, the project is offered again in +'s menu; + is a new button once it has one.
        const open = () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Open checkout"]')!;
        const recent = () =>
          [
            ...document.querySelectorAll<HTMLButtonElement>('[aria-label="Open project"] button'),
          ].find((button) => button.textContent?.startsWith('other'));
        const reopen = async () => {
          open().click();
          await waitFor(() => Boolean(recent()));
          recent()!.click();
        };
        await reopen();
        await waitFor(() => Boolean(close() && !close()!.disabled && !close()!.closest('[inert]')));
        close()!.click();
        await waitFor(
          () =>
            !window.demo.first.getSnapshot().recovery.openCheckoutIds.includes('other') &&
            !open().disabled,
        );
        await reopen();
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
  await expect(folderChoice).toHaveText(/^No project/);
  // The menu offers the editor's projects and folders chosen before, without the native picker.
  await folderChoice.click();
  const folders = page.getByRole('dialog', { name: 'Working folder', exact: true });
  await expect(folders.getByRole('group', { name: 'Projects' }).getByRole('button')).toHaveText([
    /^moonbase\s*main\s*open/,
  ]);
  await expect(
    folders.getByRole('group', { name: 'Recent folders' }).getByRole('button'),
  ).toHaveText([/^notes\s*~/]);
  await folders.getByRole('button', { name: /^notes/ }).click();
  await expect(folders).toBeHidden();
  await expect(folderChoice).toHaveAttribute('title', '/Users/demo/notes');
  await folderChoice.click();
  await expect(folders.getByRole('button', { name: /^notes/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await folders.getByRole('button', { name: /^moonbase/ }).click();
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
  ).toBe('rgb(15, 16, 21)');
  expect(
    await message.evaluate((element) => element.closest('form')!.getBoundingClientRect().width),
  ).toBe(720);
  expect(
    await page
      .getByRole('tablist', { name: 'Workbench views', exact: true })
      .evaluate((element) => element.getBoundingClientRect().width),
  ).toBe(52);
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
    expect(geometry.size).toEqual([32, 32]);
    expect(geometry.left).toBe(10);
    expect(geometry.right).toBe(10);
    expect(geometry.closeX).toBeCloseTo(0, 1);
    expect(geometry.closeY).toBeCloseTo(4, 1);
    expect(geometry.radius).toBe('8px');
  }
  expect(
    await page
      .getByRole('tab', { name: 'Agents', exact: true })
      .locator('svg')
      .getAttribute('class'),
  ).toContain('tabler-icon');
  await page.screenshot({ path: '../../test-results/redesign-review/desktop.png', fullPage: true });
  await message.fill('Review the desktop shell and editor');
  await message.press('Enter');
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
    page.getByRole('button', { name: 'Explorer actions', exact: true }).locator('svg'),
  ).toBeVisible();
  const tree = page.getByRole('tree', { name: 'Files', exact: true });
  const folder = tree.getByRole('treeitem', { name: 'src', exact: true });
  const file = tree.getByRole('treeitem', { name: 'welcome.ts, modified', exact: true });
  await expect(folder.locator('svg.tabler-icon-folder')).toBeVisible();
  await expect(file.locator('svg.tabler-icon-brand-typescript')).toBeVisible();
  expect((await folder.getByText('src', { exact: true }).boundingBox())!.x).toBe(
    (await file.getByText('welcome.ts', { exact: true }).boundingBox())!.x,
  );
  await folder.click();
  await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await expect(folder.locator('svg.tabler-icon-folder-open')).toBeVisible();
  await page.getByRole('button', { name: 'Changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Explorer actions', exact: true })).toBeVisible();
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
  await message.press('ControlOrMeta+p');
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
  await page.keyboard.press('ControlOrMeta+Shift+p');
  await expect(goTo.getByRole('option', { name: 'Hide project chats', exact: true })).toContainText(
    '⌘J',
  );
  await goTo.getByRole('combobox').fill('>agents');
  await page.keyboard.press('Enter');
  await expect(tabs(page).getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await message.press('ControlOrMeta+p');
  await goTo.getByRole('combobox').fill('>new chat');
  await page.keyboard.press('Enter');
  await expect(message).toBeFocused();
  await expect(message).toHaveValue('');
  await message.press('ControlOrMeta+p');
  await goTo.getByRole('combobox').fill('conv');
  await expect(goTo.getByRole('option').first()).toHaveAccessibleName('Conversation');
  await page.keyboard.press('Enter');
  await expect(goTo).toHaveCount(0);
  // The chat opens.
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
  await expect(files.getByRole('option').first()).not.toHaveAttribute('aria-disabled');
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
  await expect(files.getByRole('option').first()).not.toHaveAttribute('aria-disabled');
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
  // Shift+Enter adds a line; Enter sends.
  await message.press('Shift+Enter');
  await expect(message).toHaveValue('Compare @apps/desktop/src/renderer/chat/view.tsx with care\n');
  await message.press('Backspace');
  await message.press('Enter');
  await expect(message).toHaveValue('');
  // Enter in an empty composer neither sends nor adds a line.
  await message.press('Enter');
  await expect(message).toHaveValue('');
  await expect(page.getByText('Write a message before sending.')).toBeHidden();
  expect(await page.evaluate(() => window.demo.chat.sent.at(-1))).toMatchObject({
    text: 'Compare @apps/desktop/src/renderer/chat/view.tsx with care',
    mentions: [{ path: 'apps/desktop/src/renderer/chat/view.tsx' }],
  });
});

test('/ at the start of a message lists commands that switch model and effort, clear or start a chat', async ({
  page,
}) => {
  await page.goto('/?local&design');
  const model = page.getByRole('button', { name: 'Chat model', exact: true });
  const effort = model;
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
  await message.press('Enter');
  await expect(model).toContainText('Demo coding model');
  await expect(message).toHaveValue('Keep this');
  await message.fill('/stop');
  await message.press('Enter');
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
  await chooseFolderNatively(page);
  await message.fill('Start a chat');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('demo-coding · Medium', { exact: true })).toBeVisible();
  await message.fill('/ne');
  await expect(commands.getByRole('option')).toHaveText([/^\/new/]);
  await message.press('Tab');
  await expect(page.getByText('What should we work on?')).toBeVisible();
  await expect(model).toContainText('Demo coding model');
});

test('a new chat sends without a project and lists as No project', async ({ page }) => {
  await page.goto('/?local&design');
  const folderChoice = page.getByRole('button', { name: 'Choose working folder', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const folders = page.getByRole('dialog', { name: 'Working folder', exact: true });
  const noProject = folders.getByRole('button', { name: /^No project/ });
  await expect(folderChoice).toHaveText(/^No project/);
  await expect(page.getByText(/^Runs in a new empty folder/)).toBeVisible();
  // A chosen folder can be put back to none from the same menu.
  await folderChoice.click();
  await expect(noProject).toHaveAttribute('aria-pressed', 'true');
  await folders.getByRole('button', { name: /^moonbase/ }).click();
  await expect(folderChoice).toHaveAttribute('title', '/demo/moonbase');
  await folderChoice.click();
  await expect(noProject).toHaveAttribute('aria-pressed', 'false');
  await noProject.click();
  await expect(folders).toBeHidden();
  await expect(folderChoice).toHaveText(/^No project/);
  await page.getByLabel('Message', { exact: true }).fill('Plan a trip');
  await send.click();
  await expect
    .poll(() => page.evaluate(() => window.demo.chat.snapshot.conversation.ownFolder))
    .toBe(true);
  const saved = page.getByRole('complementary', { name: 'Saved chats', exact: true });
  await expect(saved.getByRole('button', { name: /^Plan a trip/ })).toContainText('No project');
  // A failure is shown in the open chat, which stays as it was.
  const turn = page.getByRole('button', { name: 'Turn into project', exact: true });
  await page.evaluate(() => {
    const chat = window.demo.chat,
      original = chat.turnIntoProject;
    chat.turnIntoProject = async () => {
      chat.turnIntoProject = original;
      throw new Error('The folder changed.');
    };
  });
  const turnError = page
    .getByRole('alert')
    .filter({ hasText: 'The chat could not become a project.' });
  await turn.click();
  await expect(turnError).toHaveText('The chat could not become a project. The folder changed.');
  await expect(saved.getByRole('button', { name: /^Plan a trip/ })).toContainText('No project');
  // Its folder becomes a project where it is, and the chat lists under that project.
  await turn.click();
  await expect(turnError).toBeHidden();
  await expect(
    page
      .getByRole('group', { name: 'Project tabs', exact: true })
      .getByRole('tab', { name: 'chat-1', exact: true }),
  ).toBeVisible();
  await expect(saved.getByRole('button', { name: /^Plan a trip/ })).toContainText('chat-1');
  await expect(page.getByRole('button', { name: 'Turn into project', exact: true })).toBeHidden();
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
  await chooseFolderNatively(page);
  await worktree.click();
  await page.getByRole('option', { name: 'New worktree', exact: true }).click();
  await message.fill("Tidy the composer's spacing");
  expect(await page.evaluate(() => window.demo.chat.worktrees)).toEqual([]);
  await message.press('Enter');
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
  await expect(dock.getByTitle('In moonbase', { exact: true })).toBeVisible();
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

test('a new chat keeps its folder across project visits, and a worktree Git finishes meanwhile still sends', async ({
  page,
}) => {
  // StrictMode mounts each view twice, as a remount would.
  await page.goto('/?local&design&strict');
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  const folderChoice = page.getByRole('button', { name: 'Choose working folder', exact: true });
  const worktree = page.getByRole('combobox', { name: 'Worktree', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const projectTab = page.getByRole('tab', { name: 'moonbase · main', exact: true });
  const agentsTab = page.getByRole('tab', { name: 'Agents', exact: true });
  await folderChoice.click();
  await page
    .getByRole('dialog', { name: 'Working folder', exact: true })
    .getByRole('button', { name: /^notes/ })
    .click();
  await expect(folderChoice).toHaveAttribute('title', '/Users/demo/notes');
  await worktree.click();
  await page.getByRole('option', { name: 'New worktree', exact: true }).click();
  await message.fill('Tidy the notes index');
  // Visiting a project shows its docked chat instead, unmounting Agents' view; its choices stay.
  await projectTab.click();
  await expect(
    page
      .getByRole('complementary', { name: 'Project chats', exact: true })
      .getByRole('button', { name: 'Choose working folder', exact: true }),
  ).toHaveAttribute('title', '/demo/moonbase');
  await agentsTab.click();
  await expect(folderChoice).toHaveAttribute('title', '/Users/demo/notes');
  await expect(worktree).toContainText('New worktree');
  await expect(send).toBeEnabled();
  // Git takes a while, and the view goes away before it finishes.
  await page.evaluate(() => {
    const chat = window.demo.chat,
      create = chat.createWorktree;
    chat.createWorktree = (root, branch) =>
      new Promise((resolve) => {
        Object.assign(window, { finishWorktree: () => resolve(create(root, branch)) });
      });
  });
  await send.click();
  await expect(send).toBeDisabled();
  await projectTab.click();
  await page.evaluate(() => (window as never as { finishWorktree(): void }).finishWorktree());
  await agentsTab.click();
  await expect(
    page.getByRole('heading', { name: 'Tidy the notes index', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().snapshot?.conversation.cwd,
    ),
  ).toBe('/Users/demo/notes-worktrees/chat-tidy-the-notes-index');
  expect(await page.evaluate(() => window.demo.chat.worktrees)).toEqual([
    '/Users/demo/notes chat/tidy-the-notes-index',
  ]);
  // The open chat shows no new-chat messages, and the next new chat doesn't start in its worktree.
  await expect(page.getByRole('alert').filter({ hasText: /worktree/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByText('What should we work on?')).toBeVisible();
  await expect(folderChoice).toHaveAttribute('title', '/Users/demo/notes');
  await expect(page.getByRole('combobox', { name: 'Worktree', exact: true })).toContainText(
    'This folder',
  );
});

test('a worktree that fails while another view shows the chat says so there', async ({ page }) => {
  await page.goto('/?local&design');
  const folderChoice = page.getByRole('button', { name: 'Choose working folder', exact: true });
  await folderChoice.click();
  await page
    .getByRole('dialog', { name: 'Working folder', exact: true })
    .getByRole('button', { name: /^notes/ })
    .click();
  await page.getByRole('combobox', { name: 'Worktree', exact: true }).click();
  await page.getByRole('option', { name: 'New worktree', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Tidy the notes index');
  await page.evaluate(() => {
    window.demo.chat.createWorktree = () =>
      new Promise((_resolve, reject) => {
        Object.assign(window, { failWorktree: () => reject(Error('Git said no.')) });
      });
  });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const dock = page.getByRole('complementary', { name: 'Project chats', exact: true });
  await page.evaluate(() => (window as never as { failWorktree(): void }).failWorktree());
  await expect(
    dock.getByRole('alert').filter({ hasText: 'The worktree could not be created.' }),
  ).toHaveText('The worktree could not be created. Git said no.');
  await expect(dock.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
});

test('a new chat’s mentions keep the folder they were picked in, and Send checks them against its own', async ({
  page,
}) => {
  await page.goto('/?local&design');
  const agents = page.getByRole('main', { name: 'Agent workspace', exact: true });
  const files = page.getByRole('listbox', { name: 'Files', exact: true });
  await agents.getByRole('button', { name: 'Choose working folder', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Working folder', exact: true })
    .getByRole('button', { name: /^notes/ })
    .click();
  const message = agents.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Fix @README');
  const readme = files.getByRole('option', { name: 'README.md', exact: true });
  await expect(readme).not.toHaveAttribute('aria-disabled');
  await readme.click();
  await expect(message).toHaveValue('Fix @README.md ');
  // Showing the draft in a project's dock, with another folder, leaves the mention as it was.
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const dock = page.getByRole('complementary', { name: 'Project chats', exact: true });
  const dockMessage = dock.getByRole('textbox', { name: 'Message', exact: true });
  await expect(dockMessage).toHaveValue('Fix @README.md ');
  await expect(dock.locator('mark')).toHaveCount(1);
  // The same path in the dock's folder would be a second file under one spelling: it's refused.
  await dockMessage.evaluate((element: HTMLTextAreaElement) => {
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  });
  await dockMessage.pressSequentially('@README');
  const dockReadme = dock
    .getByRole('listbox', { name: 'Files', exact: true })
    .getByRole('option', { name: 'README.md', exact: true });
  await expect(dockReadme).not.toHaveAttribute('aria-disabled');
  await dockReadme.click();
  await expect(dock.getByRole('status')).toHaveText(
    "The draft already mentions README.md in /Users/demo/notes, so the one in /demo/moonbase can't be mentioned too.",
  );
  await expect(dockMessage).toHaveValue('Fix @README.md @README');
  await dockMessage.fill('Fix @README.md ');
  await expect(dock.locator('mark')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(message).toHaveValue('Fix @README.md ');
  await expect(agents.locator('mark')).toHaveCount(1);
  await expect(agents.getByRole('alert')).toHaveCount(0);
  // Sending it from the dock writes the notes file out in full and waits for a second Send.
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const send = dock.getByRole('button', { name: 'Send message', exact: true });
  await send.click();
  await expect(dock.getByRole('alert').filter({ hasText: 'mentioned file' })).toHaveText(
    "A mentioned file isn't in /demo/moonbase, so it is written out as a full path instead. Send again to send the message.",
  );
  await expect(dockMessage).toHaveValue('Fix /Users/demo/notes/README.md ');
  await expect(dock.locator('mark')).toHaveCount(0);
  await send.click();
  await expect(
    dock.getByRole('heading', { name: 'Fix /Users/demo/notes/README.md', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().snapshot?.conversation.cwd,
    ),
  ).toBe('/demo/moonbase');
});

test('/new starts the new chat from the lines after it and leaves the open chat’s draft empty', async ({
  page,
}) => {
  await page.goto('/?local&design');
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await chooseFolderNatively(page);
  await message.fill('Start a chat');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start a chat', exact: true })).toBeVisible();
  await message.fill('/new\nCarry this on');
  await message.press('ControlOrMeta+Enter');
  await expect(page.getByText('What should we work on?')).toBeVisible();
  await expect(message).toHaveValue('Carry this on');
  // A chat you haven't settled lists under Idle.
  const list = page.getByRole('navigation', { name: 'Conversations', exact: true });
  await list.getByRole('button', { name: /Start a chat/ }).click();
  await expect(page.getByRole('heading', { name: 'Start a chat', exact: true })).toBeVisible();
  await expect(message).toHaveValue('');
});

test('the @ picker picks only from the current query’s matches and leaves IME keys alone', async ({
  page,
}) => {
  await page.goto('/?local&design');
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  const files = page.getByRole('listbox', { name: 'Files', exact: true });
  await chooseFolderNatively(page);
  // The search for `rele` answers only when the test says.
  await page.evaluate(() => {
    const chat = window.demo.application.chat!,
      find = chat.findFiles.bind(chat);
    const held: (() => void)[] = [];
    Object.assign(window, { answerHeld: () => held.splice(0).forEach((answer) => answer()) });
    chat.findFiles = (query, options) =>
      query === 'rele'
        ? new Promise((resolve, reject) => {
            held.push(() => void find(query, options).then(resolve, reject));
          })
        : find(query, options);
  });
  await message.fill('@rel');
  const first = files.getByRole('option').first();
  await expect(first).toHaveAccessibleName(/Release notes\.md/);
  await expect(first).not.toHaveAttribute('aria-disabled');
  await message.pressSequentially('e');
  // The `rel` matches stay listed while `rele` is searched, but can't be picked.
  await expect(first).toHaveAttribute('aria-disabled', 'true');
  await message.press('Enter');
  await message.press('Tab');
  await first.click({ force: true });
  await expect(message).toHaveValue('@rele');
  await page.evaluate(() => (window as never as { answerHeld(): void }).answerHeld());
  await expect(first).not.toHaveAttribute('aria-disabled');
  // Keys an input method is composing with go to it.
  const keyDown = (key: string, isComposing: boolean) =>
    message.evaluate(
      (element, init) =>
        !element.dispatchEvent(
          new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }),
        ),
      { key, isComposing },
    );
  for (const key of ['Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape'])
    expect(await keyDown(key, true)).toBe(false);
  await expect(message).toHaveValue('@rele');
  await expect(files).toBeVisible();
  await expect(message).toHaveAttribute('aria-activedescendant', /option-0$/);
  expect(await keyDown('Enter', false)).toBe(true);
  await expect(message).toHaveValue('@"docs/Release notes.md" ');
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
  await expect(sidebar.getByRole('heading', { name: 'Idle 1', exact: true })).toBeVisible();
});

test('the local model menu opens provider setup in Settings', async ({ page }) => {
  await page.goto('/?local');
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  await shell(page).getByRole('button', { name: 'Chat model', exact: true }).click();
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
  // Claude Code owns the subscription's login, so its way explains the CLI instead of a button.
  const claude = settings
    .getByRole('list', { name: 'Model providers', exact: true })
    .getByRole('listitem', { name: 'Anthropic', exact: true });
  await expect(claude).toContainText('Not set up');
  const subscription = claude.getByRole('listitem', { name: 'Claude subscription', exact: true });
  await expect(subscription).toContainText('claude auth login');
  await expect(subscription.getByRole('button')).toHaveCount(0);
  await settings.getByRole('tab', { name: 'Hosts', exact: true }).click();
  await expect(settings.getByRole('status').first()).toHaveText('Local ready');
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(settings).toHaveCount(0);
  await shell(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings).toBeVisible();
});

test('the chats sidebar orders by activity: Ready, Working, Idle, then a Settled toggle', async ({
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
  // The chat seen before anything else listed is idle; nothing is settled until you settle it.
  await expect(list.getByRole('heading', { name: 'Idle 1' })).toBeVisible();
  await expect(rows.nth(6)).toContainText('Conversation');
  const settled = list.getByRole('button', { name: /^Settled/ });
  await expect(settled).toHaveCount(0);
  // Opening a Ready chat makes it Idle.
  await list.getByRole('button', { name: /^Summarise this repository/ }).click();
  await expect(list.getByRole('heading', { name: 'Ready 3' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Idle 2' })).toBeVisible();
  // Settled from its header, it stays in view under the closed toggle while it is open.
  await shell(page).getByRole('button', { name: 'Settle chat', exact: true }).click();
  await expect(settled).toHaveText(/Settled\s*1/);
  await expect(settled).toHaveAttribute('aria-expanded', 'false');
  await expect(list.getByRole('heading', { name: 'Idle 1' })).toBeVisible();
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
  // Another chat opened, the settled one is behind the toggle.
  await list.getByRole('button', { name: /^Conversation/ }).click();
  await expect(list.getByRole('button', { name: /^Summarise this repository/ })).toHaveCount(0);
  await settled.click();
  await expect(settled).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByRole('button', { name: /^Summarise this repository/ })).toBeVisible();
  await settled.click();
  await expect(settled).toHaveAttribute('aria-expanded', 'false');
  await expect(list.getByRole('button', { name: /^Summarise this repository/ })).toHaveCount(0);
  await settled.click();
  // The toggle is remembered.
  await page.reload();
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  await shell(page).getByRole('button', { name: 'Connect', exact: true }).click();
  await list.getByRole('button', { name: /^Conversation/ }).click();
  await shell(page).getByRole('button', { name: 'Settle chat', exact: true }).click();
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

test('a chat settles and unsettles from its header or the composer, and a Send unsettles it', async ({
  page,
}) => {
  await page.goto('/?local');
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  const list = shell(page).getByRole('navigation', { name: 'Conversations', exact: true });
  const toggle = list.getByRole('button', { name: /^Settled/ });
  const settle = shell(page).getByRole('button', { name: 'Settle chat', exact: true });
  const unsettle = shell(page).getByRole('button', { name: 'Unsettle chat', exact: true });
  const message = shell(page).getByRole('textbox', { name: 'Message', exact: true });
  await list.getByRole('button', { name: /^Conversation/ }).click();
  await expect(list.getByRole('heading', { name: 'Idle 1' })).toBeVisible();
  await expect(toggle).toHaveCount(0);
  // Settled from the header, the chat moves from Idle into Settled.
  await settle.click();
  await expect(unsettle).toBeVisible();
  await expect(toggle).toHaveText(/Settled\s*1/);
  await expect(list.getByRole('heading', { name: /^Idle/ })).toHaveCount(0);
  await expect(
    page.evaluate(() => window.demo.chat.calls.filter((call) => call === 'settleChat').length),
  ).resolves.toBe(1);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByRole('button', { name: /^Conversation/ })).toBeVisible();
  // Unsettled, it is Idle again and the drawer goes.
  await unsettle.click();
  await expect(settle).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Idle 1' })).toBeVisible();
  await expect(toggle).toHaveCount(0);
  // The composer offers whichever command applies.
  await message.fill('/');
  const commands = page.getByRole('listbox', { name: 'Commands', exact: true });
  await expect(commands.getByRole('option', { name: /^\/settle/ })).toBeVisible();
  await expect(commands.getByRole('option', { name: /^\/unsettle/ })).toHaveCount(0);
  await message.fill('/settle');
  await message.press('ControlOrMeta+Enter');
  await expect(unsettle).toBeVisible();
  await expect(message).toHaveValue('');
  await message.fill('/unsettle');
  await message.press('ControlOrMeta+Enter');
  await expect(settle).toBeVisible();
  // Sending to a settled chat takes it up again.
  await settle.click();
  await expect(toggle).toHaveText(/Settled\s*1/);
  await message.fill('Pick this back up');
  await shell(page).getByRole('button', { name: 'Send message', exact: true }).click();
  await shell(page).getByRole('button', { name: 'Refresh saved chats', exact: true }).click();
  await expect(settle).toBeVisible();
  await expect(toggle).toHaveCount(0);
});

test("the model picker lists providers that are set up, beside the chosen one's models", async ({
  page,
}) => {
  await page.goto('/?local&design&providers');
  const model = page.getByRole('button', { name: 'Chat model', exact: true });
  const picker = page.getByRole('dialog', { name: 'Choose model', exact: true });
  await expect(model).toContainText('Demo model');
  await model.click();
  const providers = picker.getByRole('group', { name: 'Providers', exact: true });
  // Google is not set up, so it is not listed.
  await expect(providers.getByRole('button')).toHaveText([/^OpenAI/, /^Anthropic/]);
  await expect(picker.getByRole('group', { name: 'OpenAI models', exact: true })).toBeVisible();
  await providers.getByRole('button', { name: /^Anthropic/ }).click();
  const anthropic = picker.getByRole('group', { name: 'Anthropic models', exact: true });
  await expect(anthropic.getByRole('button')).toHaveText([/Demo Opus/, /Demo Haiku/]);
  await anthropic.getByRole('button', { name: 'Demo Opus', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(model).toContainText('Demo Opus');
  await expect(model).toContainText('High');
  // Reopened, the chosen model's provider is shown, with that model's efforts.
  await model.click();
  await expect(providers.getByRole('button', { name: /^Anthropic/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(picker.getByRole('radio')).toHaveText(['Low', 'Medium', 'High', 'Max']);
  await picker.getByRole('radio', { name: 'Max', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(model).toContainText('Max');
  // A model without efforts shows none.
  await model.click();
  await picker.getByRole('button', { name: 'Demo Haiku', exact: true }).click();
  await expect(model).toHaveText(/Demo Haiku\s*▾/);
});

test("the rail's + reopens a closed project without the native picker", async ({ page }) => {
  await page.goto('/?local&design');
  const open = page.getByRole('button', { name: 'Open checkout', exact: true });
  // Nothing is closed yet, so + goes straight to the native picker.
  await expect(open).not.toHaveAttribute('aria-haspopup');
  const close = page.getByRole('button', { name: 'Close checkout /demo/moonbase', exact: true });
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).hover();
  await close.locator('..').hover();
  await close.click();
  await expect(page.getByRole('tab', { name: 'moonbase · main', exact: true })).toHaveCount(0);
  await open.click();
  const menu = page.getByRole('dialog', { name: 'Open project', exact: true });
  await expect(menu.getByRole('group', { name: 'Recent projects' }).getByRole('button')).toHaveText(
    [/^moonbase\s*main · \/demo\/moonbase/],
  );
  await expect(menu.getByRole('button', { name: 'Open folder…', exact: true })).toBeVisible();
  await menu.getByRole('button', { name: /^moonbase/ }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('tab', { name: 'moonbase · main', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(open).not.toHaveAttribute('aria-haspopup');
});

test('a long folder menu offers a filter: type, then Enter picks the first match', async ({
  page,
}) => {
  await page.goto('/?local&design&folders');
  const folderChoice = page.getByRole('button', { name: 'Choose working folder', exact: true });
  await folderChoice.click();
  const menu = page.getByRole('dialog', { name: 'Working folder', exact: true });
  const filter = menu.getByRole('textbox', { name: 'Filter folders', exact: true });
  await expect(filter).toBeFocused();
  await filter.fill('in');
  await expect(menu.getByRole('group', { name: 'Recent folders' }).getByRole('button')).toHaveText([
    /^game-engine/,
    /^infra/,
  ]);
  await filter.press('ArrowDown');
  await filter.press('Enter');
  await expect(menu).toBeHidden();
  await expect(folderChoice).toHaveAttribute('title', '/Users/demo/infra');
  await folderChoice.click();
  await filter.fill('zzz');
  await expect(menu.getByText('Nothing matches.', { exact: true })).toBeVisible();
});

/** The rounded width of the first element a locator finds. */
const widthOf = (locator: ReturnType<Page['locator']>) => () =>
  locator.evaluate((element) => Math.round(element.getBoundingClientRect().width));

test('⌘B and the sidebar button hide the main sidebar in projects and Agents, and it stays hidden', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const explorer = page.locator('aside[aria-label="Editor sidebar"]');
  await expect.poll(widthOf(explorer)).toBeGreaterThan(100);
  await page
    .getByRole('textbox', { name: 'welcome.ts editor', exact: true })
    .press('ControlOrMeta+b');
  await expect.poll(widthOf(explorer)).toBe(0);
  expect(await explorer.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await expect.poll(widthOf(explorer)).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  const list = page.locator('aside[aria-label="Saved chats"]');
  await expect.poll(widthOf(list)).toBe(0);
  await page.reload();
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await expect.poll(widthOf(list)).toBe(0);
  // The key works with nothing focused, too.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+b');
  await expect.poll(widthOf(list)).toBeGreaterThan(100);
});

test('⌃⌘S toggles the sidebar and never saves', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await editor.focus();
  await editor.pressSequentially('unsaved ');
  const saves = () => page.evaluate(() => window.demo.memory.stats.saves);
  const before = await saves();
  const explorer = page.locator('aside[aria-label="Editor sidebar"]');
  // Off a Mac the sidebar's second key is Ctrl+Alt+S.
  const toggleKeys = process.platform === 'darwin' ? 'Control+Meta+s' : 'Control+Alt+s';
  await editor.press(toggleKeys);
  await expect.poll(widthOf(explorer)).toBe(0);
  // Focus stays in the editor, so the next keys still work.
  await expect(editor).toBeFocused();
  await editor.press(toggleKeys);
  await expect.poll(widthOf(explorer)).toBeGreaterThan(100);
  expect(await saves()).toBe(before);
  // Hiding the sidebar from inside it hands focus to the editor.
  await page.getByRole('tree', { name: 'Files', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(editor).toBeFocused();
});

test('a hidden rail slides over the window at its left edge and away once the pointer is past it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  const left = () =>
    page
      .getByRole('tablist', { name: 'Workbench views', exact: true })
      .evaluate((element) => Math.round(element.getBoundingClientRect().x));
  await page.getByRole('button', { name: 'Hide rail', exact: true }).click();
  // Focus leaves the hidden rail for the view, not the page.
  await expect.poll(() => page.evaluate(() => document.activeElement !== document.body)).toBe(true);
  await page.mouse.move(700, 500);
  await expect.poll(left).toBe(-52);
  await page.mouse.move(3, 500);
  await expect.poll(left).toBe(0);
  await page.mouse.move(30, 300);
  await expect.poll(left).toBe(0);
  await page.mouse.move(120, 500);
  await expect.poll(left).toBe(-52);
  await page.mouse.move(3, 500);
  await page.getByRole('button', { name: 'Keep rail open', exact: true }).click();
  await page.mouse.move(700, 500);
  await expect.poll(left).toBe(0);
  await expect(page.getByRole('button', { name: 'Hide rail', exact: true })).toBeVisible();
});

test('the title bar names the open file, and project chats close fully and reopen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  const bar = page.locator('header[aria-label="Window title bar"]');
  await expect(bar).toContainText('Agents');
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  await expect(bar).toContainText('moonbase/welcome.ts');
  const dock = page.locator('aside[aria-label="Project chats"]');
  await expect.poll(widthOf(dock)).toBe(400);
  await bar.getByRole('button', { name: 'Toggle project chats', exact: true }).click();
  await expect.poll(widthOf(dock)).toBe(0);
  const editor = page.getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await editor.press('Meta+j');
  await expect.poll(widthOf(dock)).toBe(400);
  await editor.press('Meta+w');
  const sheet = page.getByRole('region', { name: 'Keyboard shortcuts', exact: true });
  await expect(sheet.getByRole('term')).toHaveText([
    'Go to file',
    'Commands',
    'Find in files',
    'Project chats',
  ]);
});

test('hiding project chats from inside them hands focus to the project, so the window keys still work', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const dock = page.locator('aside[aria-label="Project chats"]');
  const editor = page.getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  const message = dock.getByLabel('Message', { exact: true });
  await expect.poll(widthOf(dock)).toBe(400);
  await editor.focus();
  // The dock's own Hide button returns focus to where it last was in the project.
  await message.focus();
  await dock.getByRole('button', { name: 'Hide project chats', exact: true }).click();
  await expect.poll(widthOf(dock)).toBe(0);
  await expect(editor).toBeFocused();
  await page.keyboard.press('Meta+j');
  await expect.poll(widthOf(dock)).toBe(400);
  // So does ⌘J from the composer.
  await message.focus();
  await page.keyboard.press('Meta+j');
  await expect.poll(widthOf(dock)).toBe(0);
  await expect(editor).toBeFocused();
  // With focus on the page itself, the shell's keys still work.
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await blur();
  await page.keyboard.press('Meta+j');
  await expect.poll(widthOf(dock)).toBe(400);
  await blur();
  await page.keyboard.press('ControlOrMeta+p');
  const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
  await expect(goTo).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(goTo).toHaveCount(0);
  await blur();
  await page.keyboard.press('Meta+,');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
});

test('a peeked rail that slides away hands its focus to the view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  const rail = page.getByRole('tablist', { name: 'Workbench views', exact: true });
  const left = () => rail.evaluate((element) => Math.round(element.getBoundingClientRect().x));
  await page.getByRole('button', { name: 'Hide rail', exact: true }).click();
  await page.mouse.move(700, 500);
  await expect.poll(left).toBe(-52);
  await page.mouse.move(3, 500);
  await expect.poll(left).toBe(0);
  // Agents is already open, so its tab keeps focus.
  const agents = rail.getByRole('tab', { name: 'Agents', exact: true });
  await agents.click();
  await expect(agents).toBeFocused();
  await page.mouse.move(700, 500);
  await expect.poll(left).toBe(-52);
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return 'page';
      return element.closest('[aria-label="Workbench views"]') ? 'rail' : 'view';
    });
  await expect.poll(focused).toBe('view');
});

test('the sidebar key follows the layout: ⌘ with the key that types B, not the physical B key', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const explorer = page.locator('aside[aria-label="Editor sidebar"]');
  await expect.poll(widthOf(explorer)).toBeGreaterThan(100);
  // Playwright can't switch layouts, so this sends the keys a layout reports. It resolves whether
  // the page took the key, preventing its default.
  const press = (key: string, code: string) =>
    page.evaluate(
      ([key, code]) => {
        const mac = navigator.platform.startsWith('Mac');
        return !document.body.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            code,
            metaKey: mac,
            ctrlKey: !mac,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      [key, code],
    );
  // On Dvorak the physical B key types X: that's Cut, left alone.
  expect(await press('x', 'KeyB')).toBe(false);
  await expect.poll(widthOf(explorer)).toBeGreaterThan(100);
  // The key that types B there, physically N, hides the sidebar.
  expect(await press('b', 'KeyN')).toBe(true);
  await expect.poll(widthOf(explorer)).toBe(0);
  // A non-Latin layout falls back to the physical key.
  expect(await press('и', 'KeyB')).toBe(true);
  await expect.poll(widthOf(explorer)).toBeGreaterThan(100);
});

test('Settings shows why switching hosts failed, holding Use and focus while it tries', async ({
  page,
}) => {
  await page.goto('/?local&hosts');
  await tabs(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  const message = shell(page).getByLabel('Message', { exact: true });
  await expect(message).toBeEnabled();
  // The current chat can't be preserved, so the application refuses to switch. The attempt waits
  // for the test, so it can be seen in progress.
  await page.evaluate(() => {
    window.demo.chat.storage.write = () => {
      throw Error('Controlled draft storage failure');
    };
    const application = window.demo.application;
    const select = application.selectChatTarget.bind(application);
    const gate = Promise.withResolvers<void>();
    Object.assign(window, { releaseSwitch: gate.resolve });
    application.selectChatTarget = (id) => gate.promise.then(() => select(id));
  });
  await message.press('Meta+,');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const use = settings.getByRole('button', { name: 'Use Studio', exact: true });
  await use.click();
  await expect(use).toBeDisabled();
  await expect(use).toBeFocused();
  await page.evaluate(() => (window as unknown as { releaseSwitch(): void }).releaseSwitch());
  await expect(settings.getByRole('alert')).toHaveText(
    'Preserve the current chat before switching targets.',
  );
  await expect(use).toBeEnabled();
  await expect(use).toBeFocused();
});

test('a host switch keeps focus in Settings, and the window keys wait behind it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&hosts&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  const dock = page.locator('aside[aria-label="Project chats"]');
  await expect.poll(widthOf(dock)).toBe(400);
  await editor.press('Meta+,');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  // Once Studio is in use its Use button goes; focus stays in the dialog.
  await settings.getByRole('button', { name: 'Use Studio', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Use This Mac', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-labelledby]')),
    )
    .toBe(true);
  // Even with focus fallen to the page, the shell and editor behind the modal ignore their keys.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (const key of ['Meta+w', 'Meta+n', 'Meta+p', 'Meta+j']) await page.keyboard.press(key);
  await expect(settings).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Go to', exact: true })).toHaveCount(0);
  // The modal hides the shell from the accessibility tree, so these look past that.
  await expect(
    page.getByRole('tab', { name: 'moonbase · main', exact: true, includeHidden: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('tab', { name: 'welcome.ts', exact: true, includeHidden: true }),
  ).toHaveCount(1);
  await expect.poll(widthOf(dock)).toBe(400);
});

test('hiding project chats from the picker hands focus back to the project', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  const dock = page.locator('aside[aria-label="Project chats"]');
  const editor = page.getByRole('textbox', { name: 'welcome.ts editor', exact: true });
  await expect.poll(widthOf(dock)).toBe(400);
  await editor.focus();
  await dock.getByLabel('Message', { exact: true }).press('Meta+Shift+p');
  const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
  await goTo.getByRole('option', { name: 'Hide project chats', exact: true }).click();
  await expect(goTo).toHaveCount(0);
  await expect.poll(widthOf(dock)).toBe(0);
  await expect(editor).toBeFocused();
});

test('releasing Control commits the recent-tabs switcher opened with focus on the page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?local&design');
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await page.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
  await page
    .getByRole('tree', { name: 'Files', exact: true })
    .getByRole('treeitem', { name: 'README.md', exact: true })
    .dblclick();
  const bar = page.locator('header[aria-label="Window title bar"]');
  await expect(bar).toContainText('moonbase/README.md');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down('Control');
  await page.keyboard.press('Tab');
  const recent = page.getByRole('listbox', { name: 'Recent tabs', exact: true });
  await expect(recent).toBeVisible();
  await page.keyboard.up('Control');
  await expect(recent).toHaveCount(0);
  await expect(bar).toContainText('moonbase/welcome.ts');
});

test('a key pressed on the page acts in one shell: the one last focused', async ({ page }) => {
  await page.goto('/?local');
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const goTo = page.getByRole('dialog', { name: 'Go to', exact: true });
  for (const name of ['First editor', 'Second editor']) {
    const region = page.getByRole('region', { name, exact: true });
    // Both shells open on Agents.
    await region.getByRole('tab', { name: 'moonbase · main', exact: true }).click();
    await region.getByRole('textbox', { name: 'welcome.ts editor', exact: true }).focus();
    await blur();
    await page.keyboard.press('Meta+p');
    await expect(goTo).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(goTo).toHaveCount(0);
  }
});
