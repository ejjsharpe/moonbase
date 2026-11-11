import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { controlledHostFixture } from '../../../tests/chat/fixture.ts';
import {
  closeSettings,
  createRemoteChat,
  disconnectChat,
  openSettings,
  selectRemoteChat,
  showChat,
} from './chat-target.ts';
import { captureNative } from './editor-regressions.ts';
import {
  findTestBun,
  type FauxScript,
  prepareDaemonData,
  readDaemonPid,
  readFauxCalls,
  stopDaemon,
  writeFauxScript,
} from './faux-daemon.mjs';
import { openCallCard, openWorkingFold } from './transcript-list.ts';
import { retainedImage } from './stored-image-fixture.ts';

const main = pathToFileURL(resolve('dist/main.mjs')).href;
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Opens the composer's folder menu and chooses a folder with the native picker. */
async function chooseFolderNatively(page: Page) {
  await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
  await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
}
/** The native picker answers with `path` from now on. */
const pickWith = (app: ElectronApplication, path: string) =>
  app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, path);
/** Signs in to the faux OpenAI API key provider the test daemon offers. */
async function addProviderKey(page: Page, key: string) {
  const providers = await openSettings(page, 'Providers');
  await providers.getByRole('button', { name: 'Add key for openai-api-key', exact: true }).click();
  await providers.getByLabel('Enter API key', { exact: true }).fill(key);
  await providers.getByRole('button', { name: 'Continue setup', exact: true }).click();
  await expect(
    providers.getByRole('button', { name: 'Remove key for openai-api-key', exact: true }),
  ).toBeVisible();
  await closeSettings(page);
  // The faux provider has no default model; its one model is chosen once and kept.
  await page.getByRole('button', { name: 'Chat model', exact: true }).click();
  const models = page.getByRole('dialog', { name: 'Choose model', exact: true });
  await models.getByRole('button', { name: /Faux openai-api-key/ }).click();
  await expect(page.getByRole('button', { name: 'Chat model', exact: true })).toContainText(
    'Faux openai-api-key',
  );
}

/**
 * A temporary profile whose daemon is the faux test daemon, scripted by `script`. Its daemon
 * outlives each app launch, so `release` stops it.
 */
async function localProfile(prefix: string, script: FauxScript) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const userData = join(root, 'data'),
    daemon = join(userData, 'daemon-v1');
  await prepareDaemonData(userData, { idleMs: 120_000, pollMs: 500, ...script });
  const launch = async (env: Record<string, string> = {}) => {
    const app = await electron.launch({
      args: [resolve('test/local-harness.mjs')],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR!,
        MOONBASE_USER_DATA: userData,
        MOONBASE_TEST_MAIN: main,
        MOONBASE_TEST_BUN: findTestBun(),
        ...env,
      },
    });
    return { app, child: app.process(), page: await app.firstWindow() };
  };
  const exit = async ({ app, child }: Awaited<ReturnType<typeof launch>>) => {
    if (child.exitCode === null && child.signalCode === null)
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
  };
  const release = async () => {
    await stopDaemon(daemon);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  };
  return { root, userData, daemon, launch, exit, release };
}

