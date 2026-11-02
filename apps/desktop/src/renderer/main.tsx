import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { makeChatController, makeChatModel, type ChatController } from '@moonbase/application/chat';
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import {
  normalizeApplicationError,
  runApplicationEffect,
} from '@moonbase/application/runtime/effect-client';
import { RendererCleanup, releaseInstance } from './cleanup.ts';
import { ChatView } from '../chat/view.tsx';
import { browserClients, type ChatBridge } from '../chat/wire.ts';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import {
  EditorWorkbench,
  makeEditorModel,
  makeEditorController,
  type EditorWorkbenchHandle,
} from '@moonbase/editor';
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
configureMonacoWorkers();
const bridge = window.moonbase,
  runtime = ManagedRuntime.make(Layer.empty),
  scope = Scope.makeUnsafe('parallel'),
  cleanup = new RendererCleanup(runtime, scope),
  editorScope = Scope.forkUnsafe(scope, 'parallel'),
  editorModel = await runApplicationEffect(
    runtime,
    makeEditorModel({ client: bridgeClient(bridge), clientId: bridge.clientId }).pipe(
      Effect.provideService(Scope.Scope, editorScope),
    ),
  ),
  controller = makeEditorController(runtime, editorModel);
cleanup.claim('editor');
const root = createRoot(document.getElementById('root')!);
const loaded = controller.load().catch(controller.report);
let chatError = '',
  chatInitializationFailed = false;
let chatScope: Scope.Closeable | null = null;
async function acquireChat(): Promise<ChatController | null> {
  try {
    const configured = unwrap(await bridge.chatConfigured());
    if (!configured) {
      chatError =
        'Remote chat is not configured. Launch with an explicit MOONBASE_CHAT_CONFIG to use a host. Local editing is available.';
      return null;
    }
    const context = await window.moonbaseChat.context();
    const { chat, connection } = browserClients(window.moonbaseChat);
    const storageKey = 'moonbase.chat.v1';
    cleanup.claim('chat');
    chatScope = Scope.forkUnsafe(scope, 'parallel');
    const model = await runApplicationEffect(
      runtime,
      makeChatModel({
        chat,
        connection,
        context,
        storage: {
          read: () => localStorage.getItem(storageKey),
          write: (value) => localStorage.setItem(storageKey, value),
        },
      }).pipe(Effect.provideService(Scope.Scope, chatScope)),
    );
    return makeChatController(runtime, model);
  } catch (error) {
    if (chatScope)
      await runApplicationEffect(runtime, Scope.close(chatScope, Exit.void)).catch(() => {});
    chatInitializationFailed = true;
    chatError =
      error instanceof Error
        ? error.message
        : 'Chat could not initialize. Preserve this user-data directory.';
    return null;
  }
}
let chat = await acquireChat(),
  chatActive = !!chat;
