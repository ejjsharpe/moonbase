import { test, expect, type Page } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { crc32 } from 'node:zlib';
type ImageWindow = Window & {
  imageStats: { decoded: number; closed: number; reads: number; bytes: number };
  releaseImage(): void;
  releaseRead(): void;
};
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
const output = resolve('../../test-results/transcript-113-integration');
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
      const decode = window.createImageBitmap.bind(window);
      const stats = ((window as unknown as ImageWindow).imageStats = {
        decoded: 0,
        closed: 0,
        reads: 0,
        bytes: 0,
      });
      window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
        const bitmap = (await Reflect.apply(decode, window, args)) as ImageBitmap;
        stats.decoded++;
        const close = bitmap.close.bind(bitmap);
        bitmap.close = () => {
          stats.closed++;
          close();
        };
        return bitmap;
      }) as typeof createImageBitmap;
      const command = window.demo.chat.dependencies.chat.command;
      window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
        if (operation === 'getChatTranscriptContent' && 'selection' in input && input.selection)
          stats.reads++;
        return command(operation, input, options) as never;
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
  const disclosure = row.getByRole('button', { name: /^Stored image/ });
  await disclosure.scrollIntoViewIfNeeded();
  // Let compact-window scroll capture settle before choosing a pointer toggle intent.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
  await row.locator('[data-stored-image]').scrollIntoViewIfNeeded();
  return row;
}
const stats = (page: Page) => page.evaluate(() => (window as unknown as ImageWindow).imageStats);
test('retained PNG/JPEG thumbnails and one keyboard viewer trap/restore focus, close bitmap resources and fit normal/compact/200%', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://example.com')) external.push(request.url());
  });
  await open(page);
  const trigger = page.getByRole('button', { name: 'View stored image', exact: true });
  await expect(trigger).toBeEnabled();
  await expect(page.getByRole('img', { name: 'Stored image thumbnail' })).toHaveAttribute(
    'width',
    '256',
  );
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
    expect(await page.locator('canvas[aria-label="Recorded image"]').count()).toBe(0);
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
  await expect
    .poll(async () => {
      const value = await stats(page);
      return value.decoded - value.closed;
    })
    .toBe(0);
  expect(external).toEqual([]);
  await open(page, jpeg, 'image/jpeg');
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  await expect(page.getByRole('img', { name: 'Stored image thumbnail' })).toHaveAttribute(
    'height',
    '128',
  );
  await open(page, tall);
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  await expect(page.getByRole('img', { name: 'Stored image thumbnail' })).toHaveAttribute(
    'height',
    '180',
  );
  await page.getByRole('button', { name: 'View stored image' }).click();
  const viewer = page.getByRole('dialog', { name: 'Stored image', exact: true });
  await expect(viewer.getByRole('img', { name: 'Recorded image' })).toBeVisible();
  const viewport = viewer.getByLabel('Image viewport', { exact: true });
  expect(await viewport.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await viewport.focus();
  await page.keyboard.press('End');
  await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(viewer.getByRole('button', { name: 'Close image viewer' })).toBeInViewport();
  await page.screenshot({ path: resolve(output, 'tall-overflow.png') });
  await page.keyboard.press('Escape');
});
for (const [name, data, mime, message, readable] of [
  ['PNG bytes labelled JPEG', png, 'image/jpeg', /corrupt/, true],
  ['scriptable SVG', btoa('<svg onload="alert(1)"/>'), 'image/svg+xml', /unsupported/, false],
  [
    'HTML labelled PNG',
    btoa('<html><script>alert(1)</script></html>'),
    'image/png',
    /corrupt/,
    true,
  ],
  ['truncated PNG', png.slice(0, 40), 'image/png', /corrupt/, true],
] as const)
  test(`stored image validation rejects ${name} without decoding`, async ({ page }) => {
    await open(page, data, mime);
    await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
    const observed = await stats(page);
    expect(observed.decoded).toBe(0);
    if (readable) expect(observed.reads).toBeGreaterThan(0);
    else expect(observed.reads).toBe(0);
  });

