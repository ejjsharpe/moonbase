import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
  MessageChannelMain,
  MessagePortMain,
} from 'electron';
import { Effect, FiberSet } from 'effect';
import { ipcChannels } from '../../ipc/desktop-bridge.ts';
import type { MessagePortLike } from '../../ipc/port-socket.ts';

/** Whether an IPC event comes from the window's main frame showing the app's own document. */
export function createTrustedDocumentCheck(window: BrowserWindow, appURL: string) {
  return (event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>) =>
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame?.url === appURL;
}

/** A main-process port as the IPC socket reads it. */
export function toMessagePortLike(port: MessagePortMain): MessagePortLike {
  return {
    send: (message) => port.postMessage(message),
    close: () => port.close(),
    listen(onMessage, onClose) {
      const message = (event: { data: unknown }) => onMessage(event.data);
      port.on('message', message);
      port.once('close', onClose);
      port.start();
      return () => {
        port.off('message', message);
        port.off('close', onClose);
      };
    },
  };
}

/**
 * Answers the one IPC request the preload makes, while the scope is open: a port for the trusted
 * document, whose other end `connect` serves. Anything else asking, or a refused connection, gets
 * no port.
 */
export const installIpcConnect = ({
  ipcMain,
  isTrusted,
  connect,
  openChannel,
}: {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>;
  isTrusted(event: IpcMainInvokeEvent): boolean;
  connect(port: MessagePortLike): Effect.Effect<boolean>;
  /** Electron's `new MessageChannelMain()`. */
  openChannel(): Pick<MessageChannelMain, 'port1' | 'port2'>;
}) =>
  Effect.gen(function* () {
    const run = yield* FiberSet.makeRuntimePromise();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        ipcMain.handle(ipcChannels.connect, async (event, ...args: unknown[]) => {
          if (args.length || !isTrusted(event)) throw Error('Untrusted renderer frame/document.');
          const { port1, port2 } = openChannel();
          // Closed (Quit), the server takes nothing more.
          if (!(await run(connect(toMessagePortLike(port1))).catch(() => false))) {
            port1.close();
            port2.close();
            throw Error('The window has no IPC connection available.');
          }
          event.senderFrame!.postMessage(ipcChannels.port, null, [port2]);
        }),
      ),
      () => Effect.sync(() => ipcMain.removeHandler(ipcChannels.connect)),
    );
  });
