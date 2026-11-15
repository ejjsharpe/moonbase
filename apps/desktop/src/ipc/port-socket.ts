import { Effect, type Scope } from 'effect';
import * as Socket from 'effect/socket/Socket';
import { ipcLimits } from './ipc-limits.ts';

/** What the IPC socket needs of a message port, whichever process holds it. */
export type MessagePortLike = {
  send(message: string): void;
  close(): void;
  /** Delivers each message and the port's close until the returned function stops it. */
  listen(onMessage: (data: unknown) => void, onClose: () => void): () => void;
};
type Listener = (event: Socket.WebSocketEvent) => void;
/** Close codes: a normal close, and a message refused for its size or type. */
const closeCodes = { normal: 1000, refused: 1009 };

/**
 * A port as the WebSocket an Effect `Socket` reads: open from the start, text messages only, each
 * at most `maxLength` UTF-16 units. Any other message closes the port before anything reads it.
 */
function toWebSocket(port: MessagePortLike, maxLength: number): Socket.WebSocketLike {
  const listeners = new Map<string, Set<Listener>>();
  let readyState = 1;
  const emit = (type: string, event: Socket.WebSocketEvent) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const close = (code: number) => {
    if (readyState === 3) return;
    readyState = 3;
    stop();
    port.close();
    emit('close', { type: 'close', code });
  };
  const stop = port.listen(
    (data) => {
      if (readyState !== 1) return;
      if (typeof data !== 'string' || data.length > maxLength) return close(closeCodes.refused);
      emit('message', { type: 'message', data });
    },
    () => close(closeCodes.normal),
  );
  return {
    get readyState() {
      return readyState;
    },
    addEventListener(type, listener, options) {
      const once: Listener = options?.once
        ? (event) => {
            listeners.get(type)?.delete(once);
            listener(event);
          }
        : listener;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(once);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    close: (code = closeCodes.normal) => close(code),
    send(data) {
      if (readyState !== 1) throw Error('The IPC port is closed.');
      port.send(typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
  };
}

/**
 * An Effect `Socket` over the ports `acquire` opens, one per connection; each is closed when its
 * connection ends. A client socket reconnects by acquiring another port.
 */
export const makePortSocket = <E, R>(
  acquire: Effect.Effect<MessagePortLike, E, R>,
  maxLength: number = ipcLimits.messageLength,
) =>
  Socket.fromWebSocket(
    Effect.acquireRelease(
      Effect.map(acquire, (port) => toWebSocket(port, maxLength)),
      (ws) => Effect.sync(() => ws.close()),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({ kind: 'Unknown', cause }),
          }),
      ),
    ) as Effect.Effect<
      Socket.WebSocketLike,
      Socket.SocketError,
      Exclude<R, Scope.Scope> | Scope.Scope
    >,
  );
