import { Context, Effect, Layer } from 'effect';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import type { RpcClientError } from 'effect/rpc/RpcClientError';
import * as Socket from 'effect/socket/Socket';
import { ipcPortMessage, type DesktopBridge } from '../../ipc/desktop-bridge.ts';
import { DesktopRpcs } from '../../ipc/desktop-rpcs.ts';
import { makePortSocket, type MessagePortLike } from '../../ipc/port-socket.ts';

/** Main's procedures, as Effects and Streams over this document's IPC port. */
export class DesktopIpc extends Context.Service<
  DesktopIpc,
  RpcClient.FromGroup<typeof DesktopRpcs, RpcClientError>
>()('moonbase/DesktopIpc') {}

/** A browser port as the IPC socket reads it. */
export const toMessagePortLike = (port: MessagePort): MessagePortLike => ({
  send: (message) => port.postMessage(message),
  close: () => port.close(),
  listen(onMessage, onClose) {
    const message = (event: MessageEvent) => onMessage(event.data);
    port.addEventListener('message', message);
    port.addEventListener('close' as 'message', onClose);
    port.start();
    return () => {
      port.removeEventListener('message', message);
      port.removeEventListener('close' as 'message', onClose);
    };
  },
});

/** Asks main for a port through the preload; it arrives as a window message naming our nonce. */
const connect = (bridge: DesktopBridge) =>
  Effect.callback<MessagePortLike, unknown>((resume) => {
    const nonce = crypto.randomUUID();
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; nonce?: unknown } | null;
      if (event.source !== window || data?.type !== ipcPortMessage || data.nonce !== nonce) return;
      window.removeEventListener('message', receive);
      const [port] = event.ports;
      resume(port ? Effect.succeed(toMessagePortLike(port)) : Effect.fail(Error('No IPC port.')));
    };
    window.addEventListener('message', receive);
    bridge.connect(nonce).catch((error: unknown) => {
      window.removeEventListener('message', receive);
      resume(Effect.fail(error));
    });
    return Effect.sync(() => window.removeEventListener('message', receive));
  });

/**
 * `DesktopIpc` over the ports `acquire` opens. A closed port fails the requests on it, and the
 * next request connects again. Main and the renderer share a machine, so liveness pings are rare
 * and patient: a busy main is not a lost one.
 */
export const makeDesktopIpcLayer = <E>(acquire: Effect.Effect<MessagePortLike, E>) =>
  Layer.effect(DesktopIpc, RpcClient.make(DesktopRpcs, { disableTracing: true })).pipe(
    Layer.provide(
      RpcClient.layerProtocolSocket({ pingInterval: '30 seconds', pingTimeout: '5 minutes' }),
    ),
    Layer.provide(Layer.effect(Socket.Socket, makePortSocket(acquire))),
    Layer.provide(RpcSerialization.layerJson),
  );
/** `DesktopIpc` over the ports the preload's `bridge` obtains from main. */
export const DesktopIpcLive = (bridge: DesktopBridge) => makeDesktopIpcLayer(connect(bridge));