test('local chat runs in the daemon: setup, picker folders, tools, @ search; Quit leaves the agent running and reopening reuses the daemon', async () => {
  test.setTimeout(90_000);
  const profile = await localProfile('moonbase-local-ui-', {});
  const first = join(profile.root, 'first'),
    second = join(profile.root, 'second'),
    release = join(profile.root, 'release'),
    dialogs = join(profile.root, 'dialogs.json');
  await mkdir(first);
  await mkdir(second);
  await writeFile(join(second, 'search-target.md'), '# Found by @ search\n');
  await writeFauxScript(profile.daemon, {
    idleMs: 120_000,
    pollMs: 500,
    steps: [
      { tool: 'write', args: { path: 'local-result.txt', content: 'first conversation' } },
      { reply: 'First local response' },
      { tool: 'write', args: { path: 'local-result.txt', content: 'second conversation' } },
      { reply: 'Second local response' },
      // A long-running tool: it finishes only after the app has quit.
      {
        tool: 'bash',
        args: {
          command: `while [ ! -e '${release}' ]; do sleep 0.05; done; echo finished > long-result.txt`,
        },
      },
      { reply: 'Long task finished after Quit' },
    ],
  });
  let launched = await profile.launch();
  let { app, child, page } = launched;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
    // The app started the profile's daemon; the renderer knows only its public identity.
    const pid = (await readDaemonPid(profile.daemon))!;
    expect(isAlive(pid)).toBe(true);
    const context = await page.evaluate(() => window.moonbaseChat.context('local'));
    const identity = JSON.parse(await readFile(join(profile.daemon, 'identity.json'), 'utf8'));
    expect(context).toEqual(identity);
    // A renderer-chosen folder gains no authority.
    const unauthorized = await page.evaluate(
      async (context) =>
        window.moonbaseChat.call(
          'chat',
          'createChat',
          {
            session: context,
            requestId: 'forged',
            title: 'No approval',
            settings: {
              cwd: '/private/tmp',
              model: { provider: 'openai-api-key', modelId: 'openai-api-key-faux' },
            },
          },
          crypto.randomUUID(),
          'local',
        ),
      context,
    );
    expect(unauthorized).toMatchObject({ ok: false, error: { code: 'Unauthorized' } });
    await addProviderKey(page, 'sk-controlled-private-key');
    for (const [index, folder] of [first, second].entries()) {
      await pickWith(app, folder);
      if (index) {
        // Main offers the folder the picker approved for the first chat again, by name only.
        await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
        const folders = page.getByRole('dialog', { name: 'Working folder', exact: true });
        await expect(
          folders.getByRole('group', { name: 'Recent folders' }).getByRole('button'),
        ).toHaveText([/^first/]);
        await page.keyboard.press('Escape');
      }
      await chooseFolderNatively(page);
      await expect(
        page.getByRole('button', { name: 'Choose working folder', exact: true }),
      ).toHaveAttribute('title', folder);
      if (index) {
        // `@` searches the chat's folder through the daemon.
        const message = page.getByLabel('Message', { exact: true });
        await message.fill('@search-tar');
        const files = page.getByRole('listbox', { name: 'Files', exact: true });
        await expect(files.getByRole('option').first()).toHaveAccessibleName(/search-target\.md/);
        await message.press('Escape');
      }
      await page.getByLabel('Message', { exact: true }).fill('Local conversation ' + index);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        page.getByText(index ? 'Second local response' : 'First local response', { exact: true }),
      ).toBeVisible();
      expect(await readFile(join(folder, 'local-result.txt'), 'utf8')).toBe(
        index ? 'second conversation' : 'first conversation',
      );
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
    }
    await captureNative(app, page, test.info().outputPath('local-chat.png'));
    const message = page.getByLabel('Message', { exact: true });
    await message.fill('Keep working after Quit');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await expect.poll(() => readFauxCalls(profile.daemon)).toBe(5);
    // Quit asks nothing about local agents and leaves them running.
    await app.evaluate(({ dialog, app }, dialogs) => {
      dialog.showMessageBox = (async (_window, options) => {
        process.getBuiltinModule('fs').appendFileSync(dialogs, JSON.stringify(options) + '\n');
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
      app.quit();
    }, dialogs);
    await expect.poll(() => child.exitCode).toBe(0);
    await expect(access(dialogs)).rejects.toThrow();
    expect(isAlive(pid)).toBe(true);
    await writeFile(release, '');
    await expect
      .poll(() => readFile(join(second, 'long-result.txt'), 'utf8').catch(() => ''))
      .toBe('finished\n');
    await expect.poll(() => readFauxCalls(profile.daemon)).toBe(6);
    // Reopening finds the same daemon and shows the agent's result.
    launched = await profile.launch();
    ({ app, child, page } = launched);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await (await showChat(page, /Keep working after Quit/)).click();
    await expect(page.getByText('Long task finished after Quit', { exact: true })).toBeVisible();
    expect(await readDaemonPid(profile.daemon)).toBe(pid);
    expect(await page.evaluate(() => window.moonbaseChat.context('local'))).toEqual(context);
    await showChat(page, /Local conversation 0/);
    await showChat(page, /Local conversation 1/);
    const saved = await page.evaluate(() => localStorage.getItem('moonbase.chat.local.v1'));
    expect(saved).not.toContain('controlled-private-key');
    // Picker approvals live in the daemon: the last-used folder leads, and choosing one needs no
    // native picker.
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
    const folders = page.getByRole('dialog', { name: 'Working folder', exact: true });
    await expect(
      folders.getByRole('group', { name: 'Recent folders' }).getByRole('button'),
    ).toHaveText([/^second/, /^first/]);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => {
        throw new Error('The native picker should not open.');
      }) as typeof dialog.showOpenDialog;
    });
    await folders.getByRole('button', { name: /^first/ }).click();
    await expect(
      page.getByRole('button', { name: 'Choose working folder', exact: true }),
    ).toHaveAttribute('title', first);
    // Signing out removes the daemon's credential.
    const providers = await openSettings(page, 'Providers');
    await providers
      .getByRole('button', { name: 'Remove key for openai-api-key', exact: true })
      .click();
    await expect(
      providers.getByRole('button', { name: 'Add key for openai-api-key', exact: true }),
    ).toBeVisible();
    await closeSettings(page);
    expect(errors).toEqual([]);
  } finally {
    try {
      await profile.exit(launched);
    } finally {
      await profile.release();
    }
  }
});

