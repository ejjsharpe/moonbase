import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readFindHighlight } from './find-highlight.ts';

// These tests open the demo chat, which is Settled; the sidebar's own test covers the toggle.
test.beforeEach(({ page }) =>
  page.addInitScript(() => localStorage.setItem('moonbase.chats.settled', 'open')),
);
type ImageWindow = Window & { imageUrls: number; releaseImageUrl(): void };
const png = (await readFile(new URL('./fixtures/images/retained.png', import.meta.url))).toString(
  'base64',
);
const checker = (
  await readFile(new URL('./fixtures/images/checker.png', import.meta.url))
).toString('base64');
const jpeg = (await readFile(new URL('./fixtures/images/retained.jpg', import.meta.url))).toString(
  'base64',
);
const tall = (await readFile(new URL('./fixtures/images/tall.png', import.meta.url))).toString(
  'base64',
);
const output = resolve('../../test-results/transcript-images');
async function open(
  page: Page,
  data = checker,
  mimeType = 'image/png',
  availability: 'available' | 'unavailable' = 'available',
) {
  await page.goto('/?local&design&transcript');
  await page.getByRole('button', { name: /^Conversation/ }).click();
  await expect(page.getByRole('heading', { name: 'Reading a retained answer' })).toBeAttached();
  await page.evaluate(
    async ({ data, mimeType, availability }) => {
      const native = window.demo.transcript!.native,
        imageUrl = native.imageUrl.bind(native);
      (window as unknown as ImageWindow).imageUrls = 0;
      native.imageUrl = (...args) => {
        (window as unknown as ImageWindow).imageUrls++;
        return imageUrl(...args);
      };
      await window.demo.transcript!.record([
        {
          id: 'stored-image',
          role: 'tool',
          parts: [
            { kind: 'text', text: 'Recorded output before image', role: 'assistant' },
            {
              kind: 'image',
              text: '',
              data,
              mimeType,
              availability,
              partId: 'image',
              role: 'tool',
            },
            { kind: 'text', text: 'Recorded output after image', role: 'assistant' },
          ],
        },
      ]);
      await window.demo.application.chat!.jumpToLatest();
    },
    { data, mimeType, availability },
  );
  const row = page.locator('[data-transcript-entry="stored-image"]');
  const group = row.getByRole('button', { name: /^Activity/ });
  await group.scrollIntoViewIfNeeded();
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
  // The image shows once its card is open; it has no fold of its own.
  await row.locator('[data-stored-image]').scrollIntoViewIfNeeded();
  return row;
}
const imageUrls = (page: Page) => page.evaluate(() => (window as unknown as ImageWindow).imageUrls);
const naturalSize = (page: Page, name: string) =>
  page
    .getByRole('img', { name, exact: true })
    .evaluate((node: HTMLImageElement) => [node.naturalWidth, node.naturalHeight]);

