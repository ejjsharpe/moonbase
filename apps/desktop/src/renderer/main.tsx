import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { createMoonbaseApplication, type MoonbaseApplication } from '@moonbase/application';
import { ChatView } from '../chat/view.tsx';
import { browserClients, type ChatBridge } from '../chat/wire.ts';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { EditorWorkbench, type EditorWorkbenchHandle } from '@moonbase/editor';
import { configureMonacoWorkers } from '@moonbase/editor/workers';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { colors, space } from '@moonbase/ui/tokens.stylex';
import {
  bridgeClient,
  unwrap,
  errorDTO,
  failure,
  type ErrorDTO,
  type DesktopBridge,
} from '../wire.ts';
import '@moonbase/ui/reset.css';

declare global {
  interface Window {
    moonbase: DesktopBridge;
    moonbaseChat: ChatBridge;
  }
}
document.body.className = stylex.props(workbench.document).className ?? '';
const bridge = window.moonbase,
  root = createRoot(document.getElementById('root')!);
const styles = stylex.create({
  shell: {
    height: '100dvh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: colors.canvas,
    color: colors.text,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    padding: space.sm,
    flexWrap: 'wrap',
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
    backgroundColor: colors.chrome,
  },
  title: { flex: 1, minWidth: 80 },
  editor: { flex: 1, minHeight: 0, overflow: 'hidden' },
  panel: { flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  empty: { padding: space.lg, maxWidth: 740 },
});
function Desktop({ application }: { application: MoonbaseApplication }) {
  const controller = application.editors[0]!,
    lifecycle = useSyncExternalStore(application.subscribe, application.getSnapshot),
    chat = application.chat,
    chatPanel = !!chat,
    chatConfigured = lifecycle.chat.state !== 'unavailable';
  const [closing, setClosing] = useState(false),
    [releasing, setReleasing] = useState(false),
    [view, setView] = useState('editor');
  const panels = useRef<Record<string, HTMLElement | null>>({}),
    focus = useRef<Record<string, HTMLElement | null>>({});
  const currentView = useRef(view);
  useLayoutEffect(() => {
    currentView.current = view;
  }, [view]);
  const handle = useRef<EditorWorkbenchHandle>(null),
    state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  let status =
    view === 'editor'
      ? 'Explicit Save · Local workspace'
      : 'Remote host · Explicit Connect and Send';
  if (closing) status = 'Closing workbench…';
  else if (state.preserving) status = 'Preserving edits…';
  else if (state.publication) status = 'Recovery confirmation pending';
  let chatHeading = 'Remote chat is unavailable';
  if (lifecycle.chat.state === 'initialization-failed')
    chatHeading = 'Remote chat could not initialize';
  else if (lifecycle.chat.state === 'cleanup-blocked')
    chatHeading = 'Remote chat cleanup is blocked';
  const selected = state.recovery.checkouts.find(
    (c) => c.checkoutId === state.recovery.selectedCheckoutId,
  );
  useEffect(() => {
    async function prepareQuit(id: string) {
      try {
        setView('editor');
        const consent = await application.prepareQuit();
        if (
          !consent &&
          (application.chat?.getSnapshot().storageError ||
            application.getSnapshot().chat.state === 'initialization-failed')
        )
          setView('chat');
        if (consent) flushSync(() => setClosing(true));
        bridge.quitResult(id, consent);
      } catch (error) {
        controller.report(error);
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
  }, [application, controller]);
  useEffect(() => {
    const attach = () => {
      if (!chat || !chatPanel) return;
      const task = view === 'chat' && !document.hidden ? chat.start() : chat.detach();
      void task.catch(controller.report);
    };
    attach();
    document.addEventListener('visibilitychange', attach);
    return () => document.removeEventListener('visibilitychange', attach);
  }, [view, chat, chatPanel, controller]);
  const run = (task: Promise<unknown>) => {
    void task.catch(controller.report);
  };
  if (releasing)
    return (
      <main {...stylex.props(styles.empty)}>
        <span role="status">Closing workbench…</span>
      </main>
    );
  return (
    <Tabs.Root
      aria-label="Moonbase workbench"
      value={view}
      onValueChange={(value, details) => {
        const next = String(value);
        setView(next);
        if (details.event instanceof MouseEvent && details.event.detail > 0)
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const element = focus.current[next];
              if (
                currentView.current === next &&
                element?.isConnected &&
                panels.current[next]?.contains(element)
              )
                element.focus();
            }),
          );
      }}
      inert={closing}
      {...stylex.props(workbench.document, styles.shell)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (
          application.getSnapshot().phase !== 'live' ||
          view !== 'editor' ||
          !event.dataTransfer.files.length
        )
          return;
        event.preventDefault();
        if (!selected) {
          controller.report(Error('Open a checkout before importing files.'));
          return;
        }
        run(
          (async () => {
            const refs = unwrap(await bridge.drop(selected, [...event.dataTransfer.files]));
            if (refs.length && application.getSnapshot().phase === 'live')
              handle.current?.importFiles(selected, refs);
          })(),
        );
      }}>
      <header {...stylex.props(styles.toolbar)}>
        <strong {...stylex.props(styles.title)}>Moonbase</strong>
        <Tabs.List aria-label="Workbench views" {...stylex.props(controls.row)}>
          <Tabs.Tab
            value="editor"
            {...stylex.props(controls.button, view === 'editor' && workbench.fileSelected)}>
            Editor
          </Tabs.Tab>
          <Tabs.Tab
            hidden={!chatPanel && ['closed', 'cleanup-blocked'].includes(lifecycle.chat.state)}
            value="chat"
            {...stylex.props(controls.button, view === 'chat' && workbench.fileSelected)}>
            Chat
          </Tabs.Tab>
        </Tabs.List>
        <span role="status">{status}</span>
        {chatPanel && chat ? (
          <Button
            {...stylex.props(controls.button)}
            onClick={() => {
              if (!application.closeChat()) {
                setView('chat');
                return;
              }
              flushSync(() => setView('editor'));
              requestAnimationFrame(() => {
                const target =
                  focus.current.editor ??
                  panels.current.editor?.querySelector<HTMLElement>(
                    'button:not([disabled]), [tabindex="0"]',
                  );
                target?.focus();
              });
            }}>
            Close Chat panel
          </Button>
        ) : null}
        {!chatPanel && chatConfigured ? (
          <Button
            {...stylex.props(controls.button)}
            disabled={
              lifecycle.phase !== 'live' ||
              lifecycle.chat.state === 'opening' ||
              lifecycle.chat.state === 'cleanup-blocked' ||
              lifecycle.cleanup.pending.includes('chat')
            }
            onClick={() =>
              run(
                (async () => {
                  await application.openChat();
                  setView('chat');
                })(),
              )
            }>
            Open Chat panel
          </Button>
        ) : null}
        {lifecycle.cleanup.pending.length ? (
          <span role="status">Finishing panel cleanup…</span>
        ) : null}
        <Button
          hidden={view !== 'editor'}
          {...stylex.props(controls.button)}
          disabled={!selected || state.preserving}
          onClick={() => {
            if (selected && application.getSnapshot().phase === 'live')
              run(
                (async () => {
                  const refs = unwrap<string[]>(
                    (await bridge.call(
                      'clipboard-imports',
                      { checkout: selected },
                      crypto.randomUUID(),
                    )) as never,
                  );
                  if (refs.length && application.getSnapshot().phase === 'live')
                    handle.current?.importFiles(selected, refs);
                })(),
              );
          }}>
          Import clipboard files
        </Button>
      </header>
      {lifecycle.chat.state === 'initialization-failed' && view !== 'chat' ? (
        <section
          role="alert"
          aria-label="Remote chat initialization failed"
          {...stylex.props(styles.empty)}>
          <strong>Remote chat could not initialize</strong>
          <p>{lifecycle.chat.error}</p>
          <p>Local editing is available. Open Chat panel to retry before closing this workbench.</p>
        </section>
      ) : null}
      {lifecycle.cleanup.errors.length ? (
        <section role="alert" aria-label="Panel cleanup errors" {...stylex.props(styles.empty)}>
          <strong>Panel cleanup failed</strong>
          {lifecycle.cleanup.errors.map((error, i) => (
            <p key={i}>{error}</p>
          ))}
          <p>Quit Moonbase before reopening this panel. Preserved recovery remains available.</p>
        </section>
      ) : null}
      <Tabs.Panel
        value="editor"
        keepMounted
        ref={(element) => {
          panels.current.editor = element;
        }}
        onFocusCapture={(event) => {
          focus.current.editor = event.target as HTMLElement;
        }}
        {...stylex.props(styles.panel)}>
        <section {...stylex.props(styles.editor)} aria-label="Editor workbench">
          <EditorWorkbench
            ref={handle}
            controller={controller}
            selectCheckout={async () =>
              application.getSnapshot().phase === 'live'
                ? (unwrap(await bridge.call('choose-checkout', null, crypto.randomUUID())) as
                    | string
                    | null)
                : null
            }
            selectNativeImports={async (checkout) =>
              application.getSnapshot().phase === 'live'
                ? (unwrap(
                    await bridge.call('choose-imports', { checkout }, crypto.randomUUID()),
                  ) as string[])
                : []
            }
          />
        </section>
      </Tabs.Panel>
      <Tabs.Panel
        value="chat"
        keepMounted
        ref={(element) => {
          panels.current.chat = element;
        }}
        onFocusCapture={(event) => {
          focus.current.chat = event.target as HTMLElement;
        }}
        {...stylex.props(styles.panel)}>
        {chat && chatPanel ? <ChatView controller={chat} /> : null}
        {!chat ? (
          <section {...stylex.props(styles.empty)} aria-label="Remote chat configuration">
            <h1>{chatHeading}</h1>
            <p role="status">
              {lifecycle.chat.error ??
                'Remote chat is not configured. Launch with an explicit MOONBASE_CHAT_CONFIG to use a host. Local editing is available.'}
            </p>
            <p>
              Local checkouts remain on this computer. Remote paths are descriptive; they do not
              open or synchronize local files.
            </p>
          </section>
        ) : null}
      </Tabs.Panel>
    </Tabs.Root>
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
  return (
    <main role="alert" aria-label="Workbench startup failed" {...stylex.props(styles.empty)}>
      <h1>The workbench could not initialize</h1>
      <p>{error.message}</p>
      <p>
        Keep this user-data directory. Preserved recovery remains available; no saved work was
        reset.
      </p>
      <p>Quit Moonbase from the application menu before trying again.</p>
    </main>
  );
}

try {
  configureMonacoWorkers();
  const application = await createMoonbaseApplication({
    editors: [{ client: bridgeClient(bridge), clientId: bridge.clientId }],
    chat: async () => {
      if (!unwrap(await bridge.chatConfigured())) return null;
      return {
        ...browserClients(window.moonbaseChat),
        context: await window.moonbaseChat.context(),
        storage: {
          read: () => localStorage.getItem('moonbase.chat.v1'),
          write: (value) => localStorage.setItem('moonbase.chat.v1', value),
        },
      };
    },
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
