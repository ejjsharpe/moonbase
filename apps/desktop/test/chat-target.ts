import type { Page } from '@playwright/test';

export async function selectRemoteChat(page: Page) {
  const label = await page.evaluate(
    async () =>
      (await window.moonbaseChat.targets!()).find((target) => target.mode === 'remote')!.label,
  );
  await page.getByRole('combobox', { name: 'Chat target', exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}