test('PNG and JPEG thumbnails and one keyboard viewer trap/restore focus and fit normal/compact/200%', async ({
  page,
}) => {
  test.slow(); // Several fresh demo navigations, including a 4 MiB fixture.
  const external: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://example.com')) external.push(request.url());
  });
  const row = await open(page);
  const trigger = page.getByRole('button', { name: 'View stored image', exact: true });
  await expect(trigger).toBeEnabled();
  const thumbnail = page.getByRole('img', { name: 'Stored image thumbnail' });
  await expect(thumbnail).toHaveAttribute('loading', 'lazy');
  await expect(thumbnail).toHaveAttribute('decoding', 'async');
  expect(await naturalSize(page, 'Stored image thumbnail')).toEqual([256, 128]);
  await expect(row.getByText('256 × 128 pixels · Open to inspect')).toBeVisible();
  for (let iteration = 0; iteration < 3; iteration++) {
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Stored image', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('img', { name: 'Recorded image', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close image viewer' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() => dialog.evaluate((node) => node.contains(document.activeElement)))
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
  await mkdir(output, { recursive: true });
  for (const [name, width, height] of [
    ['normal', 1440, 900],
    ['compact', 540, 844],
    ['zoom-200', 720, 450],
  ] as const) {
    await page.setViewportSize({ width, height });
    await trigger.scrollIntoViewIfNeeded();
    await expect(trigger).toBeEnabled();
    await page.screenshot({ path: resolve(output, `${name}-thumbnail.png`) });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Stored image', exact: true });
    await expect(dialog.getByRole('img', { name: 'Recorded image' })).toBeVisible();
    await page.screenshot({ path: resolve(output, `${name}-viewer.png`) });
    expect(
      await dialog.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        );
      }),
    ).toBe(true);
    await page.keyboard.press('Escape');
  }
  expect(external).toEqual([]);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await open(page, jpeg, 'image/jpeg');
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  expect(await naturalSize(page, 'Stored image thumbnail')).toEqual([256, 128]);
  await page.getByRole('button', { name: 'View stored image' }).click();
  await expect(page.getByRole('img', { name: 'Recorded image' })).toBeVisible();
  expect(await naturalSize(page, 'Recorded image')).toEqual([256, 128]);
  await page.screenshot({ path: resolve(output, 'jpeg-viewer.png') });
  await page.keyboard.press('Escape');
  await open(page, tall);
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  const box = (await page.getByRole('img', { name: 'Stored image thumbnail' }).boundingBox())!;
  expect(box.height).toBe(180);
  expect(box.width).toBeLessThanOrEqual(320);
  await page.getByRole('button', { name: 'View stored image' }).click();
  const viewer = page.getByRole('dialog', { name: 'Stored image', exact: true });
  await expect(viewer.getByRole('img', { name: 'Recorded image' })).toBeVisible();
  const viewport = viewer.getByLabel('Image viewport', { exact: true });
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollHeight > node.clientHeight))
    .toBe(true);
  await viewport.focus();
  await page.keyboard.press('End');
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(viewer.getByRole('button', { name: 'Close image viewer' })).toBeInViewport();
  await page.screenshot({ path: resolve(output, 'tall-overflow.png') });
  await page.keyboard.press('Escape');
});
test('unsupported, missing and oversized images stay explicit without a request; undecodable bytes offer Retry', async ({
  page,
}) => {
  test.slow(); // Several fresh demo navigations, including a 4 MiB fixture.
  for (const [data, mime, message] of [
    [btoa('<svg onload="alert(1)"/>'), 'image/svg+xml', /unsupported/],
    [Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'), 'image/png', /4 MiB/],
  ] as const) {
    await open(page, data, mime);
    await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
    await expect(page.locator('[data-stored-image] img')).toHaveCount(0);
    expect(await imageUrls(page)).toBe(0);
  }
  await open(page, checker, 'image/png', 'unavailable');
  await expect(page.locator('[data-stored-image] [role="alert"]')).toContainText('unavailable');
  expect(await imageUrls(page)).toBe(0);
  await page.evaluate(async () => {
    await window.demo.transcript!.record([
      {
        id: 'wrong-encoding',
        parts: [
          {
            kind: 'image',
            role: 'tool',
            text: '<html>not binary image data</html>',
            mimeType: 'image/png',
            encoding: 'utf8',
          },
        ],
      },
    ]);
    await window.demo.application.chat!.jumpToLatest();
  });
  await page.getByRole('button', { name: /^Activity/ }).press('Enter');
  await expect(page.locator('[data-stored-image] [role="alert"]')).toContainText('corrupt');
  expect(await imageUrls(page)).toBe(0);
  for (const data of [btoa('<html><script>alert(1)</script></html>'), png.slice(0, 40)]) {
    await open(page, data);
    const alert = page.locator('[data-stored-image] [role="alert"]');
    await expect(alert).toContainText('Could not load this stored image');
    await expect(page.getByRole('button', { name: 'View stored image' })).toBeDisabled();
    const before = await imageUrls(page);
    await page.getByRole('button', { name: 'Retry image' }).click();
    await expect.poll(() => imageUrls(page)).toBe(before + 1);
    await expect(alert).toContainText('Could not load this stored image');
  }
});
test('with Find open, the image viewer keeps Find keys: Escape closes it first and Find stays open', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  const find = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await expect(find).toBeFocused();
  const trigger = page.getByRole('button', { name: 'View stored image', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Stored image', exact: true });
  const close = dialog.getByRole('button', { name: 'Close image viewer' });
  await expect(close).toBeFocused();
  // The modal viewer is portalled out of Chat; Find must not take focus from behind it.
  await page.keyboard.press('Control+f');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(find).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(find).toHaveCount(0);
});

test('replacing the transcript closes an open viewer and returns focus to the transcript', async ({
  page,
}) => {
  const row = await open(page, png);
  await page.getByRole('button', { name: 'View stored image' }).click();
  await expect(page.getByRole('dialog', { name: 'Stored image', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await window.demo.transcript!.record([
      { id: 'replacement', parts: [{ kind: 'text', text: 'Replacement transcript' }] },
    ]);
    await window.demo.application.chat!.jumpToLatest();
  });
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Stored image', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Chat transcript', exact: true })).toBeFocused();
  await expect(page.getByRole('img', { name: 'Stored image thumbnail' })).toHaveCount(0);
});
test('fixed thumbnail geometry keeps the following Part in place while an image loads', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const gate = Promise.withResolvers<void>();
    Object.assign(window, { releaseImageUrl: () => gate.resolve() });
    const install = () => {
      const native = window.demo?.transcript?.native;
      if (!native) return void setTimeout(install);
      const imageUrl = native.imageUrl.bind(native);
      native.imageUrl = async (...args) => {
        await gate.promise;
        return imageUrl(...args);
      };
    };
    install();
  });
  const row = await open(page);
  const frame = row.getByRole('button', { name: 'View stored image' });
  await expect(frame).toContainText('Loading image…');
  const beforeSize = await frame.boundingBox();
  await page.evaluate(() => {
    const controller = window.demo.application.chat!;
    controller.setTranscriptView({
      anchor: { key: 'entry:stored-image', offset: 12 },
      expanded: controller.getSnapshot().transcript.view.expanded,
    });
  });
  const after = row.locator('[data-transcript-part="m0.b2"]');
  await expect.poll(async () => Math.round((await after.boundingBox())!.y)).toBeGreaterThan(0);
  const before = (await after.boundingBox())!.y;
  await page.evaluate(() => (window as unknown as ImageWindow).releaseImageUrl());
  await expect(frame).toBeEnabled();
  const size = await frame.boundingBox();
  expect(size!.width).toBe(beforeSize!.width);
  expect(size!.height).toBe(beforeSize!.height);
  await expect
    .poll(async () => Math.abs((await after.boundingBox())!.y - before))
    .toBeLessThanOrEqual(1);
});

