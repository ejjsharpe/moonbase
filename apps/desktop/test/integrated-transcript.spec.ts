import {
  test,
  expect,
  _electron as electron,
  type Page,
  type ElectronApplication,
} from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { controlledHostFixture, until } from '../../../tests/chat/fixture.ts';
import { createRemoteChat, selectRemoteChat } from './chat-target.ts';
import { captureNative } from './editor-regressions.ts';
import { readFindHighlight } from './find-highlight.ts';
import { openActivity } from './transcript-list.ts';
import { findTestBun, prepareDaemonData, stopDaemon } from './faux-daemon.mjs';

const transcriptRegion = (page: Page) =>
  page.getByRole('region', { name: 'Chat transcript', exact: true });

type Control = {
  calls: { kind: string; operation: string }[];
  copied: string[];
  beforeMain: boolean;
};
declare global {
  var integratedTranscript: Control;
}
const packaged = !!process.env.MOONBASE_PACKAGED_TEST;
const children = new WeakMap<ElectronApplication, ReturnType<ElectronApplication['process']>>();
type Host = Awaited<ReturnType<typeof controlledHostFixture>>;
async function recordEvidence(name: string, value: unknown) {
  await mkdir(test.info().outputDir, { recursive: true });
  const path = test.info().outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await test.info().attach(name, { path, contentType: 'application/json' });
}
async function launch(directory: string, host?: Host) {
  const launcher = join(directory, 'package-launcher');
  await prepareDaemonData(join(directory, 'desktop'));
  if (packaged) {
    if (/\s/.test(process.execPath))
      throw Error('Controlled Node executable path contains whitespace');
    await writeFile(
      launcher,
      `#!${process.execPath}\nvoid import(${JSON.stringify(pathToFileURL(resolve('test/package-transcript-launcher.mjs')).href)});\n`,
      { mode: 0o700 },
    );
  }
  const app = await electron.launch({
    ...(packaged
      ? {
          executablePath: launcher,
        }
      : {}),
    args: packaged ? [] : ['-r', resolve('test/integrated-harness.cjs'), resolve('dist/main.mjs')],
    env: {
      PATH: '/usr/bin:/bin',
      PI_CLAUDE_CODE_COMMAND: '/nonexistent/claude',
      HOME: process.env.HOME!,
      TMPDIR: process.env.TMPDIR!,
      MOONBASE_USER_DATA: join(directory, 'desktop'),
      MOONBASE_TEST_BUN: findTestBun(),
      ...(host
        ? { MOONBASE_CHAT_CONFIG: host.clientConfig, MOONBASE_CHAT_FORWARD_LOG: host.log }
        : {}),
    },
  });
  children.set(app, app.process());
  const page = await app.firstWindow();
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(packaged);
  expect(await app.evaluate(() => !!globalThis.integratedTranscript)).toBe(true);
  expect(await app.evaluate(() => globalThis.integratedTranscript.beforeMain)).toBe(true);
  expect(page.url()).toBe('moonbase://editor/index.html');
  await page.evaluate(() => {
    Object.assign(window, { integratedViolations: [] as string[] });
    window.addEventListener('securitypolicyviolation', (event) =>
      (window as typeof window & { integratedViolations: string[] }).integratedViolations.push(
        event.violatedDirective,
      ),
    );
  });
  return { app, page };
}
async function quit(app: ElectronApplication) {
  const child = children.get(app)!,
    pids = await app.evaluate(({ app }) => app.getAppMetrics().map((value) => value.pid));
  await app.evaluate(({ app }) => app.quit());
  await expect
    .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
    .toBe(true);
  expect(child.exitCode).toBe(0);
  for (const pid of pids)
    await until(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }, Boolean);
  await recordEvidence('process-cleanup', {
    launcherPid: child.pid,
    pids,
    absent: true,
    normalQuit: true,
  });
}
async function cleanup(app: ElectronApplication | undefined, host?: Host) {
  const child = app && children.get(app);
  try {
    if (app && child && child.exitCode === null && child.signalCode === null) {
      await test.info().attach('failed-test-cleanup', {
        body: 'Normal journey did not finish; releasing the owned test connection before forced failure cleanup.',
      });
      await app
        .windows()[0]
        ?.evaluate(async () => {
          const reply = await window.moonbaseChat.call(
            'connection',
            'getConnection',
            {},
            crypto.randomUUID(),
            'remote',
          );
          if (reply.ok && (reply.value as { connectionId: string | null }).connectionId)
            await window.moonbaseChat.call(
              'connection',
              'disconnect',
              { connectionId: (reply.value as { connectionId: string }).connectionId },
              crypto.randomUUID(),
              'remote',
            );
        })
        .catch(() => {});
      await app.evaluate(({ app }) => app.exit(1));
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
  } finally {
    // The daemon outlives the app; this test's is stopped with it.
    if (host) await stopDaemon(join(host.directory, 'desktop', 'daemon-v1'));
    if (host) await recordEvidence('host-cleanup', await host.close());
  }
}
async function find(page: Page, query: string) {
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Find in conversation', exact: true });
  await field.fill(query);
  await expect
    .poll(() => readFindHighlight(page))
    .toEqual([expect.objectContaining({ text: query, visible: true })]);
  await expect(field).toBeFocused();
  await field.press('Escape');
}
async function image(app: ElectronApplication, page: Page) {
  const group = page
    .locator('[data-transcript-activity]')
    .filter({ has: page.locator('[data-transcript-part]').filter({ hasText: 'Stored image' }) })
    .first();
  // The image is the read call's output, recorded in a later row with no opener of its own; the
  // call's step opens it.
  await openActivity(transcriptRegion(page));
  const trigger = group.getByRole('button', { name: 'View stored image', exact: true }).first();
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const viewer = page.getByRole('dialog', { name: 'Stored image', exact: true });
  await expect(viewer.getByRole('img', { name: 'Recorded image' })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Close image viewer' })).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await viewer.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await captureNative(
    app,
    page,
    test.info().outputPath(`${packaged ? 'package' : 'source'}-image.png`),
  );
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as typeof window & { integratedViolations: string[] }).integratedViolations,
    ),
  ).toEqual([]);
}