test('stored image validation rejects huge CRC-valid PNG dimensions before decoding', async ({
  page,
}) => {
  const huge = Buffer.from(png, 'base64');
  huge.writeUInt32BE(100000, 16);
  huge.writeUInt32BE(crc32(huge.subarray(12, 29)), 29);
  await open(page, huge.toString('base64'));
  await expect(page.getByRole('alert').filter({ hasText: /megapixel/ })).toBeVisible();
  expect((await stats(page)).decoded).toBe(0);
});

test('stored image validation rejects oversized source before reading or decoding', async ({
  page,
}) => {
  await open(page, Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'));
  await expect(page.getByRole('alert').filter({ hasText: /4 MiB/ })).toBeVisible();
  expect((await stats(page)).reads).toBe(0);
  expect((await stats(page)).decoded).toBe(0);
});

test('stored image validation reports unavailable source without reading or decoding', async ({
  page,
}) => {
  await open(page, checker, 'image/png', 'unavailable');
  await expect(page.locator('[data-stored-image] [role="alert"]')).toContainText('unavailable');
  expect((await stats(page)).reads).toBe(0);
  expect((await stats(page)).decoded).toBe(0);
});

test('stored image validation keeps UTF8 image descriptors out of text hydration and Copy', async ({
  page,
}) => {
  await open(page, checker, 'image/png', 'unavailable');
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
  await page.getByRole('button', { name: 'Stored image', exact: true }).press('Enter');
  await expect(page.locator('[data-stored-image] [role="alert"]')).toContainText('corrupt');
  expect((await stats(page)).reads).toBe(0);
  expect((await stats(page)).decoded).toBe(0);
  const row = page.locator('[data-transcript-entry="wrong-encoding"]');
  await expect(row.getByRole('button', { name: 'Copy part', exact: true })).toHaveCount(0);
  await expect(row).not.toContainText('<html>not binary image data</html>');
});

test('stored image validation rechecks corrupt bytes on explicit Retry without decoding', async ({
  page,
}) => {
  const corrupt = Buffer.from(png, 'base64');
  corrupt[41] ^= 255;
  await open(page, corrupt.toString('base64'));
  const alert = page.locator('[data-stored-image] [role="alert"]');
  await expect(alert).toContainText('corrupt');
  const reads = (await stats(page)).reads;
  expect(reads).toBeGreaterThan(0);
  expect((await stats(page)).decoded).toBe(0);
  await page.getByRole('button', { name: 'Retry image' }).click();
  await expect.poll(async () => (await stats(page)).reads).toBeGreaterThan(reads);
  await expect(alert).toContainText('corrupt');
  expect((await stats(page)).decoded).toBe(0);
});
test('collapsed Activity, offscreen content and eviction release canvases without relying on child unmount', async ({
  page,
}) => {
  const row = await open(page, png);
  const canvas = row.locator('canvas[aria-label="Stored image thumbnail"]');
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  expect((await stats(page)).reads).toBeGreaterThan(1); // independently padded multi-chunk fixture
  await row.getByRole('button', { name: /^Activity/ }).press('Enter');
  await expect(canvas).toBeAttached();
  await expect(canvas).toHaveAttribute('width', '0');
  const reads = (await stats(page)).reads;
  await page.waitForTimeout(100);
  expect((await stats(page)).reads).toBe(reads);
  await row.getByRole('button', { name: /^Activity/ }).press('Enter');
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  await page.evaluate(() =>
    window.demo.transcript!.live('Long output below the stored image.\n\n'.repeat(200)),
  );
  await page
    .getByRole('region', { name: 'Chat transcript', exact: true })
    .evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await expect(canvas).toHaveAttribute('width', '0');
  await row.locator('[data-stored-image]').scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
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
  expect((await stats(page)).decoded).toBe((await stats(page)).closed);
  await expect(page.locator('canvas[aria-label="Stored image thumbnail"]')).toHaveCount(0);
});
test('held image read/decode is fenced on collapse and source replacement; late bitmap closes without publishing', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      const bitmap = (await Reflect.apply(decode, window, args)) as ImageBitmap;
      await new Promise<void>((resolve) => {
        (window as unknown as ImageWindow).releaseImage = resolve;
      });
      return bitmap;
    }) as typeof createImageBitmap;
  });
  await page.getByRole('button', { name: 'View stored image' }).click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as ImageWindow).releaseImage))
    .toBe('function');
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as unknown as ImageWindow).releaseImage());
  await expect
    .poll(async () => {
      const value = await stats(page);
      return value.decoded - value.closed;
    })
    .toBe(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => {
    const command = window.demo.chat.dependencies.chat.command;
    window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
      if (operation === 'getChatTranscriptContent' && 'selection' in input && input.selection) {
        await new Promise<void>((resolve) => {
          (window as unknown as ImageWindow).releaseRead = resolve;
        });
      }
      return command(operation, input, options) as never;
    };
  });
  const activity = page.getByRole('button', { name: /^Activity/ });
  await activity.click();
  await activity.click();
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as ImageWindow).releaseRead))
    .toBe('function');
  await page.evaluate(async () => {
    await window.demo.transcript!.record([
      { id: 'new-source', parts: [{ kind: 'text', text: 'A different source' }] },
    ]);
    await window.demo.application.chat!.jumpToLatest();
    (window as unknown as ImageWindow).releaseRead();
  });
  await expect(page.getByText('A different source', { exact: true })).toBeVisible();
  await expect(page.locator('[data-stored-image]')).toHaveCount(0);
  expect((await stats(page)).decoded).toBe((await stats(page)).closed);
});