test('a crashed daemon restarts on the next request, and the chat shows it reconnecting', async () => {
  const profile = await localProfile('moonbase-local-crash-', {
    steps: [{ reply: 'Before the crash' }],
  });
  const folder = join(profile.root, 'folder');
  await mkdir(folder);
  const launched = await profile.launch();
  const { app, page } = launched;
  try {
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await addProviderKey(page, 'sk-controlled-crash');
    await pickWith(app, folder);
    await chooseFolderNatively(page);
    await page.getByLabel('Message', { exact: true }).fill('Start before the crash');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('Before the crash', { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const seen: string[] = [];
      Object.assign(window, { reconnecting: seen });
      new MutationObserver(() => {
        if (document.body.textContent?.includes('Reconnecting to live updates…'))
          seen.push('reconnecting');
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const pid = (await readDaemonPid(profile.daemon))!;
    // A restarted daemon replays its script from the start.
    await writeFauxScript(profile.daemon, {
      idleMs: 120_000,
      pollMs: 500,
      steps: [{ reply: 'After the restart' }],
    });
    process.kill(pid, 'SIGKILL');
    // The open chat's watch fails, reconnects and so restarts the daemon on the same store.
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { reconnecting: string[] }).reconnecting),
      )
      .not.toEqual([]);
    await expect.poll(async () => (await readDaemonPid(profile.daemon)) ?? pid).not.toBe(pid);
    await expect(page.getByText('Reconnecting to live updates…')).toHaveCount(0);
    // The failed watch it replaced is released without a cleanup failure.
    await expect(page.getByText('Panel cleanup failed')).toHaveCount(0);
    await page.getByLabel('Message', { exact: true }).fill('Continue after the restart');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('After the restart', { exact: true })).toBeVisible();
    expect(isAlive(pid)).toBe(false);
  } finally {
    try {
      await profile.exit(launched);
    } finally {
      await profile.release();
    }
  }
});

