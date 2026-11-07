import { expect, type Page } from '@playwright/test';

/** Opens Settings from the rail at one section; hosts, connection and providers live there. */
export async function openSettings(page: Page, section: 'Hosts' | 'Providers' = 'Hosts') {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  if (!(await dialog.isVisible()))
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await dialog.getByRole('tab', { name: section, exact: true }).click();
  return dialog;
}
export async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
}
/** Disconnects the remote host from Settings › Hosts and waits until it can reconnect. */
export async function disconnectChat(page: Page) {
  const hosts = await openSettings(page);
  await hosts.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(hosts.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
  await closeSettings(page);
}

export async function selectRemoteChat(page: Page) {
  const label = await page.evaluate(
    async () =>
      (await window.moonbaseChat.targets!()).find((target) => target.mode === 'remote')!.label,
  );
  const hosts = await openSettings(page);
  await expect(hosts.getByRole('listitem').filter({ hasText: label })).toBeVisible();
  // Already the current host, it has no Use button.
  const use = hosts.getByRole('button', { name: `Use ${label}`, exact: true });
  if (await use.count()) {
    await use.click();
    await expect(use).toHaveCount(0);
  }
  await closeSettings(page);
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
