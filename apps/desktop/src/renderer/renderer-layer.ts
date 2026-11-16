import { Effect, Layer } from 'effect';
import { MoonbaseApplication } from '@moonbase/application';
import type { ChatRunner } from '@moonbase/application/chat';
import { editorLayer } from '@moonbase/application/editor';
import type { DesktopBridge } from '../ipc/desktop-bridge.ts';
import { editorClientId } from '../ipc/editor-rpcs.ts';
import { DesktopIpcLive, type DesktopIpc } from './ipc/desktop-ipc.ts';
import { WorkspaceIpcLive } from './ipc/workspace-ipc.ts';
import { callEffect } from './ipc/ipc-failures.ts';
import type { makeChatTargetClients } from './ipc/application-clients.ts';

const chatStorageKeys = { local: 'moonbase.chat.local.v1', remote: 'moonbase.chat.remote.v2' };

/** The renderer's root runtime: main's procedures over this document's IPC port, and the workspace. */
export const makeIpcLayer = (bridge: DesktopBridge) =>
  Layer.provideMerge(WorkspaceIpcLive, DesktopIpcLive(bridge));

/**
 * The document's editor and application, with the chat targets main names, built on the root
 * runtime in a scope of their own: closing it releases them while the IPC port stays up to tell
 * main. `runtime` is that root runtime, which the chat's clients and controller run on until
 * CL-22.
 */
export function makeDocumentLayer(
  runtime: ChatRunner,
  getTargetClients: (target: 'local' | 'remote') => ReturnType<typeof makeChatTargetClients>,
) {
  const application = Layer.unwrap(
    Effect.gen(function* () {
      const targets = yield* callEffect('getChatTargets', undefined, 'Invalid desktop request.');
      const ipc = yield* Effect.context<DesktopIpc>();
      return MoonbaseApplication.layer({
        defaultChatTargetId: 'local',
        runner: runtime,
        chatTargets: targets.map((target) => ({
          id: target.id,
          label: target.label,
          acquire: Effect.gen(function* () {
            const clients = getTargetClients(target.id);
            // Every target is a daemon whose chats choose their folder and model; a remote host
            // is reached through a connection the user connects.
            return {
              chat: clients.chat,
              providers: clients.providers,
              ...(target.mode === 'remote' ? { connection: clients.connection } : {}),
              context: yield* callEffect(
                'getChatContext',
                { backendId: target.id },
                'Invalid chat request.',
              ),
              // Drafts saved for a fixed-settings remote host (`moonbase.chat.v1`) are left
              // alone: their pending chats name no folder or model, so a daemon host can't take
              // them.
              storage: {
                read: () => localStorage.getItem(chatStorageKeys[target.mode]),
                write: (value: string) => localStorage.setItem(chatStorageKeys[target.mode], value),
              },
            };
          }).pipe(Effect.provideContext(ipc)),
        })),
      });
    }),
  );
  return Layer.provideMerge(application, editorLayer({ clientId: editorClientId }));
}
