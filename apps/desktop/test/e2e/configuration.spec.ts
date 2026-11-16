import { waitForExit } from '../fixtures/app-fixture.ts';
import { findTestBun, prepareDaemonData, stopDaemon } from '../fixtures/faux-daemon.mjs';
import { closeSettings, openSettings, selectRemoteChat } from '../fixtures/chat-fixture.ts';
import { disconnectHost, getConnection } from '../fixtures/window-ipc-fixture.ts';
import { test, expect, _electron as electron } from '@playwright/test';
import { fixture } from '../../../../test/chat/tool-fixture.ts';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  packaged = !!process.env.MOONBASE_PACKAGED_TEST;
const executable = packaged
  ? (process.env.MOONBASE_RELOAD_EXECUTABLE ??
    resolve('release/mac-arm64/Moonbase.app/Contents/MacOS/Moonbase'))
  : require('electron');
const args = packaged
  ? []
  : [
      '-r',
      resolve('test/fixtures/faux-daemon-preload.cjs'),
      process.env.MOONBASE_RELOAD_MAIN ?? resolve('dist/main.mjs'),
    ];
const platform = {
  PATH: '/usr/bin:/bin',
  HOME: process.env.HOME!,
  TMPDIR: process.env.TMPDIR!,
  // Never probe or use the developer's own Claude Code login.
  PI_CLAUDE_CODE_COMMAND: '/nonexistent/claude',
  MOONBASE_TEST_BUN: findTestBun(),
};

// readConfiguration's unit test covers each way a file is refused; one launch shows main exits on it.
test('an invalid configuration fails startup', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-config-invalid-')));
  writeFileSync(join(base, 'malformed.json'), '{not-json', { mode: 0o600 });
  try {
    const child = spawn(executable, args, {
      env: {
        ...platform,
        MOONBASE_USER_DATA: join(base, 'data'),
        MOONBASE_CHAT_CONFIG: join(base, 'malformed.json'),
      },
      detached: true,
      stdio: 'ignore',
    });
    const outcome = await new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })),
    ).finally(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // The group has gone.
      }
    });
    expect(outcome).toEqual({ code: 1, signal: null });
  } finally {
    rmSync(base, { recursive: true });
  }
});

for (const configured of [false, true])
  test(`${configured ? 'valid private' : 'absent'} configuration starts without automatic Connect or Send`, async () => {
    const f = configured ? await fixture() : undefined;
    const before = await f?.stats();
    const base =
      f?.directory ?? realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-config-absent-')));
    await prepareDaemonData(join(base, 'desktop'));
    const app = await electron.launch({
      executablePath: executable,
      args,
      env: {
        ...platform,
        MOONBASE_USER_DATA: join(base, 'desktop'),
        ...(f ? { MOONBASE_CHAT_CONFIG: f.clientConfig, MOONBASE_CHAT_FORWARD_LOG: f.log } : {}),
      },
    });
    const child = app.process(),
      pids = new Set<number>([child.pid!]);
    try {
      const page = await app.firstWindow();
      await expect(page.getByRole('button', { name: 'Open checkout', exact: true })).toBeVisible();
      await page
        .getByRole('tablist', { name: 'Workbench views', exact: true })
        .getByRole('tab', { name: 'Agents', exact: true })
        .click();
      await expect(
        (await openSettings(page)).getByText('Local ready', { exact: true }),
      ).toBeVisible();
      await closeSettings(page);
      if (configured) {
        await selectRemoteChat(page);
        await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled();
        const stats = await f!.stats();
        expect(stats.calls).toBe(0);
        expect(stats.tools).toBe(0);
        expect(stats.commands).toEqual(before!.commands);
        const status = await getConnection(page);
        expect(status).toMatchObject({
          ok: true,
          value: { state: 'disconnected', connectionId: null },
        });
      } else {
        await expect(
          (await openSettings(page, 'Providers')).getByRole('button', {
            name: 'Sign in to ChatGPT subscription',
            exact: true,
          }),
        ).toBeVisible();
        await closeSettings(page);
        await expect(
          page.getByRole('button', { name: 'Choose working folder', exact: true }),
        ).toBeVisible();
      }
    } finally {
      try {
        for (const pid of await app.evaluate(({ app }) =>
          app.getAppMetrics().map((value) => value.pid),
        ))
          pids.add(pid);
        await disconnectHost(app.windows()[0]!);
        await app.evaluate(({ app }) => app.exit(0));
        await waitForExit(child);
        for (const pid of pids)
          await expect
            .poll(() => {
              try {
                process.kill(pid, 0);
                return false;
              } catch (error) {
                return (error as NodeJS.ErrnoException).code === 'ESRCH';
              }
            })
            .toBe(true);
      } finally {
        // A daemon outlives its app: stop it even when the steps before fail.
        await stopDaemon(join(base, 'desktop', 'daemon-v1'));
      }
      await f?.close();
      if (!f) rmSync(base, { recursive: true });
    }
  });

test('a new chat on a remote daemon host chooses a folder from its approved roots and its default model', async () => {
  const f = await fixture();
  const site = join(f.cwd, 'site');
  mkdirSync(site);
  const base = f.directory;
  await prepareDaemonData(join(base, 'desktop'));
  const app = await electron.launch({
    executablePath: executable,
    args,
    env: {
      ...platform,
      MOONBASE_USER_DATA: join(base, 'desktop'),
      MOONBASE_CHAT_CONFIG: f.clientConfig,
      MOONBASE_CHAT_FORWARD_LOG: f.log,
    },
  });
  try {
    const page = await app.firstWindow();
    await page
      .getByRole('tablist', { name: 'Workbench views', exact: true })
      .getByRole('tab', { name: 'Agents', exact: true })
      .click();
    await selectRemoteChat(page);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect
      .poll(async () => ((await getConnection(page)).value as { state?: string })?.state)
      .toBe('connected');
    // No picker reaches the host's disk: the menu offers its approved root and the folders in it.
    await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Working folder', exact: true });
    await expect(menu.getByRole('button', { name: /^remote-folder/ })).toBeVisible();
    await expect(menu.getByRole('button', { name: 'Choose folder…', exact: true })).toHaveCount(0);
    await menu.getByRole('button', { name: /^site/ }).click();
    await expect(
      page.getByRole('button', { name: 'Choose working folder', exact: true }),
    ).toHaveText(/site/);
    // The host's default model is chosen, as for a local chat, so Send is enabled.
    await page.getByLabel('Message', { exact: true }).fill('Work in the host folder');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(async () => (await f.stats()).mutations.find((m) => m.operation === 'createChat'))
      .toMatchObject({
        input: {
          settings: { cwd: site, model: f.model },
        },
      });
    await expect.poll(async () => (await f.stats()).tools).toBe(1);
  } finally {
    try {
      await disconnectHost(app.windows()[0]!);
      const child = app.process();
      await app.evaluate(({ app }) => app.exit(0));
      await waitForExit(child);
    } finally {
      await stopDaemon(join(base, 'desktop', 'daemon-v1'));
      await f.close();
    }
  }
});
