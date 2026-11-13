import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IpcMain } from 'electron';
import { installCommandIpc } from './ipc.ts';
import { channels } from '../../shared/ipc/wire.ts';
import { channels as chatChannels } from '../../shared/ipc/chat-wire.ts';
import { createTestWindow } from '../../../test/fixtures/main-window.ts';

test('command IPC authenticates every channel, validates envelopes and tears down only its registrations', async () => {
  const f = createTestWindow();
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const ipcMain = {
    handle: (channel, listener) => {
      assert(!handlers.has(channel));
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  } satisfies Pick<IpcMain, 'handle' | 'removeHandler'>;
  let calls = 0;
  const failure = {
    ok: false as const,
    error: { code: 'Persistence' as const, message: 'Held release failed' },
  };
  const cleanup: Promise<void>[] = [];
  const deps: Parameters<typeof installCommandIpc>[0] = {
    ipcMain,
    requireTrusted: f.requireTrusted,
    editorSession: {
      call: async () => {
        calls++;
        return { ok: true, value: null };
      },
      cancel: async () => {
        calls++;
        return failure;
      },
    },
    chatBackends: {
      getTargets: () => [
        {
          id: 'local',
          label: 'Local',
          mode: 'local',
        },
      ],
      getContext: async () => {
        calls++;
        return { host: { hostId: 'h', storeId: 's' }, actorId: 'a' };
      },
      chooseFolder: async () => {
        calls++;
        return '/chosen';
      },
      recentFolders: async () => {
        calls++;
        return ['/chosen'];
      },
      createWorktree: async (root, branch, requestId) => {
        assert.equal(requestId, 'worktree-request');
        calls++;
        return `${root}-worktrees/${branch.replaceAll('/', '-')}`;
      },
      turnIntoProject: async (conversationId) => {
        calls++;
        return `/chats/${conversationId}`;
      },
      getSession: () => undefined,
    },
    lifecycle: {
      reportCleanup: (p) => {
        cleanup.push(p);
        void p.catch(() => {});
      },
      isQuitting: () => false,
    },
  };
  handlers.set('unrelated', async () => 'untouched');
  const uninstall = installCommandIpc(deps);
  const invoke = (channel: string, event = f.event, ...args: unknown[]) =>
    handlers.get(channel)!(event, ...args);
  const inputs = [
    [channels.call, { method: 'choose', input: null, id: 'call' }],
    [channels.cancel, 'call'],
    [channels.configured, null],
    [chatChannels.call, { kind: 'targets' }],
    [
      chatChannels.call,
      { kind: 'transcript', operation: 'copy', input: {}, id: 'copy', backendId: 'local' },
    ],
    [
      chatChannels.call,
      {
        kind: 'transcript',
        operation: 'open-link',
        input: { url: 'https://example.com' },
        id: 'link',
        backendId: 'local',
      },
    ],
    [chatChannels.cancel, { backendId: 'local', id: 'call' }],
    [
      chatChannels.call,
      {
        kind: 'create-worktree',
        backendId: 'local',
        root: '/repo',
        branch: 'chat/task',
        requestId: 'worktree-request',
      },
    ],
    [chatChannels.call, { kind: 'turn-into-project', backendId: 'local', conversationId: '7' }],
  ] as const;
  for (const event of f.badEvents())
    for (const [channel, input] of inputs)
      assert.equal((await invoke(channel, event, input)).error.code, 'Unauthorized');
  for (const url of [
    'moonbase://editor/index.html?asset=1',
    'moonbase://editor/index.html#other',
    'https://example.com',
  ]) {
    f.contents.mainFrame.url = url;
    for (const [channel, input] of inputs)
      assert.equal((await invoke(channel, f.event, input)).error.code, 'Unauthorized');
  }
  f.contents.mainFrame.url = 'moonbase://editor/index.html';
  assert.equal(calls, 0);
  assert.equal((await invoke(channels.configured, f.event, null)).ok, true);
  for (const args of [[], [null, null], [{}]])
    assert.equal((await invoke(channels.configured, f.event, ...args)).error.code, 'InvalidInput');
  assert.equal(
    (await invoke(channels.call, f.event, { method: 'choose', input: null, id: 'id', extra: true }))
      .ok,
    false,
  );
  assert.equal(
    (await invoke(chatChannels.call, f.event, { kind: 'targets', extra: true })).ok,
    false,
  );
  assert.equal(
    (await invoke(chatChannels.call, f.event, { kind: 'context', backendId: 'foreign' })).error
      .code,
    'Unauthorized',
  );
  assert.equal(
    (await invoke(chatChannels.call, f.event, { kind: 'context', backendId: 'local' })).ok,
    true,
  );
  const worktree = {
    kind: 'create-worktree',
    backendId: 'local',
    root: '/repo',
    branch: 'chat/a',
    requestId: 'worktree-request',
  };
  assert.deepEqual(await invoke(chatChannels.call, f.event, worktree), {
    ok: true,
    value: '/repo-worktrees/chat-a',
  });
  for (const input of [
    { ...worktree, location: '/elsewhere' },
    { ...worktree, branch: 1 },
    { ...worktree, requestId: 'not a request id' },
    { ...worktree, backendId: 'remote' },
  ])
    assert.equal((await invoke(chatChannels.call, f.event, input)).ok, false);
  const turn = { kind: 'turn-into-project', backendId: 'local', conversationId: '7' };
  assert.deepEqual(await invoke(chatChannels.call, f.event, turn), { ok: true, value: '/chats/7' });
  for (const input of [
    { ...turn, root: '/elsewhere' },
    { ...turn, conversationId: 7 },
    { ...turn, conversationId: '' },
    { ...turn, backendId: 'remote' },
  ])
    assert.equal((await invoke(chatChannels.call, f.event, input)).ok, false);
  // Quit no longer asks main about local work: the old confirmation is an invalid request.
  assert.equal(
    (await invoke(chatChannels.call, f.event, { kind: 'confirm-quit', backendId: 'local' })).ok,
    false,
  );
  assert.deepEqual(await invoke(channels.cancel, f.event, 'id'), failure);
  await assert.rejects(cleanup[0], { message: failure.error.message });
  f.window.destroy();
  for (const [channel, input] of inputs)
    assert.equal((await invoke(channel, f.event, input)).error.code, 'Unauthorized');
  uninstall();
  assert.deepEqual([...handlers.keys()], ['unrelated']);
  const uninstallAgain = installCommandIpc(deps);
  uninstall();
  assert.equal(handlers.size, 6);
  uninstallAgain();
  assert.deepEqual([...handlers.keys()], ['unrelated']);
});