test('the editor works while the daemon starts; a failed first start shows a retryable Unavailable state that recovers', async () => {
  test.setTimeout(60_000);
  const profile = await localProfile('moonbase-local-startup-', {
    steps: [{ reply: 'Started after the retry' }],
  });
  const gate = join(profile.root, 'gate'),
    checkout = join(profile.root, 'checkout');
  await mkdir(gate);
  await mkdir(checkout);
  await writeFile(join(checkout, 'notes.md'), 'draft\n');
  // Every daemon start waits on the gate, so the first stays starting until the test fails it.
  const launched = await profile.launch({ MOONBASE_TEST_DAEMON_GATE: gate });
  const { app, page } = launched;
  try {
    // The window and editor work while the daemon is still starting.
    await pickWith(app, checkout);
    await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
    const opener = page.getByRole('dialog', { name: 'Open project', exact: true });
    const treeItem = page.getByRole('treeitem', { name: /^notes\.md/ });
    await expect(opener.or(treeItem)).toBeVisible();
    if (await opener.isVisible())
      await opener.getByRole('button', { name: 'Open folder…' }).click();
    await treeItem.dblclick();
    const editor = page.getByRole('textbox', { name: 'notes.md editor', exact: true });
    await editor.focus();
    await editor.press('Meta+a');
    await editor.pressSequentially('edited while the daemon starts');
    await editor.press('Meta+s');
    await expect
      .poll(() => readFile(join(checkout, 'notes.md'), 'utf8'))
      .toBe('edited while the daemon starts');
    expect(await readDaemonPid(profile.daemon)).toBeUndefined();
    // The first start fails: local chat is Unavailable, and says it can be retried.
    await writeFile(join(gate, 'fail'), '');
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    const unavailable = page.getByLabel('Chat configuration');
    await expect(unavailable).toContainText(
      'Moonbase could not start or reach its local chat daemon. Retry; editing remains available.',
    );
    // Once the daemon can start, a retry reaches it.
    await rm(join(gate, 'fail'));
    await writeFile(join(gate, 'start'), '');
    await page.getByRole('tab', { name: /^checkout/ }).click();
    await page.getByRole('button', { name: 'Open Chat panel', exact: true }).click();
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await expect(unavailable).toHaveCount(0);
    await addProviderKey(page, 'sk-controlled-startup');
    await page.getByLabel('Message', { exact: true }).fill('Start now');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('Started after the retry', { exact: true })).toBeVisible();
    expect(isAlive((await readDaemonPid(profile.daemon))!)).toBe(true);
  } finally {
    try {
      await profile.exit(launched);
    } finally {
      await profile.release();
    }
  }
});