test('reserved thumbnail geometry and the shared resize anchor retain the exact Part while decoding settles', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const decode = window.createImageBitmap.bind(window);
    let first = true;
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      const bitmap = (await Reflect.apply(decode, window, args)) as ImageBitmap;
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          (window as unknown as ImageWindow).releaseImage = resolve;
        });
      }
      return bitmap;
    }) as typeof createImageBitmap;
  });
  const row = await open(page);
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as ImageWindow).releaseImage))
    .toBe('function');
  const frame = row.getByRole('button', { name: 'View stored image' });
  const beforeSize = await frame.boundingBox();
  await page.evaluate(() => {
    const controller = window.demo.application.chat!;
    controller.setTranscriptView({
      anchor: { entryId: 'stored-image', partId: 'm0.b2', offset: 12 },
      expanded: controller.getSnapshot().transcript.view.expanded,
    });
  });
  const after = row.locator('[data-transcript-part="m0.b2"]');
  await expect.poll(async () => Math.round((await after.boundingBox())!.y)).toBeGreaterThan(0);
  const before = (await after.boundingBox())!.y;
  await page.evaluate(() => (window as unknown as ImageWindow).releaseImage());
  await expect(frame).toBeEnabled();
  const size = await frame.boundingBox();
  expect(size!.width).toBe(beforeSize!.width);
  expect(size!.height).toBe(beforeSize!.height);
  await expect
    .poll(async () => Math.abs((await after.boundingBox())!.y - before))
    .toBeLessThanOrEqual(1);
});

test('panel removal joins a held actual image read and a late result cannot enter a replacement view', async ({
  page,
}) => {
  const row = await open(page);
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  await row.getByRole('button', { name: /^Activity/ }).press('Enter');
  await page.evaluate(() => {
    const command = window.demo.chat.dependencies.chat.command;
    window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
      const reply = await command(operation, input, options);
      if (operation === 'getChatTranscriptContent' && 'selection' in input && input.selection)
        await new Promise<void>((resolve) => {
          (window as unknown as ImageWindow).releaseRead = resolve;
        });
      return reply as never;
    };
  });
  await row.getByRole('button', { name: /^Activity/ }).press('Enter');
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as ImageWindow).releaseRead))
    .toBe('function');
  await page.getByRole('button', { name: 'Close Chat panel', exact: true }).click();
  await expect(page.locator('[data-stored-image]')).toHaveCount(0);
  expect(
    await page.evaluate(() => window.demo.application.getSnapshot().cleanup.pending),
  ).toContain('chat');
  await page.evaluate(() => (window as unknown as ImageWindow).releaseRead());
  await expect
    .poll(() => page.evaluate(() => window.demo.application.getSnapshot().cleanup.pending))
    .toEqual([]);
  expect((await stats(page)).decoded).toBe((await stats(page)).closed);
});