test('integrated remote archive/runtime reveals early/middle/end Find in real history and streams held progress without polling', async () => {
  const host = await controlledHostFixture(
    new URL('../../../tests/chat/faux-stream.mjs', import.meta.url),
    true,
  );
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(host.directory, host);
    app = launched.app;
    const { page } = launched;
    await selectRemoteChat(page);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await createRemoteChat(page, 'Integrated remote retained history');
    const target = await page.evaluate(
      () => JSON.parse(localStorage.getItem('moonbase.chat.remote.v2')!).selected,
    );
    const ids = await host.seedHistory(target);
    for (const index of [1, 561, 1119]) await find(page, `record ${index} 🌔`);
    // Jump to latest shows only off the end; the last Find may already have reached it.
    const jump = page.getByRole('button', { name: 'Jump to latest', exact: true });
    if (await jump.isVisible()) await jump.click();
    await page.getByLabel('Message', { exact: true }).fill('Held remote source');
    const sentAt = Date.now();
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const live = page.getByRole('article', { name: 'Live response' });
    await expect(live.getByText('first remote text 0', { exact: true })).toBeVisible();
    const firstVisibleMs = Date.now() - sentAt,
      before = await host.stats();
    host.nextChunk();
    await expect(live.getByText('first remote text 4', { exact: true })).toBeVisible();
    const after = await host.stats();
    expect(after.commands.filter((operation) => operation === 'getChat').length).toBe(
      before.commands.filter((operation) => operation === 'getChat').length,
    );
    expect(after.reads).toEqual(before.reads);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(live).toHaveCount(0);
    await until(host.stats, (value) => value.activeWatches === 1);
    await recordEvidence('stream-timing', {
      packaged,
      firstVisibleMs,
      rows: ids.length,
      before,
      after,
    });
    await quit(app);
    await until(host.stats, (value) => value.activeWatches === 0);
    expect(
      (await host.stats()).commands.filter((operation) => operation === 'stopChat'),
    ).toHaveLength(1);
  } finally {
    await cleanup(app, host);
  }
});

test('integrated remote archive/runtime displays retained images with production CSP and releases its viewer @packaged', async () => {
  const host = await controlledHostFixture(new URL('./stored-image-faux.mjs', import.meta.url));
  let app: ElectronApplication | undefined;
  try {
    const launched = await launch(host.directory, host);
    app = launched.app;
    const { page } = launched;
    await selectRemoteChat(page);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await createRemoteChat(page, 'Integrated remote image');
    await page.getByLabel('Message', { exact: true }).fill('Retain a controlled image');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('Retained images completed', { exact: true })).toBeVisible();
    await find(page, 'Retained images completed');
    await image(app, page);
    expect(await app.evaluate(() => globalThis.integratedTranscript.copied)).toEqual([]);
    await quit(app);
    await until(host.stats, (value) => value.activeWatches === 0);
  } finally {
    await cleanup(app, host);
  }
});