test('pointer image reading cancels held Find reveal before collapse; only a new exact range reopens its owning Activity', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  await page.evaluate(async (data) => {
    await window.demo.transcript!.record([
      {
        id: 'stored-image',
        role: 'tool',
        parts: [
          { kind: 'image', text: '', data, mimeType: 'image/png', partId: 'image', role: 'tool' },
          {
            kind: 'result',
            text: 'prefix '.repeat(8000) + 'first NEEDLE and second NEEDLE',
            partId: 'result',
            role: 'tool',
          },
        ],
      },
    ]);
    await window.demo.application.chat!.jumpToLatest();
    const command = window.demo.chat.dependencies.chat.command,
      gate = Promise.withResolvers<void>();
    let hold = true;
    Object.assign(window, {
      imageFindHeld: false,
      releaseImageFind: () => {
        hold = false;
        gate.resolve();
      },
    });
    window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
      const reply = await command(operation, input, options);
      if (
        hold &&
        operation === 'getChatTranscriptContent' &&
        'selection' in input &&
        input.selection?.partId === 'result' &&
        'cursor' in input &&
        !!input.cursor
      ) {
        Object.assign(window, { imageFindHeld: true });
        await gate.promise;
      }
      return reply as never;
    };
    window.demo.application.chat!.openFind();
  }, checker);
  const row = page.locator('[data-transcript-entry="stored-image"]');
  const group = row.getByRole('button', { name: /^Activity/ });
  // The image part shows inside its open card; a press on it is the reader reading the image.
  const image = row.locator('[data-transcript-part="image"]').getByText('Stored image', {
    exact: true,
  });
  await page.getByRole('textbox', { name: 'Find in conversation', exact: true }).fill('needle');
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { imageFindHeld: boolean }).imageFindHeld),
    )
    .toBe(true);
  try {
    const first = await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.find.active,
    );
    expect(first?.partId).toBe('result');
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await image.click();
    const manual = await page.evaluate(() => ({
      view: window.demo.application.chat!.getSnapshot().transcript.view,
      find: window.demo.application.chat!.getSnapshot().transcript.find,
    }));
    expect(manual.find.revealing).toBe(false);
    expect(manual.find.active).toEqual(first);
    // The reader's press replaced the Find match's anchor with their own position.
    expect(manual.view.anchor).not.toEqual({
      key: 'entry:stored-image',
      partId: 'result',
      offset: 0,
    });
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() =>
      (window as unknown as { releaseImageFind(): void }).releaseImageFind(),
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.demo.application.chat!.getSnapshot().transcript.content.map((item) => ({
            part: item.selection.partId,
            status: item.status,
            bytes: item.loadedBytes,
          })),
        ),
      )
      .not.toContainEqual(expect.objectContaining({ part: 'result', status: 'loading' }));
    await page.evaluate(() => {
      window.demo.chat.snapshot.message = 'Unchanged Find intent';
      window.demo.chat.controls.receiveChat(structuredClone(window.demo.chat.snapshot));
    });
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(
      await page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript.find.revealing,
      ),
    ).toBe(false);
    expect(
      await page.evaluate(() => window.demo.application.chat!.getSnapshot().transcript.view.anchor),
    ).toEqual(manual.view.anchor);
    await page.getByRole('textbox', { name: 'Find in conversation', exact: true }).press('Enter');
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          revealing: window.demo.application.chat!.getSnapshot().transcript.find.revealing,
          content: window.demo.application.chat!.getSnapshot().transcript.content.map((item) => ({
            part: item.selection.partId,
            status: item.status,
            bytes: item.loadedBytes,
            cursor: item.nextCursor,
            error: item.error,
          })),
        })),
      )
      .toEqual({
        revealing: true,
        content: expect.arrayContaining([
          expect.objectContaining({ part: 'result', status: 'complete' }),
        ]),
      });
    await expect
      .poll(() => readFindHighlight(page))
      .toEqual([expect.objectContaining({ text: 'NEEDLE', part: 'result' })]);
    const next = await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.find.active,
    );
    expect(next?.partId).toBe('result');
    expect(next?.start).toBeGreaterThan(first!.start);
  } finally {
    await page.evaluate(() =>
      (window as unknown as { releaseImageFind(): void }).releaseImageFind(),
    );
  }
});
