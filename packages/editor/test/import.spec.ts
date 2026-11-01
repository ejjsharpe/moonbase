import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { EditorController } from '../src/editor.ts';

declare global {
  interface Window {
    importCalls: Parameters<EditorController['mutate']>[0][];
    importRefs: string[];
  }
}
const dialog = (page: Page) => page.getByRole('dialog');
const imports = (page: Page) =>
  dialog(page).getByRole('button', { name: 'Import files', exact: true });
async function setup(page: Page) {
  await page.goto('/');
  await expect(
    page
      .getByRole('region', { name: 'First editor', exact: true })
      .getByRole('tab', { name: 'welcome.ts', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.importCalls = [];
    window.importRefs = ['opaque-one'];
    window.demo.selectNativeImports = async () => window.importRefs;
    window.demo.first.mutate = async (input) => {
      window.importCalls.push(structuredClone(input));
      return {
        ...input,
        id: input.id!,
        clientId: window.demo.first.clientId,
        items: [],
        recoveryChanges: [],
        outcome: 'completed',
      };
    };
  });
}

test('native picker asks for a full single destination and captures explicit replacement consent', async ({
  page,
}) => {
  await setup(page);
  await page
    .getByRole('region', { name: 'First editor', exact: true })
    .getByRole('button', { name: 'Import files', exact: true })
    .click();
  await expect(imports(page)).toBeDisabled();
  await page.getByLabel('Destination relative path', { exact: true }).press('Enter');
  expect(await page.evaluate(() => window.importCalls)).toEqual([]);
  await page.getByLabel('Destination relative path', { exact: true }).fill('README.md');
  await imports(page).click();
  await expect(dialog(page).getByRole('alert')).toContainText('Replace README.md?');
  await page.screenshot({ path: 'test-results/editor-import-replacement.png', fullPage: true });
  expect(await page.evaluate(() => window.importCalls)).toEqual([]);
  await dialog(page)
    .getByRole('button', { name: 'Replace captured destination', exact: true })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  const [call] = await page.evaluate(() => window.importCalls);
  expect(call).toMatchObject({
    kind: 'import',
    checkout: { checkoutId: 'sample' },
    sources: [],
    destination: 'README.md',
    nativeReferences: ['opaque-one'],
  });
  expect(call.replacements?.map((ref) => ref.target.path)).toEqual(['README.md']);
});

test('public importFiles copies exact target/tokens and never redirects to a newer selection', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(async () => {
    const checkout = { ...window.demo.checkout },
      references = ['opaque-drop'];
    window.demo.workbench().importFiles(checkout, references);
    checkout.root = '/changed-by-caller';
    references[0] = 'changed-by-caller';
    window.demo.workbench().importFiles(window.demo.checkout, ['must-not-replace-dialog']);
    await window.demo.first.openCheckout('/demo/other');
  });
  await expect(dialog(page)).toContainText('/demo/moonbase');
  await page.getByLabel('Destination relative path', { exact: true }).fill('dropped.txt');
  await imports(page).click();
  const [call] = await page.evaluate(() => window.importCalls);
  expect(call).toMatchObject({
    checkout: { root: '/demo/moonbase' },
    nativeReferences: ['opaque-drop'],
    destination: 'dropped.txt',
    sources: [],
  });
  expect(await page.evaluate(() => window.importCalls.length)).toBe(1);
});

test('batch imports allow root and explicitly captured replacement paths in the same dialog', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() =>
    window.demo.workbench().importFiles(window.demo.checkout, ['opaque-a', 'opaque-b']),
  );
  await page.setViewportSize({ width: 760, height: 720 });
  await expect(imports(page)).toBeEnabled();
  await page
    .getByLabel('Existing destination paths to replace', { exact: false })
    .fill('README.md');
  await imports(page).click();
  expect(await page.evaluate(() => window.importCalls)).toEqual([]);
  await page.screenshot({ path: 'test-results/editor-import-batch.png', fullPage: true });
  await dialog(page)
    .getByRole('button', { name: 'Replace captured destination', exact: true })
    .click();
  expect((await page.evaluate(() => window.importCalls))[0]).toMatchObject({
    destination: '',
    nativeReferences: ['opaque-a', 'opaque-b'],
    sources: [],
    replacements: [{ target: { path: 'README.md' } }],
  });
});

test('cancelled/empty/closed-checkout imports dispatch nothing; create file/folder inspect no empty selection', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    window.demo.workbench().importFiles(window.demo.checkout, []);
    window.demo.workbench().importFiles({ ...window.demo.checkout, root: '/unapproved' }, ['bad']);
  });
  await expect(dialog(page)).toHaveCount(0);
  await page.evaluate(() =>
    window.demo.workbench().importFiles(window.demo.checkout, ['cancelled']),
  );
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => window.importCalls)).toEqual([]);
  await page.reload();
  for (const [title, destination] of [
    ['New File', 'created.ts'],
    ['New Folder', 'created-folder'],
  ]) {
    await page
      .getByRole('region', { name: 'First editor', exact: true })
      .getByRole('button', { name: title, exact: true })
      .click();
    await page.getByLabel('Destination relative path', { exact: true }).fill(destination);
    await dialog(page).getByRole('button', { name: title, exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
  }
  await expect(
    page
      .getByRole('region', { name: 'First editor', exact: true })
      .getByRole('tab', { name: 'created.ts', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.demo.memory.stats.mutations)).toBe(2);
});

test('a delayed native picker cannot approve a checkout closed while selection was pending', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    let release!: (references: string[]) => void;
    window.demo.selectNativeImports = () =>
      new Promise<string[]>((resolve) => {
        release = resolve;
      });
    Object.assign(window, { finishPicker: () => release(['late-reference']) });
  });
  await page
    .getByRole('region', { name: 'First editor', exact: true })
    .getByRole('button', { name: 'Import files', exact: true })
    .click();
  await page.evaluate(async () => {
    await window.demo.first.closeCheckout(window.demo.checkout);
    (window as unknown as { finishPicker(): void }).finishPicker();
  });
  await expect(dialog(page)).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'First editor', exact: true }).getByRole('alert'),
  ).toContainText('Open the exact import checkout');
  expect(await page.evaluate(() => window.importCalls)).toEqual([]);
});
