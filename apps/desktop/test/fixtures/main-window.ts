import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { createTrustedDocumentCheck } from '../../src/main/ipc/ipc-connect.ts';

export function createTestWindow() {
  const url = 'moonbase://editor/index.html';
  let destroyed = false;
  const calls: string[] = [];
  /** Ports main posted to the main frame. */
  const posted: { channel: string; transfer: unknown[] }[] = [];
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {
      url,
      postMessage(channel: string, _message: unknown, transfer: unknown[]) {
        posted.push({ channel, transfer });
      },
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
  /** A frame or sender other than the window's own document. */
  const badEvents = () =>
    [
      { ...event, sender: {} },
      { ...event, senderFrame: { ...contents.mainFrame } },
      { ...event, senderFrame: null },
    ] as unknown as (typeof event)[];
  return {
    window,
    contents,
    posted,
    calls,
    event,
    badEvents,
    isTrusted: createTrustedDocumentCheck(window, url),
  };
}