const chatConfigured = !!chat;
function disposeChat() {
  const current = chat,
    instanceScope = chatScope;
  if (!current || !instanceScope) return Promise.resolve();
  return releaseInstance(runtime, instanceScope, () => current.dispose()).then(() => {
    if (chat === current) {
      chat = null;
      chatScope = null;
    }
  });
}
let disposal: Promise<ErrorDTO | undefined> | undefined;
function disposeRenderer() {
  disposal ??= (async () => {
    cleanup.close('editor', () =>
      releaseInstance(runtime, editorScope, () => controller.dispose()),
    );
    if (chat) cleanup.close('chat', disposeChat);
    const failures: unknown[] = [];
    for (const release of [
      () => cleanup.drain(),
      () => runApplicationEffect(runtime, Scope.close(scope, Exit.void)),
      () => runApplicationEffect(runtime, runtime.disposeEffect),
    ]) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (!failures.length) return undefined;
    const first = normalizeApplicationError(failures[0]);
    return {
      ...errorDTO(first),
      message: failures
        .map((error) => normalizeApplicationError(error).message)
        .join('; ')
        .slice(0, 512),
    };
  })();
  return disposal;
}
window.addEventListener('beforeunload', (event) => {
  const state = controller.getSnapshot();
  if (
    chatInitializationFailed ||
    !state.recoveryReady ||
    (chatActive && chat && !chat.preserve())
  ) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('unload', () => {
  void disposeRenderer();
});
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
function Desktop() {
  const [closing, setClosing] = useState(false),
    [view, setView] = useState('editor'),
    [chatPanel, setChatPanel] = useState(!!chat),
    [openingChat, setOpeningChat] = useState(false),
    cleanupState = useSyncExternalStore(cleanup.subscribe, cleanup.getSnapshot);
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
  const selected = state.recovery.checkouts.find(
    (c) => c.checkoutId === state.recovery.selectedCheckoutId,
  );
  useEffect(() => {
    async function prepareQuit(id: string) {
      try {
        if (chatInitializationFailed || (chatActive && chat && !chat.preserve())) {
          setView('chat');
          bridge.quitResult(id, false);
          return;
        }
        // Check chat before destructive choices, then preserve newer drafts after them.
        setView('editor');
        const consent =
          ((await handle.current?.prepareQuit()) ?? false) &&
          (chatActive ? (chat?.preserve() ?? true) : true);
        if (!consent && chat?.getSnapshot().storageError) setView('chat');
        if (consent) flushSync(() => setClosing(true));
        bridge.quitResult(id, consent);
      } catch (error) {
        controller.report(error);
        bridge.quitResult(id, false);
      }
    }
    const off = bridge.actions((action, id, error) => {
      if (action === 'cleanup-error') cleanup.report(failure(error));
      if (action === 'quit') void prepareQuit(id);
      if (action === 'dispose') {
        flushSync(() => setClosing(true));
        void disposeRenderer().then((error) => {
          root.unmount();
          bridge.quitResult(id, true, error);
        });
      }
    });
    void loaded.then(() => bridge.ready());
    return off;
  }, []);
  useEffect(() => {
    const attach = () => {
      if (!chat || !chatPanel) return;
      const task = view === 'chat' && !document.hidden ? chat.start() : chat.detach();
      void task.catch(controller.report);
    };
    attach();
    document.addEventListener('visibilitychange', attach);
    return () => document.removeEventListener('visibilitychange', attach);
  }, [view, chatPanel]);
  const run = (task: Promise<unknown>) => {
    void task.catch(controller.report);
  };
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
        if (view !== 'editor' || !event.dataTransfer.files.length) return;
        event.preventDefault();
        if (!selected) {
          controller.report(Error('Open a checkout before importing files.'));
          return;
        }
        run(
          (async () => {
            const refs = unwrap(await bridge.drop(selected, [...event.dataTransfer.files]));
            if (refs.length) handle.current?.importFiles(selected, refs);
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
            hidden={!chatPanel && chatConfigured}
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
              if (!chat?.preserve()) {
                setView('chat');
                return;
              }
              cleanup.close('chat', disposeChat);
              chatActive = false;
              flushSync(() => {
                setChatPanel(false);
                setView('editor');
              });
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
            disabled={openingChat || !cleanup.available('chat')}
            onClick={() =>
              run(
                (async () => {
                  setOpeningChat(true);
                  try {
                    chat = await acquireChat();
                    chatActive = !!chat;
                    setChatPanel(!!chat);
                    setView('chat');
                  } finally {
                    setOpeningChat(false);
                  }
                })(),
              )
            }>
            Open Chat panel
          </Button>
        ) : null}
        {cleanupState.pending.length ? <span role="status">Finishing panel cleanup…</span> : null}
        <Button
          hidden={view !== 'editor'}
          {...stylex.props(controls.button)}
          disabled={!selected || state.preserving}
          onClick={() => {
            if (selected)
              run(
                (async () => {
                  const refs = unwrap<string[]>(
                    (await bridge.call(
                      'clipboard-imports',
                      { checkout: selected },
                      crypto.randomUUID(),
                    )) as never,
                  );
                  if (refs.length) handle.current?.importFiles(selected, refs);
                })(),
              );
          }}>
          Import clipboard files
        </Button>
      </header>
      {cleanupState.errors.length ? (
        <section role="alert" aria-label="Panel cleanup errors" {...stylex.props(styles.empty)}>
          <strong>Panel cleanup failed</strong>
          {cleanupState.errors.map((error, i) => (
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
              unwrap(await bridge.call('choose-checkout', null, crypto.randomUUID())) as
                | string
                | null
            }
            selectNativeImports={async (checkout) =>
              unwrap(
                await bridge.call('choose-imports', { checkout }, crypto.randomUUID()),
              ) as string[]
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
        {!chatConfigured ? (
          <section {...stylex.props(styles.empty)} aria-label="Remote chat configuration">
            <h1>Remote chat is unavailable</h1>
            <p role="status">{chatError}</p>
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
root.render(<Desktop />);
await loaded;
