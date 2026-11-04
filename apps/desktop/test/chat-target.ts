import { expect, type Page } from '@playwright/test';

export async function selectRemoteChat(page: Page) {
  const label = await page.evaluate(
    async () =>
      (await window.moonbaseChat.targets!()).find((target) => target.mode === 'remote')!.label,
  );
  await page.getByRole('combobox', { name: 'Chat target', exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

/** Seed empty chats for lifecycle tests; first-message UI behavior has separate coverage. */
export async function createRemoteChat(page: Page, title: string) {
  await expect(
    page.getByRole('button', { name: 'Refresh saved chats', exact: true }),
  ).toBeEnabled();
  const result = await page.evaluate(async (title) => {
    const session = await window.moonbaseChat.context('remote');
    return window.moonbaseChat.call(
      'chat',
      'createChat',
      { session, requestId: crypto.randomUUID(), title },
      crypto.randomUUID(),
      'remote',
    );
  }, title);
  if (!result.ok) throw Error(result.error.message);
  await page.getByRole('button', { name: 'Refresh saved chats', exact: true }).click();
  await page.getByRole('button', { name: title, exact: false }).click();
}