test('replacing the selected conversation cannot reset capacity held by cancelled platform decodes', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window),
      releases: (() => void)[] = [];
    const control = window as unknown as ImageWindow & { imageWaits: number; finishImages(): void };
    control.imageWaits = 0;
    control.finishImages = () => {
      window.createImageBitmap = decode;
      for (const release of releases) release();
    };
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      const bitmap = (await Reflect.apply(decode, window, args)) as ImageBitmap;
      control.imageWaits++;
      await new Promise<void>((resolve) => releases.push(resolve));
      return bitmap;
    }) as typeof createImageBitmap;
  });
  try {
    for (let iteration = 1; iteration <= 3; iteration++) {
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByRole('button', { name: /^Conversation/ }).click();
      const group = page.getByRole('button', { name: /^Activity/ });
      if ((await group.getAttribute('aria-expanded')) !== 'true') await group.press('Enter');
      const part = page.getByRole('button', { name: 'Stored image', exact: true });
      if ((await part.getAttribute('aria-expanded')) !== 'true') await part.press('Enter');
      await page.locator('[data-stored-image]').scrollIntoViewIfNeeded();
      if (iteration < 3)
        await expect
          .poll(() => page.evaluate(() => (window as unknown as { imageWaits: number }).imageWaits))
          .toBe(iteration);
      else
        await expect(page.locator('[data-stored-image] [role="alert"]')).toContainText(
          'resources are busy',
        );
    }
    expect(
      await page.evaluate(() => (window as unknown as { imageWaits: number }).imageWaits),
    ).toBe(2);
  } finally {
    await page.evaluate(() => (window as unknown as { finishImages(): void }).finishImages());
  }
  await expect
    .poll(async () => {
      const current = await stats(page);
      return current.decoded - current.closed;
    })
    .toBe(0);
  await page.getByRole('button', { name: 'Retry image' }).click();
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
});

test('ignored-abort controller IO retains view capacity until the actual reads settle', async ({
  page,
}) => {
  const row = await open(page);
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  const group = row.getByRole('button', { name: /^Activity/ });
  await group.press('Enter');
  await page.evaluate(() => {
    const command = window.demo.chat.dependencies.chat.command,
      releases: (() => void)[] = [];
    const control = window as unknown as { imageReadWaits: number; finishImageReads(): void };
    control.imageReadWaits = 0;
    control.finishImageReads = () => {
      window.demo.chat.dependencies.chat.command = command;
      for (const release of releases) release();
    };
    window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
      const reply = await command(operation, input, options);
      if (operation === 'getChatTranscriptContent' && 'selection' in input && input.selection) {
        control.imageReadWaits++;
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return reply as never;
    };
  });
  try {
    for (let iteration = 1; iteration <= 3; iteration++) {
      await group.press('Enter');
      await row.locator('[data-stored-image]').scrollIntoViewIfNeeded();
      if (iteration < 3) {
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as { imageReadWaits: number }).imageReadWaits),
          )
          .toBe(iteration);
        await group.press('Enter');
      } else
        await expect(page.locator('[data-stored-image] [role="alert"]')).toContainText(
          'resources are busy',
        );
    }
    expect(
      await page.evaluate(() => (window as unknown as { imageReadWaits: number }).imageReadWaits),
    ).toBe(2);
  } finally {
    await page.evaluate(() =>
      (window as unknown as { finishImageReads(): void }).finishImageReads(),
    );
  }
  await page.getByRole('button', { name: 'Retry image' }).click();
  await expect(page.getByRole('button', { name: 'View stored image' })).toBeEnabled();
});

