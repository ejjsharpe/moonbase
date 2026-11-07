import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { createMoonbaseApplication, type MoonbaseApplication } from '@moonbase/application';
import { DesktopShell, type DesktopShellHandle } from './shell/workbench.tsx';
import { WorkbenchStartupFailure } from './shell/startup-failure.tsx';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';
import { browserClients, browserTranscriptActions, type ChatBridge } from '../chat/wire.ts';
import {
  bridgeClient,
  unwrap,
  errorDTO,
  failure,
  type ErrorDTO,
  type DesktopBridge,
} from '../wire.ts';
import * as stylex from '@stylexjs/stylex';
import { workbench } from '@moonbase/ui/workbench';
import '@moonbase/ui/reset.css';
import '@moonbase/ui/fonts.css';

declare global {
  interface Window {
    moonbase: DesktopBridge;
    moonbaseChat: ChatBridge;
  }
}
document.body.className = stylex.props(workbench.document).className ?? '';
const bridge = window.moonbase,
  root = createRoot(document.getElementById('root')!);
const transcriptActions = new Map<string, ReturnType<typeof browserTranscriptActions>>();
function getTranscriptActions(backend: string) {
  if (!transcriptActions.has(backend))
    transcriptActions.set(backend, browserTranscriptActions(window.moonbaseChat, backend));
  return transcriptActions.get(backend)!;
}
function Desktop({ application }: { application: MoonbaseApplication }) {
  const handle = useRef<DesktopShellHandle>(null),
    [closing, setClosing] = useState(false),
    [releasing, setReleasing] = useState(false);
  useEffect(() => {
    async function prepareQuit(id: string) {
      try {
        const consent = await handle.current!.prepareQuit();
        if (consent) flushSync(() => setClosing(true));
        bridge.quitResult(id, consent);
      } catch (error) {
        application.editors[0]!.report(error);
        bridge.quitResult(id, false);
      }
    }
    const off = bridge.actions((action, id, error) => {
      if (action === 'cleanup-error') application.reportCleanup(failure(error));
      if (action === 'quit') void prepareQuit(id);
      if (action === 'dispose') {
        flushSync(() => {
          setClosing(true);
          setReleasing(true);
        });
        const acknowledge = (error?: ErrorDTO) => {
          root.unmount();
          bridge.quitResult(id, true, error);
        };
        void application.dispose().then(
          () => acknowledge(),
          (error) => acknowledge(errorDTO(error)),
        );
      }
    });
    bridge.ready();
    return off;
  }, [application]);
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
      transcriptNative={getTranscriptActions}
      chooseChatFolder={() => window.moonbaseChat.chooseFolder!()}
      recentChatFolders={() => window.moonbaseChat.recentFolders!()}
      createChatWorktree={(root, branch) => window.moonbaseChat.createWorktree!(root, branch)}
      selectCheckout={async () =>
        application.getSnapshot().phase === 'live'
          ? (unwrap(await bridge.call('choose-checkout', null, crypto.randomUUID())) as
              | string
              | null)
          : null
      }
      selectClipboardImports={async (checkout) =>
        application.getSnapshot().phase === 'live'
          ? (unwrap(
              await bridge.call('clipboard-imports', { checkout }, crypto.randomUUID()),
            ) as string[])
          : []
      }
      selectDroppedImports={async (checkout, files) =>
        application.getSnapshot().phase === 'live' ? unwrap(await bridge.drop(checkout, files)) : []
      }
    />
  );
}
function StartupFailure({ error }: { error: ErrorDTO }) {
  useEffect(() => {
    const off = bridge.actions((action, id) => {
      if (action === 'quit') bridge.quitResult(id, true);
      if (action === 'dispose') {
        root.unmount();
        bridge.quitResult(id, true, error);
      }
    });
    bridge.ready();
    return off;
  }, [error]);
  return <WorkbenchStartupFailure message={error.message} />;
}

try {
  configureMonacoWorkers();
  const targets = await window.moonbaseChat.targets!();
  const application = await createMoonbaseApplication({
    editors: [{ client: bridgeClient(bridge), clientId: bridge.clientId }],
    defaultChatTargetId: 'local',
    chatTargets: targets.map((target) => ({
      id: target.id,
      label: target.label,
      acquire: async () => {
        const clients = browserClients(window.moonbaseChat, target.id);
        return {
          chat: clients.chat,
          ...(target.mode === 'local'
            ? { providers: clients.providers }
            : { connection: clients.connection }),
          mode: target.mode,
          context: await window.moonbaseChat.context(target.id),
          storage: {
            read: () =>
              localStorage.getItem(
                target.mode === 'local' ? 'moonbase.chat.local.v1' : 'moonbase.chat.v1',
              ),
            write: (value: string) =>
              localStorage.setItem(
                target.mode === 'local' ? 'moonbase.chat.local.v1' : 'moonbase.chat.v1',
                value,
              ),
          },
        };
      },
    })),
    confirmQuit: () => window.moonbaseChat.confirmQuit!(),
  });
  window.addEventListener('beforeunload', (event) => {
    if (!application.canUnload()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('unload', () => {
    void application.dispose().catch((error) => console.error(errorDTO(error).message));
  });
  root.render(<Desktop application={application} />);
} catch (error) {
  const dto = errorDTO(error);
  root.render(<StartupFailure error={{ ...dto, message: dto.message.slice(0, 512) }} />);
}