test('folder grants: a chat without a project becomes one, an editor checkout and a new worktree are granted to the daemon', async () => {
  test.setTimeout(90_000);
  const profile = await localProfile('moonbase-local-grants-', {
    steps: [
      { reply: 'Own folder reply' },
      { reply: 'Editor checkout reply' },
      { reply: 'Worktree reply' },
    ],
  });
  const repository = join(profile.root, 'editor-repo');
  await mkdir(repository);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', [
      '-C',
      repository,
      '-c',
      'user.name=Grant Test',
      '-c',
      'user.email=grant@example.invalid',
      ...args,
    ]);
  git('init', '-q', '-b', 'main');
  await writeFile(join(repository, 'README.md'), '# Editor checkout\n');
  git('add', '.');
  git('commit', '-qm', 'Grant fixture');
  // A worktree Git lists for the checkout, which no chat uses.
  const unused = join(profile.root, 'editor-repo-unused');
  git('worktree', 'add', '-q', '-b', 'unused', unused);
  const approvals = () =>
    readFile(join(profile.daemon, 'approved-folders.json'), 'utf8').catch(() => '');
  const launched = await profile.launch({
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  const { app, page } = launched;
  try {
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await addProviderKey(page, 'sk-controlled-grants');
    // A chat without a project runs in a folder the daemon makes, then becomes a project there.
    await expect(
      page.getByRole('button', { name: 'Choose working folder', exact: true }),
    ).toHaveText(/^No project/);
    await page.getByLabel('Message', { exact: true }).fill('Plan a trip');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('Own folder reply', { exact: true })).toBeVisible();
    const own = await page.evaluate(async () => {
      const session = await window.moonbaseChat.context('local');
      const reply = await window.moonbaseChat.call(
        'chat',
        'listChats',
        { session },
        crypto.randomUUID(),
        'local',
      );
      return (reply as { value: { conversations: { cwd: string }[] } }).value.conversations[0].cwd;
    });
    expect(own.startsWith(join(profile.daemon, 'chats') + '/')).toBe(true);
    await page.getByRole('button', { name: 'Turn into project', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Turn into project', exact: true })).toBeHidden();
    // Only the chat's own folder can become a project; a forged one is refused by the daemon.
    const forged = await page.evaluate(() =>
      window.moonbaseChat.turnIntoProject!('missing-chat').then(
        () => 'opened',
        (error: Error) => error.message,
      ),
    );
    expect(forged).not.toBe('opened');
    // A checkout the editor opened is granted, so a chat may use it without the picker.
    await pickWith(app, repository);
    await page.getByRole('button', { name: 'Open checkout', exact: true }).click();
    const opener = page.getByRole('dialog', { name: 'Open project', exact: true });
    await expect(
      opener.or(page.getByRole('tab', { name: 'editor-repo · main', exact: true })),
    ).toBeVisible();
    if (await opener.isVisible())
      await opener.getByRole('button', { name: 'Open folder…' }).click();
    await expect(page.getByRole('tab', { name: 'editor-repo · main', exact: true })).toBeVisible();
    // Opening it grants the daemon nothing; a chat's first use of it does.
    expect(await approvals()).not.toContain(JSON.stringify(repository));
    await page.getByRole('tab', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = (async () => {
        throw new Error('The native picker should not open.');
      }) as typeof dialog.showOpenDialog;
    });
    await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Working folder', exact: true })
      .getByRole('button', { name: /^editor-repo/ })
      .click();
    await page.getByLabel('Message', { exact: true }).fill('Read the checkout');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('Editor checkout reply', { exact: true })).toBeVisible();
    // A new worktree of it is made by main, then granted to the daemon for its chat.
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('button', { name: 'Choose working folder', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Working folder', exact: true })
      .getByRole('button', { name: /^editor-repo/ })
      .click();
    await page.getByRole('combobox', { name: 'Worktree', exact: true }).click();
    await page.getByRole('option', { name: 'New worktree', exact: true }).click();
    await page.getByLabel('Message', { exact: true }).fill('Tidy the readme');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByText('Worktree reply', { exact: true })).toBeVisible();
    await access(join(`${repository}-worktrees`, 'chat-tidy-the-readme', 'README.md'));
    const granted = await approvals();
    expect(granted).toContain(JSON.stringify(repository));
    expect(granted).toContain(
      JSON.stringify(join(`${repository}-worktrees`, 'chat-tidy-the-readme')),
    );
    // The listed worktree no chat used was never granted.
    expect(granted).not.toContain(JSON.stringify(unused));
  } finally {
    try {
      await profile.exit(launched);
    } finally {
      await profile.release();
    }
  }
});

