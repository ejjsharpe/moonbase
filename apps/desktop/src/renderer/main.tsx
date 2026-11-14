import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { createMoonbaseApplication, type MoonbaseApplication } from '@moonbase/application';
import { DesktopShell, type DesktopShellHandle } from './shell/desktop-shell.tsx';
import { WorkbenchStartupFailure } from './shell/startup-failure.tsx';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';
import { ManagedRuntime } from 'effect';
import { normalizeApplicationError } from '@moonbase/effect';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { DesktopBridge } from '../ipc/desktop-bridge.ts';
import { editorClientId } from '../ipc/editor-rpcs.ts';
import { boundApplicationError } from '../ipc/ipc-errors.ts';
import { DesktopIpcLive } from './ipc/desktop-ipc.ts';
import {
  makeChatTargetClients,
  makeEditorClient,
  makeShellClients,
} from './ipc/application-clients.ts';
import * as stylex from '@stylexjs/stylex';
import { workbench } from '@moonbase/ui/workbench';
import '@moonbase/ui/reset.css';
import '@moonbase/ui/fonts.css';

declare global {
  interface Window {
    moonbase: DesktopBridge;
  }
}
document.body.className = stylex.props(workbench.document).className ?? '';
const root = createRoot(document.getElementById('root')!);
// The renderer's one runtime: every request to main runs here, over this document's IPC port.
const runtime = ManagedRuntime.make(DesktopIpcLive(window.moonbase));
const shell = makeShellClients(runtime, window.moonbase);
const targetClients = new Map<string, ReturnType<typeof makeChatTargetClients>>();
/** Captured per target once, so a selected target change cannot reroute a pending action. */
function getTargetClients(target: 'local' | 'remote') {
  let clients = targetClients.get(target);
  if (!clients) targetClients.set(target, (clients = makeChatTargetClients(runtime, target)));
  return clients;
}
/** Runs main's window actions through `on` for as long as the document lives. */
function useWindowActions(
  on: (action: 'quit' | 'dispose' | 'cleanup-error', id: string, error?: ApplicationError) => void,
  dependency: unknown,
) {
  useEffect(() => {
    const close = shell.watchWindowActions(
      (action) =>
        action.action === 'cleanup-error'
          ? on(action.action, '', action.error)
          : on(action.action, action.id),
      // The watch ends only as the document goes (its port closes on Quit and reload).
      () => {},
    );
    return () => void close().catch(() => {});
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- one watch per dependency
  }, [dependency]);
}
/**
 * Answers main's Quit request, as a message: main may close the window before replying, and a
 * lost answer leaves main asking again on the next Quit.
 */
const answerQuit = (id: string, consent: boolean, cleanupError?: ApplicationError) =>
  void shell
    .answerQuit(id, consent, cleanupError && boundApplicationError(cleanupError))
    .catch(() => {});
function Desktop({ application }: { application: MoonbaseApplication }) {
  const handle = useRef<DesktopShellHandle>(null),
    [closing, setClosing] = useState(false),
    [releasing, setReleasing] = useState(false);
  async function prepareQuit(id: string) {
    try {
      const consent = await handle.current!.prepareQuit();
      if (consent) flushSync(() => setClosing(true));
      answerQuit(id, consent);
    } catch (error) {
      application.editors[0]!.report(error);
      answerQuit(id, false);
    }
  }
  useWindowActions((action, id, error) => {
    if (action === 'cleanup-error' && error) application.reportCleanup(error);
    if (action === 'quit') void prepareQuit(id);
    if (action === 'dispose') {
      flushSync(() => {
        setClosing(true);
        setReleasing(true);
      });
      const acknowledge = (error?: ApplicationError) => {
        root.unmount();
        answerQuit(id, true, error);
      };
      void application.dispose().then(
        () => acknowledge(),
        (error) => acknowledge(normalizeApplicationError(error)),
      );
    }
  }, application);
  if (releasing)
    return (
      <main>
        <span role="status">Closing workbench…</span>
      </main>
    );
  return (
    <DesktopShell
      ref={handle}
      application={application}
      closing={closing}
      transcriptNative={(target) => getTargetClients(target as 'local' | 'remote').transcript}
      chooseChatFolder={shell.chooseChatFolder}
      recentChatFolders={(target) => shell.listChatFolders(target as 'local' | 'remote')}
      createChatWorktree={shell.createChatWorktree}
      turnChatIntoProject={shell.turnChatIntoProject}
      selectCheckout={async () =>
        application.getSnapshot().phase === 'live' ? shell.chooseCheckout() : null
      }
      selectClipboardImports={async (checkout) =>
        application.getSnapshot().phase === 'live' ? shell.pasteImports(checkout) : []
      }
      copyPaths={shell.copyPaths}
      revealPath={shell.revealPath}
      selectDroppedImports={async (checkout, files) =>
        application.getSnapshot().phase === 'live'
          ? ((await shell.dropImports(checkout, files)) ?? [])
          : []
      }
    />
  );
}
function StartupFailure({ error }: { error: ApplicationError }) {
  useWindowActions((action, id) => {
    if (action === 'quit') answerQuit(id, true);
    if (action === 'dispose') {
      root.unmount();
      answerQuit(id, true, error);
    }
  }, error);
  return <WorkbenchStartupFailure message={error.message} />;
}

const chatStorageKeys = { local: 'moonbase.chat.local.v1', remote: 'moonbase.chat.remote.v2' };
try {
  configureMonacoWorkers();
  const targets = await shell.chatTargets();
  const application = await createMoonbaseApplication({
    editors: [{ client: makeEditorClient(runtime), clientId: editorClientId }],
    defaultChatTargetId: 'local',
    chatTargets: targets.map((target) => ({
      id: target.id,
      label: target.label,
      acquire: async () => {
        const clients = getTargetClients(target.id);
        // Every target is a daemon whose chats choose their folder and model; a remote host is
        // reached through a connection the user connects.
        return {
          chat: clients.chat,
          providers: clients.providers,
          ...(target.mode === 'remote' ? { connection: clients.connection } : {}),
          context: await clients.context(),
          // Drafts saved for a fixed-settings remote host (`moonbase.chat.v1`) are left alone:
          // their pending chats name no folder or model, so a daemon host can't take them.
          storage: {
            read: () => localStorage.getItem(chatStorageKeys[target.mode]),
            write: (value: string) => localStorage.setItem(chatStorageKeys[target.mode], value),
          },
        };
      },
    })),
  });
  window.addEventListener('beforeunload', (event) => {
    if (!application.canUnload()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('unload', () => {
    void application
      .dispose()
      .catch((error) => console.error(normalizeApplicationError(error).message));
  });
  root.render(<Desktop application={application} />);
} catch (error) {
  root.render(<StartupFailure error={boundApplicationError(normalizeApplicationError(error))} />);
}