test('a cancelled late thumbnail decode cannot clear the newer visible canvas after Activity reopens', async ({
  page,
}) => {
  const row = await open(page);
  const trigger = row.getByRole('button', { name: 'View stored image' });
  await expect(trigger).toBeEnabled();
  const group = row.getByRole('button', { name: /^Activity/ });
  await group.press('Enter');
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    let first = true;
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      const bitmap = (await Reflect.apply(decode, window, args)) as ImageBitmap;
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          (window as unknown as ImageWindow).releaseImage = resolve;
        });
      }
      return bitmap;
    }) as typeof createImageBitmap;
  });
  await group.press('Enter');
  await expect
    .poll(() => page.evaluate(() => typeof (window as unknown as ImageWindow).releaseImage))
    .toBe('function');
  await group.press('Enter');
  await group.press('Enter');
  await expect(trigger).toBeEnabled();
  const canvas = row.getByRole('img', { name: 'Stored image thumbnail' });
  await expect(canvas).toHaveAttribute('width', '256');
  await page.evaluate(() => (window as unknown as ImageWindow).releaseImage());
  await expect
    .poll(async () => {
      const current = await stats(page);
      return current.decoded - current.closed;
    })
    .toBe(0);
  await expect(canvas).toHaveAttribute('width', '256');
  await expect(canvas).toHaveAttribute('height', '128');
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Stored image', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('pointer image and Activity disclosures retain pre-input intent and newer current view through a held manifest', async ({
  page,
}) => {
  const row = await open(page);
  const image = row.getByRole('button', { name: 'Stored image', exact: true });
  const group = row.getByRole('button', { name: /^Activity/ });
  await expect(row.getByRole('button', { name: 'View stored image' })).toBeEnabled();
  await page.evaluate(() => {
    const command = window.demo.chat.dependencies.chat.command,
      gate = Promise.withResolvers<void>();
    Object.assign(window, { imageManifestHeld: false, releaseImageManifest: () => gate.resolve() });
    window.demo.chat.dependencies.chat.command = async (operation, input, options) => {
      if (operation === 'getChatTranscriptContent' && !('selection' in input)) {
        Object.assign(window, { imageManifestHeld: true });
        await gate.promise;
      }
      return command(operation, input, options) as never;
    };
    const controller = window.demo.application.chat!;
    controller.setTranscriptView({
      anchor: { entryId: 'stored-image', partId: 'image', offset: 13 },
      expanded: controller.getSnapshot().transcript.view.expanded,
    });
    void controller.loadTranscriptManifest(
      controller.getSnapshot().transcript.entries[0]!.transcript!.source,
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { imageManifestHeld: boolean }).imageManifestHeld),
    )
    .toBe(true);
  try {
    const box = (await image.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const newer = await page.evaluate(() => {
      const controller = window.demo.application.chat!;
      const view = {
        anchor: { entryId: 'stored-image', partId: 'image', offset: 27 },
        expanded: [...controller.getSnapshot().transcript.view.expanded, 'newer-image-capture'],
      };
      controller.setTranscriptView(view);
      return view;
    });
    await page.mouse.up();
    await expect(image).toHaveAttribute('aria-expanded', 'false');
    const observed = await page.evaluate(
      () => window.demo.application.chat!.getSnapshot().transcript.view,
    );
    expect(observed.anchor).toEqual(newer.anchor);
    expect(observed.expanded).toContain('newer-image-capture');
    await page.evaluate(() =>
      (window as unknown as { releaseImageManifest(): void }).releaseImageManifest(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => window.demo.application.chat!.getSnapshot().transcript.manifest?.status,
        ),
      )
      .toBe('complete');
    await expect(image).toHaveAttribute('aria-expanded', 'false');
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect(image).toHaveAttribute('aria-expanded', 'false');
    await image.click();
    await expect(row.getByRole('button', { name: 'View stored image' })).toBeEnabled();
    await image.click();
    await expect(image).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await page.evaluate(() =>
      (window as unknown as { releaseImageManifest(): void }).releaseImageManifest(),
    );
  }
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
  const image = row.getByRole('button', { name: 'Stored image', exact: true });
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
    await image.click();
    await expect(image).toHaveAttribute('aria-expanded', 'false');
    const manual = await page.evaluate(() => ({
      view: window.demo.application.chat!.getSnapshot().transcript.view,
      find: window.demo.application.chat!.getSnapshot().transcript.find,
    }));
    expect(manual.find.revealing).toBe(false);
    expect(manual.find.active).toEqual(first);
    expect(manual.view.anchor?.entryId).toBe('stored-image');
    expect(manual.view.anchor).not.toEqual({
      entryId: 'stored-image',
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
    await expect(image).toHaveAttribute('aria-expanded', 'false');
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
    await expect(row.locator('[data-transcript-find-match]')).toHaveText('NEEDLE');
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

test('a partially visible oldest image viewer remains stable when first live output arrives at the 128-row budget', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async (data) => {
    await window.demo.transcript!.record(
      Array.from({ length: 180 }, (_, index) => ({
        id: `image-row-${index}`,
        role: index === 52 ? ('tool' as const) : ('assistant' as const),
        parts:
          index === 52
            ? [
                {
                  kind: 'image' as const,
                  text: '',
                  data,
                  mimeType: 'image/png',
                  partId: 'image',
                  role: 'tool' as const,
                },
              ]
            : [
                {
                  kind: 'text' as const,
                  text: `Saved row ${index}\n\nReadable retained paragraph.`,
                },
              ],
      })),
    );
    const controller = window.demo.application.chat!;
    await controller.jumpToLatest();
    for (let index = 0; index < 4; index++) await controller.older();
    for (let index = 0; index < 8 && !controller.getSnapshot().transcript.atLatest; index++)
      await controller.later();
  }, checker);
  await expect(page.locator('[data-transcript-entry]')).toHaveCount(128);
  const oldest = page.locator('[data-transcript-entry="image-row-52"]');
  await expect(page.locator('[data-transcript-entry]').first()).toHaveAttribute(
    'data-transcript-entry',
    'image-row-52',
  );
  await oldest.getByRole('button', { name: /^Activity/ }).click();
  await oldest.getByRole('button', { name: 'Stored image', exact: true }).click();
  const trigger = oldest.getByRole('button', { name: 'View stored image' });
  await oldest.locator('[data-stored-image]').scrollIntoViewIfNeeded();
  await expect(trigger).toBeEnabled();
  const thumbnail = await oldest
    .getByRole('img', { name: 'Stored image thumbnail' })
    .elementHandle();
  const region = page.getByRole('region', { name: 'Chat transcript', exact: true });
  await region.dispatchEvent('wheel', { deltaY: 1 });
  await region.evaluate((element) => {
    const part = element.querySelector('[data-transcript-entry] [data-transcript-part]')!;
    const top = element.querySelector('[data-transcript-chrome]')!.getBoundingClientRect().bottom;
    element.scrollTop += part.getBoundingClientRect().top - top + 35;
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => window.demo.application.chat!.getSnapshot().transcript.view.anchor?.entryId,
      ),
    )
    .not.toBe('image-row-52');
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Stored image', exact: true });
  await expect(dialog.getByRole('img', { name: 'Recorded image' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close image viewer' })).toBeFocused();
  const anchor = await page.evaluate(
    () => window.demo.application.chat!.getSnapshot().transcript.view.anchor,
  );
  expect(anchor?.entryId).not.toBe('image-row-52');
  await page.evaluate(() =>
    window.demo.transcript!.live('First live output with the image viewer open'),
  );
  await expect(dialog).toBeVisible();
  await expect(oldest).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Close image viewer' })).toBeFocused();
  await expect(page.locator('[data-transcript-entry], [data-transcript-live]')).toHaveCount(128);
  await expect(page.locator('[data-transcript-live]')).toHaveCount(0);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'oldest-image-viewer.png') });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
  await expect(page.locator('[data-transcript-live]')).toContainText(
    'First live output with the image viewer open',
  );
  await expect(page.locator('[data-transcript-entry], [data-transcript-live]')).toHaveCount(128);
  await expect(oldest).toHaveCount(0);
  expect(
    await thumbnail!.evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      return [canvas.width, canvas.height];
    }),
  ).toEqual([0, 0]);
  expect((await stats(page)).decoded).toBe((await stats(page)).closed);
});