for (const mode of ['local', 'remote'] as const)
  test(`transcript ${mode} tool progress renders before held completion; Copy is injected and Stop stays independent`, async () => {
    test.setTimeout(60000);
    const host =
      mode === 'remote'
        ? await controlledHostFixture(
            new URL('../../../tests/chat/tool-host.mjs', import.meta.url),
            true,
          )
        : undefined;
    const directory =
      host?.directory ??
      (await realpath(await mkdtemp(join(tmpdir(), 'moonbase-activity-native-'))));
    const userData = join(directory, 'desktop'),
      daemon = join(userData, 'daemon-v1'),
      gate = join(directory, 'next-chunk');
    await prepareDaemonData(userData, {
      steps: [
        {
          tool: 'bash',
          args: {
            command: `printf 'First local tool chunk'; while [ ! -e '${gate}' ]; do sleep 0.05; done; printf ' and next update'; sleep 600`,
          },
        },
        { reply: 'Local tool response finished' },
      ],
    });
    const app = await electron.launch({
      args: [resolve('test/local-harness.mjs')],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR!,
        MOONBASE_USER_DATA: userData,
        MOONBASE_TEST_MAIN: main,
        MOONBASE_TEST_BUN: findTestBun(),
        ...(host
          ? { MOONBASE_CHAT_CONFIG: host.clientConfig, MOONBASE_CHAT_FORWARD_LOG: host.log }
          : {}),
      },
    });
    const child = app.process(),
      page = await app.firstWindow();
    try {
      if (host) {
        await selectRemoteChat(page);
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await createRemoteChat(page, 'Remote held activity');
      } else {
        await page.getByRole('tab', { name: 'Agents', exact: true }).click();
        await addProviderKey(page, 'sk-controlled-activity-fixture');
        await pickWith(app, directory);
        await chooseFolderNatively(page);
      }
      await page.getByLabel('Message', { exact: true }).fill('Observe held tool progress');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const live = page.getByRole('article', { name: 'Live response' });
      // The running call's output sits in the run's "Working…" fold; opened, it shows so far.
      const part = live.locator('[data-transcript-part]').filter({ hasText: /Output · running/ });
      await openWorkingFold(page, part);
      await expect(part).toHaveCount(1);
      // The live row holds only the call's output: it has no toggle of its own, and opens with
      // its call's card above it.
      await expect(live.getByRole('button', { name: /^Activity/ })).toHaveCount(0);
      await expect(live).toContainText('running');
      // A shell call is headed by its command.
      const group = await openCallCard(page, host ? 'inspect_remote_context' : 'printf');
      await expect(group).toHaveAttribute('aria-expanded', 'true');
      await expect(part.locator('pre')).toContainText(
        host ? 'Controlled remote tool activity' : 'First local tool chunk',
      );
      await part.locator('pre').focus();
      const reads = () =>
        host
          ? host.stats().then((stats) => stats.commands.filter((name) => name === 'getChat').length)
          : app.evaluate(
              () => (globalThis as unknown as { desktopChatReads?: number }).desktopChatReads ?? 0,
            );
      const before = await reads();
      if (host) host.nextChunk();
      else await writeFile(gate, '');
      const next = host
        ? 'Controlled remote tool activity\nFixed folder observed by the test tool.\n' +
          'preview '.repeat(800) +
          '\nControlled remote next tool chunk'
        : 'First local tool chunk and next update';
      await expect(part.locator('pre')).toHaveText(next);
      await expect(part.locator('pre')).toBeFocused();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
      // The update arrived through the watch, not by polling the chat.
      expect(await reads()).toBe(before);
      await part.getByRole('button', { name: 'Copy part', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toBeVisible();
      expect(
        await app.evaluate(() =>
          (globalThis as unknown as { moonbaseTestClipboard: string[] }).moonbaseTestClipboard.at(
            -1,
          ),
        ),
      ).toBe(next);
      await mkdir(resolve('../../test-results/transcript-112'), { recursive: true });
      await page.screenshot({
        path: resolve(`../../test-results/transcript-112/native-${mode}-held-tool.png`),
      });
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      // One locator: Stop may leave the DOM between separate visibility and disabled checks.
      await expect(
        page.getByRole('button', { name: 'Stop', exact: true, disabled: false }),
      ).toHaveCount(0);
      await expect(page.getByRole('status', { name: 'Conversation status' })).toContainText(
        'Stopped',
      );
    } finally {
      try {
        host?.release();
        if (child.exitCode === null) {
          if (host) {
            // Still connected when the sidebar has no Connect line.
            if (!(await page.getByRole('button', { name: 'Connect', exact: true }).count()))
              await disconnectChat(page);
          }
          await app.evaluate(({ app }) => app.exit(0));
        }
        await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
      } finally {
        // A daemon outlives its app: stop it even when the steps before fail.
        await stopDaemon(daemon);
      }
      if (host) await host.close();
      else await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

test('transcript remote first/next chunks render through authenticated stream and Electron IPC before held completion', async () => {
  test.setTimeout(60000);
  const host = await controlledHostFixture(
    new URL('../../../tests/chat/stream-host.mjs', import.meta.url),
    true,
  );
  const userData = join(host.directory, 'desktop');
  await prepareDaemonData(userData);
  const app = await electron.launch({
    args: [resolve('test/local-harness.mjs')],
    env: {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME!,
      TMPDIR: process.env.TMPDIR!,
      MOONBASE_USER_DATA: userData,
      MOONBASE_CHAT_CONFIG: host.clientConfig,
      MOONBASE_CHAT_FORWARD_LOG: host.log,
      MOONBASE_TEST_MAIN: main,
      MOONBASE_TEST_BUN: findTestBun(),
    },
  });
  const child = app.process(),
    page = await app.firstWindow();
  try {
    await selectRemoteChat(page);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await createRemoteChat(page, 'Remote held transcript');
    await page.getByLabel('Message', { exact: true }).fill('Observe actual remote chunks');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const live = page.getByRole('article', { name: 'Live response' });
    await expect(live.getByText('first remote text 0', { exact: true })).toBeVisible();
    await live.getByRole('button', { name: /^Activity/ }).click();
    const thought = live
      .locator('[data-transcript-part]')
      .filter({ hasText: /^Thinking/ })
      .locator('pre');
    await expect(thought).toHaveText('remote thinking 0');
    await thought.focus();
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    const before = await host.stats();
    host.nextChunk();
    await expect(live.getByText('first remote text 4', { exact: true })).toBeVisible();
    await expect(live.locator('pre').getByText('remote thinking 4', { exact: true })).toBeVisible();
    await expect(thought).toBeFocused();
    const after = await host.stats();
    expect(after.reads!.scans).toBe(before.reads!.scans);
    expect(after.commands.filter((operation) => operation === 'getChat').length).toBe(
      before.commands.filter((operation) => operation === 'getChat').length,
    );
    await page.screenshot({
      path: resolve('../../test-results/transcript-111/native-remote-held.png'),
    });
    host.release();
    await page.getByLabel('Message', { exact: true }).focus();
    await expect(page.getByText('REMOTE COMPLETED', { exact: true })).toBeVisible();
  } finally {
    try {
      host.release();
      if (child.exitCode === null) {
        // Still connected when the sidebar has no Connect line.
        if (!(await page.getByRole('button', { name: 'Connect', exact: true }).count()))
          await disconnectChat(page);
        await app.evaluate(({ app }) => app.exit(0));
      }
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      // A daemon outlives its app: stop it even when the steps before fail.
      await stopDaemon(join(userData, 'daemon-v1'));
    }
    await host.close();
  }
});

for (const mode of ['local', 'remote'] as const)
  test(`stored image ${mode} record is served over moonbase:// under production CSP; viewer keyboard, close and actual zoom`, async () => {
    const host =
      mode === 'remote'
        ? await controlledHostFixture(new URL('./stored-image-host.mjs', import.meta.url))
        : undefined;
    const directory =
      host?.directory ?? (await realpath(await mkdtemp(join(tmpdir(), 'moonbase-image-native-'))));
    const userData = join(directory, 'desktop');
    if (!host) await writeFile(join(directory, 'retained.png'), retainedImage);
    // The daemon's own read tool records the image.
    await prepareDaemonData(userData, {
      steps: [{ tool: 'read', args: { path: 'retained.png' } }, { reply: 'Image read' }],
    });
    const app = await electron.launch({
      args: [resolve('test/local-harness.mjs')],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR!,
        MOONBASE_USER_DATA: userData,
        MOONBASE_TEST_MAIN: main,
        MOONBASE_TEST_BUN: findTestBun(),
        ...(host
          ? { MOONBASE_CHAT_CONFIG: host.clientConfig, MOONBASE_CHAT_FORWARD_LOG: host.log }
          : {}),
      },
    });
    const child = app.process(),
      page = await app.firstWindow();
    try {
      expect(page.url()).toBe('moonbase://editor/index.html');
      await page.evaluate(() => {
        const control = { violations: [] as string[] };
        (window as unknown as { nativeImages: typeof control }).nativeImages = control;
        window.addEventListener('securitypolicyviolation', (event) =>
          control.violations.push(event.violatedDirective),
        );
      });
      if (host) {
        await selectRemoteChat(page);
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await createRemoteChat(page, 'Retained remote images');
      } else {
        await page.getByRole('tab', { name: 'Agents', exact: true }).click();
        await addProviderKey(page, 'sk-controlled-image-fixture');
        await pickWith(app, directory);
        await chooseFolderNatively(page);
      }
      await page.getByLabel('Message', { exact: true }).fill('Inspect retained images');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      if (!host) await expect(page.getByText('Image read', { exact: true })).toBeVisible();
      const group = page
        .locator('[data-transcript-activity]')
        .filter({ has: page.locator('[data-transcript-part]').filter({ hasText: 'Stored image' }) })
        .first();
      await expect(group).toBeAttached();
      // The image is the call's output, recorded in a later row with no chevron of its own; the
      // call's card opens it.
      await expect(group.getByRole('button', { name: /^Activity/ })).toHaveCount(0);
      await openCallCard(page, host ? 'retained_images' : 'read');
      const trigger = group.getByRole('button', { name: 'View stored image', exact: true }).first();
      await trigger.scrollIntoViewIfNeeded();
      await expect(trigger).toBeEnabled();
      const thumbnail = trigger.getByRole('img', { name: 'Stored image thumbnail' });
      const src = (await thumbnail.getAttribute('src'))!;
      expect(src).toMatch(/^moonbase:\/\/editor\/transcript-image\/[A-Za-z0-9_-]{43}$/);
      expect(await thumbnail.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(192);
      // The URL is only an opaque token; a guessed token and a non-image path grant nothing.
      expect(
        await page.evaluate(async (src) => {
          const statuses = [];
          for (const url of [src.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), src])
            statuses.push((await fetch(url, { cache: 'no-store' })).status);
          const response = await fetch(src);
          return [
            ...statuses,
            response.headers.get('Content-Type'),
            response.headers.get('X-Content-Type-Options'),
            response.headers.get('Cache-Control'),
          ];
        }, src),
      ).toEqual([404, 200, 'image/png', 'nosniff', 'no-store']);
      for (let iteration = 0; iteration < 3; iteration++) {
        await trigger.press('Enter');
        const dialog = page.getByRole('dialog', { name: 'Stored image', exact: true });
        await expect(dialog.getByRole('img', { name: 'Recorded image' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Close image viewer' })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect
          .poll(() => dialog.evaluate((node) => node.contains(document.activeElement)))
          .toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(1280, 850);
        window.webContents.setZoomFactor(2);
      });
      await trigger.scrollIntoViewIfNeeded();
      await expect(trigger).toBeEnabled();
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Stored image', exact: true });
      await expect(dialog.getByRole('img', { name: 'Recorded image' })).toBeVisible();
      await mkdir(resolve('../../test-results/transcript-images'), { recursive: true });
      await captureNative(
        app,
        page,
        resolve(`../../test-results/transcript-images/native-${mode}-zoom.png`),
      );
      const rect = await dialog.evaluate((node) => {
        const r = node.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: innerWidth,
          height: innerHeight,
        };
      });
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.top).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(rect.width);
      expect(rect.bottom).toBeLessThanOrEqual(rect.height);
      await page.keyboard.press('Escape');
      const stats = await page.evaluate(
        () => (window as unknown as { nativeImages: { violations: string[] } }).nativeImages,
      );
      expect(stats.violations).toEqual([]);
      expect(
        await app.evaluate(
          () =>
            (globalThis as unknown as { moonbaseTestClipboard: string[] }).moonbaseTestClipboard,
        ),
      ).toEqual([]);
    } finally {
      try {
        if (child.exitCode === null && host) {
          await app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0];
            window.setSize(1280, 850);
            window.webContents.setZoomFactor(1);
          });
          await disconnectChat(page);
        }
      } finally {
        try {
          if (child.exitCode === null) await app.evaluate(({ app }) => app.exit(0));
          await expect
            .poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 15000 })
            .toBe(true);
        } finally {
          await stopDaemon(join(userData, 'daemon-v1'));
          if (host) console.info('Image native remote cleanup', await host.close());
          else await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        }
      }
    }
  });
