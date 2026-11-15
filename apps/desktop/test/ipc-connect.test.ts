import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ipcChannels } from '../src/ipc/desktop-bridge.ts';
import type { MessagePortLike } from '../src/ipc/port-socket.ts';
import { installIpcConnect } from '../src/main/ipc/ipc-connect.ts';
import { createTestWindow } from './fixtures/main-window.ts';

function fixture(accept = () => true) {
  const window = createTestWindow();
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const closed: string[] = [];
  const served: MessagePortLike[] = [];
  const port = (name: string) => ({
    name,
    close: () => void closed.push(name),
    on() {},
    once() {},
    off() {},
    start() {},
    postMessage() {},
  });
  const uninstall = installIpcConnect({
    ipcMain: {
      handle: (channel, handler) => void handlers.set(channel, handler as never),
      removeHandler: (channel) => void handlers.delete(channel),
    } as Pick<IpcMain, 'handle' | 'removeHandler'>,
    isTrusted: window.isTrusted,
    connect: (served_) => {
      if (!accept()) return false;
      served.push(served_);
      return true;
    },
    openChannel: () => ({ port1: port('main'), port2: port('renderer') }) as never,
  });
  const connect = (event = window.event, ...args: unknown[]) =>
    handlers.get(ipcChannels.connect)!(event, ...args);
  return { window, handlers, closed, served, connect, uninstall };
}

test('only the window’s own document gets a port, and only by asking with nothing else', () => {
  const f = fixture();
  for (const event of f.window.badEvents()) assert.throws(() => f.connect(event));
  f.window.contents.mainFrame.url += '?asset=1';
  assert.throws(() => f.connect());
  f.window.contents.mainFrame.url = 'moonbase://editor/index.html';
  assert.throws(() => f.connect(f.window.event, { root: '/' }));
  f.window.window.destroy();
  assert.throws(() => f.connect());
  assert.deepEqual(f.window.posted, []);
  assert.deepEqual(f.served, []);
});

test('the trusted document gets one port whose other end main serves; a refused one is closed', () => {
  let accept = true;
  const f = fixture(() => accept);
  f.connect();
  assert.equal(f.served.length, 1);
  assert.deepEqual(
    f.window.posted.map(({ channel, transfer }) => [
      channel,
      transfer.map((p) => (p as { name: string }).name),
    ]),
    [[ipcChannels.port, ['renderer']]],
  );
  accept = false;
  assert.throws(() => f.connect());
  assert.deepEqual(f.closed, ['main', 'renderer']);
  assert.equal(f.window.posted.length, 1);
  f.uninstall();
  assert.equal(f.handlers.size, 0);
});
