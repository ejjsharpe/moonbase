import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { createTrustedDocumentGuard } from '../../src/main/ipc/ipc.ts';

export function createTestWindow() {
  const url = 'moonbase://editor/index.html';
  let destroyed = false;
  const actions: { channel: string; action: string; id: string; error: unknown }[] = [];
  const calls: string[] = [];
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url },
    send(channel: string, action: string, id: string, error: unknown) {
      actions.push({ channel, action, id, error });
    },
    reload() {
      calls.push('reload');
    },
  });
  const nativeWindow = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => destroyed,
    show() {
      calls.push('show');
    },
    focus() {
      calls.push('focus');
    },
    hide() {
      calls.push('hide');
    },
    destroy() {
      destroyed = true;
      calls.push('destroy');
    },
  });
  const window = nativeWindow as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent &
    IpcMainInvokeEvent;
  const badEvents = () =>
    [
      { ...event, sender: {} },
      { ...event, senderFrame: { url } },
      { ...event, senderFrame: null },
    ] as unknown as (typeof event)[];
  return {
    window,
    contents,
    actions,
    calls,
    event,
    badEvents,
    requireTrusted: createTrustedDocumentGuard(window, url),
  };
}
