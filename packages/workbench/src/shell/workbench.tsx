import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import type { MoonbaseApplication } from '@moonbase/application';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { ChatView } from '../chat/view.tsx';
import { EditorWorkbench, type EditorWorkbenchHandle } from '../editor/workbench.tsx';
import { styles } from './styles.ts';
import { MainTabs, tabValue } from './main-tabs.tsx';

export type WorkbenchHandle = {
  prepareQuit(): Promise<boolean>;
  importFiles(checkout: CheckoutTarget, references: string[]): void;
};
export type WorkbenchProps = {
  application: MoonbaseApplication;
  closing?: boolean;
  /** These callbacks return user-approved roots or opaque native references, never source paths. */
  selectCheckout?: () => Promise<string | null>;
  selectNativeImports?: (checkout: CheckoutTarget) => Promise<string[]>;
  selectClipboardImports?: (checkout: CheckoutTarget) => Promise<string[]>;
  selectDroppedImports?: (checkout: CheckoutTarget, files: File[]) => Promise<string[]>;
};
const noSubscription = () => () => {};
const noEditor = () => undefined;

export const Workbench = forwardRef<WorkbenchHandle, WorkbenchProps>(function Workbench(
  {
    application,
    closing = false,
    selectCheckout,
    selectNativeImports,
    selectClipboardImports,
    selectDroppedImports,
  },
  ref,
) {
  const controller = application.editors[0],
    lifecycle = useSyncExternalStore(application.subscribe, application.getSnapshot),
    state = useSyncExternalStore(
      controller?.subscribe ?? noSubscription,
      controller?.getSnapshot ?? noEditor,
    ),
    chat = application.chat;
  const [destination, setDestination] = useState<'project' | 'chat'>(
    controller ? 'project' : 'chat',
  );
  const handle = useRef<EditorWorkbenchHandle>(null),
    panels = useRef<Record<string, HTMLElement | null>>({}),
    focus = useRef<Record<string, HTMLElement | null>>({});
  const openCheckouts =
    state?.recovery.checkouts.filter((checkout) =>
      state.recovery.openCheckoutIds.includes(checkout.checkoutId),
    ) ?? [];
  const selected = openCheckouts.find(
    (checkout) => checkout.checkoutId === state?.recovery.selectedCheckoutId,
  );
  const chatTab = !!chat || !['closed', 'cleanup-blocked'].includes(lifecycle.chat.state);
  const projectValue = selected ? tabValue({ kind: 'project', checkout: selected }) : 'empty';
  const view = destination === 'chat' && chatTab ? 'chat' : projectValue;
  const currentView = useRef(view);
  useLayoutEffect(() => {
    currentView.current = view;
  }, [view]);
  const report = controller?.report ?? application.reportCleanup;
  const run = (task: Promise<unknown>) => {
    void task.catch(report);
  };
  const restoreFocus = (value: string) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (currentView.current !== value) return;
        const panel = panels.current[value === 'chat' ? 'chat' : 'project'];
        const previous = focus.current[value];
        const target =
          previous?.isConnected && panel?.contains(previous)
            ? previous
            : (panel?.querySelector<HTMLElement>('.monaco-editor textarea[role="textbox"]') ??
              panel?.querySelector<HTMLElement>('button:not([disabled]), [tabindex="0"]'));
        target?.focus();
      }),
    );
  };
  useImperativeHandle(ref, () => ({
    async prepareQuit() {
      // Reveal the editor's exact prompts and uncertainty controls, including Quit from Chat.
      if (controller) setDestination('project');
      const consent = await application.prepareQuit();
      if (
        !consent &&
        (application.chat?.getSnapshot().storageError ||
          application.getSnapshot().chat.state === 'initialization-failed')
      )
        setDestination('chat');
      return consent;
    },
    importFiles(checkout, references) {
      if (application.getSnapshot().phase === 'live') {
        setDestination('project');
        handle.current?.importFiles(checkout, references);
      }
    },
  }));
  useEffect(() => {
    const attach = () => {
      if (!chat) return;
      void (view === 'chat' && !document.hidden ? chat.start() : chat.detach()).catch(report);
    };
    attach();
    document.addEventListener('visibilitychange', attach);
    return () => document.removeEventListener('visibilitychange', attach);
  }, [view, chat, report]);
  async function openCheckout() {
    const root = await selectCheckout?.();
    if (root && controller && application.getSnapshot().phase === 'live') {
      setDestination('project');
      await controller.openCheckout(root);
    }
  }
  async function closeCheckout(checkout: CheckoutTarget) {
    if (!controller) return;
    setDestination('project');
    await controller.selectCheckout(checkout);
    await controller.closeCheckout(checkout);
  }
  async function importFiles(checkout: CheckoutTarget, selection: Promise<string[]>) {
    const references = await selection;
    if (references.length && application.getSnapshot().phase === 'live') {
      setDestination('project');
      handle.current?.importFiles(checkout, references);
    }
  }
  let status =
    view === 'chat' ? 'Remote host · Explicit Connect and Send' : 'Explicit Save · Local workspace';
  if (closing || lifecycle.phase === 'prepared') status = 'Closing workbench…';
  else if (state?.preserving) status = 'Preserving edits…';
  else if (state?.publication) status = 'Recovery confirmation pending';
  let chatHeading = 'Remote chat is unavailable';
  if (lifecycle.chat.state === 'initialization-failed')
    chatHeading = 'Remote chat could not initialize';
  else if (lifecycle.chat.state === 'cleanup-blocked')
    chatHeading = 'Remote chat cleanup is blocked';
  return (
    <Tabs.Root
      aria-label="Moonbase workbench"
      value={view}
      onValueChange={(value, details) => {
        const next = String(value);
        if (next === 'chat') setDestination('chat');
        else {
          const checkout = openCheckouts.find(
            (checkout) => tabValue({ kind: 'project', checkout }) === next,
          );
          if (checkout && controller) {
            run(controller.selectCheckout(checkout));
            setDestination('project');
          }
        }
        if (details.event instanceof MouseEvent && details.event.detail > 0) restoreFocus(next);
      }}
      inert={closing || ['prepared', 'disposing', 'disposed', 'failed'].includes(lifecycle.phase)}
      {...stylex.props(workbench.document, styles.shell)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        if (application.getSnapshot().phase !== 'live' || view === 'chat' || !selectDroppedImports)
          return;
        if (!selected) {
          report(Error('Open a checkout before importing files.'));
          return;
        }
        run(importFiles(selected, selectDroppedImports(selected, [...event.dataTransfer.files])));
      }}>
      <header {...stylex.props(styles.toolbar)}>
        <strong {...stylex.props(styles.title)}>Moonbase</strong>
        <span role="status">{status}</span>
        {selectCheckout && controller ? (
          <Button
            {...stylex.props(controls.button)}
            disabled={lifecycle.phase !== 'live' || state?.preserving}
            onClick={() => run(openCheckout())}>
            Open checkout
          </Button>
        ) : null}
        {!chat && lifecycle.chat.state !== 'unavailable' ? (
          <Button
            {...stylex.props(controls.button)}
            disabled={
              lifecycle.phase !== 'live' ||
              lifecycle.chat.state === 'opening' ||
              lifecycle.chat.state === 'cleanup-blocked' ||
              lifecycle.cleanup.pending.includes('chat')
            }
            onClick={() => run(application.openChat().then(() => setDestination('chat')))}>
            Open Chat panel
          </Button>
        ) : null}
        {lifecycle.cleanup.pending.length ? (
          <span role="status">Finishing panel cleanup…</span>
        ) : null}
        {selectClipboardImports && controller ? (
          <Button
            hidden={view === 'chat'}
            {...stylex.props(controls.button)}
            disabled={!selected || state?.preserving || lifecycle.phase !== 'live'}
            onClick={() => {
              if (selected) run(importFiles(selected, selectClipboardImports(selected)));
            }}>
            Import clipboard files
          </Button>
        ) : null}
      </header>
      <MainTabs
        checkouts={openCheckouts}
        value={view}
        chatVisible={chatTab}
        chatOpen={!!chat}
        disabled={lifecycle.phase !== 'live'}
        preserving={!!state?.preserving}
        closeCheckout={(checkout) => run(closeCheckout(checkout))}
        closeChat={() => {
          if (!application.closeChat()) {
            setDestination('chat');
            return;
          }
          setDestination('project');
          restoreFocus(projectValue);
        }}
      />
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
      {controller ? (
        <Tabs.Panel
          value={projectValue}
          keepMounted
          ref={(element) => {
            panels.current.project = element;
          }}
          onFocusCapture={(event) => {
            focus.current[projectValue] = event.target as HTMLElement;
          }}
          {...stylex.props(styles.panel)}>
          <section {...stylex.props(styles.panel)} aria-label="Editor workbench">
            <EditorWorkbench
              ref={handle}
              controller={controller}
              visible={view !== 'chat'}
              selectNativeImports={selectNativeImports}
            />
          </section>
        </Tabs.Panel>
      ) : null}
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
        {chat ? (
          <ChatView controller={chat} />
        ) : (
          <section {...stylex.props(styles.empty)} aria-label="Remote chat configuration">
            <h1>{chatHeading}</h1>
            <p role="status">
              {lifecycle.chat.error ?? 'Remote chat is not configured. Local editing is available.'}
            </p>
            <p>
              Local checkouts remain on this computer. Remote paths are descriptive; they do not
              open or synchronize local files.
            </p>
          </section>
        )}
      </Tabs.Panel>
    </Tabs.Root>
  );
});
