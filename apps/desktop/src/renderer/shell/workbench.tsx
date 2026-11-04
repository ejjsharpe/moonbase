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
import { Choice } from '../chat/choice.tsx';
import { ChatView } from '../chat/view.tsx';
import { Workbench, type WorkbenchHandle } from '@moonbase/workbench';
import { styles } from './styles.ts';
import { MainTabs, tabValue } from './main-tabs.tsx';

export type DesktopShellHandle = {
  prepareQuit(): Promise<boolean>;
  importFiles(checkout: CheckoutTarget, references: string[]): void;
};
export type DesktopShellProps = {
  application: MoonbaseApplication;
  closing?: boolean;
  /** These callbacks return user-approved roots or opaque native references, never source paths. */
  chooseChatFolder?: () => Promise<string | null>;
  selectCheckout?: () => Promise<string | null>;
  selectClipboardImports?: (checkout: CheckoutTarget) => Promise<string[]>;
  selectDroppedImports?: (checkout: CheckoutTarget, files: File[]) => Promise<string[]>;
};
const noSubscription = () => () => {};
const noEditor = () => undefined;

export const DesktopShell = forwardRef<DesktopShellHandle, DesktopShellProps>(function DesktopShell(
  {
    application,
    closing = false,
    chooseChatFolder,
    selectCheckout,
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
  const [destination, setDestination] = useState<'project' | 'chat'>('chat');
  const handle = useRef<WorkbenchHandle>(null),
    requestedFocus = useRef<string | null>(null),
    panels = useRef<Record<string, HTMLElement | null>>({}),
    focus = useRef<Record<string, HTMLElement | null>>({});
  const openCheckouts =
    state?.recovery.openCheckoutIds
      .map((id) => state.recovery.checkouts.find((checkout) => checkout.checkoutId === id))
      .filter((checkout) => checkout !== undefined) ?? [];
  const selected = openCheckouts.find(
    (checkout) => checkout.checkoutId === state?.recovery.selectedCheckoutId,
  );
  const chatTab = !!chat || !['closed', 'cleanup-blocked'].includes(lifecycle.chat.state);
  const projectValue = selected ? tabValue({ kind: 'project', checkout: selected }) : 'empty';
  const view = (destination === 'chat' || !selected) && chatTab ? 'chat' : projectValue;
  const report = controller?.report ?? application.reportCleanup;
  const run = (task: Promise<unknown>) => {
    void task.catch(report);
  };
  const restoreFocus = (value: string) => {
    requestedFocus.current = value;
  };
  useLayoutEffect(() => {
    const value = requestedFocus.current;
    requestedFocus.current = null;
    if (value !== view) return;
    const panel = panels.current[value === 'chat' ? 'chat' : 'project'];
    const previous = focus.current[value];
    const target =
      previous?.isConnected && panel?.contains(previous)
        ? previous
        : (panel?.querySelector<HTMLElement>('.monaco-editor textarea[role="textbox"]') ??
          panel?.querySelector<HTMLElement>('button:not([disabled]), [tabindex="0"]'));
    target?.focus();
  });
  useImperativeHandle(ref, () => ({
    async prepareQuit() {
      // Reveal the editor's exact prompts and uncertainty controls, including Quit from Chat.
      if (controller && openCheckouts.length) setDestination('project');
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
    if (!(await controller.closeCheckout(checkout))) {
      const selection = controller.selectCheckout(checkout);
      setDestination('project');
      await selection;
    }
  }
  async function importFiles(checkout: CheckoutTarget, selection: Promise<string[]>) {
    const references = await selection;
    if (references.length && application.getSnapshot().phase === 'live') {
      setDestination('project');
      handle.current?.importFiles(checkout, references);
    }
  }
  let status = view === 'chat' ? 'Agents · Explicit Send' : 'Explicit Save · Local workspace';
  if (closing || lifecycle.phase === 'prepared') status = 'Closing workbench…';
  else if (state?.publication) status = 'Recovery confirmation pending';
  let chatHeading = 'Chat is unavailable';
  if (lifecycle.chat.state === 'initialization-failed') chatHeading = 'Chat could not initialize';
  else if (lifecycle.chat.state === 'cleanup-blocked') chatHeading = 'Chat cleanup is blocked';
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
        if (next !== view && details.event instanceof MouseEvent && details.event.detail > 0)
          restoreFocus(next);
      }}
      inert={closing || ['prepared', 'disposing', 'disposed', 'failed'].includes(lifecycle.phase)}
      {...stylex.props(workbench.document, styles.shell)}
      onKeyDown={(event) => {
        if (view !== 'chat' && !event.defaultPrevented) handle.current?.keyDown(event);
      }}
      onKeyUp={(event) => {
        if (view !== 'chat' && !event.defaultPrevented) handle.current?.keyUp(event);
      }}
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
      <MainTabs
        checkouts={openCheckouts}
        value={view}
        chatVisible={chatTab}
        chatOpen={!!chat}
        disabled={lifecycle.phase !== 'live'}
        preserving={!!state?.preserving}
        openCheckout={selectCheckout && controller ? () => run(openCheckout()) : undefined}
        openChat={
          !chat && lifecycle.chat.state !== 'unavailable'
            ? () => run(application.openChat().then(() => setDestination('chat')))
            : undefined
        }
        chatDisabled={
          lifecycle.chat.state === 'opening' ||
          lifecycle.chat.state === 'cleanup-blocked' ||
          lifecycle.cleanup.pending.includes('chat')
        }
        closeCheckout={(checkout) => run(closeCheckout(checkout))}
        closeChat={() => {
          if (!application.closeChat()) {
            setDestination('chat');
            return;
          }
          setDestination('project');
          if (view === 'chat') restoreFocus(projectValue);
        }}
      />
      {(closing ||
        lifecycle.phase === 'prepared' ||
        state?.publication ||
        lifecycle.cleanup.pending.length > 0) && (
        <div role="status" {...stylex.props(styles.status)}>
          {lifecycle.cleanup.pending.length ? 'Finishing panel cleanup…' : status}
        </div>
      )}
      {state?.preserving && (
        <div role="status" {...stylex.props(controls.hidden)}>
          Preserving edits…
        </div>
      )}
      {view === 'chat' && !selected && !!state?.errors.length && (
        <div role="alert" {...stylex.props(controls.status, controls.alert)}>
          {state.errors.at(-1)}{' '}
          <Button {...stylex.props(controls.button)} onClick={() => controller?.clearErrors()}>
            Dismiss error
          </Button>
        </div>
      )}
      {lifecycle.chat.state === 'initialization-failed' && view !== 'chat' ? (
        <section
          role="alert"
          aria-label="Chat initialization failed"
          {...stylex.props(styles.empty)}>
          <strong>Chat could not initialize</strong>
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
          hidden={view === 'chat'}
          ref={(element) => {
            panels.current.project = element;
          }}
          onFocusCapture={(event) => {
            focus.current[projectValue] = event.target as HTMLElement;
          }}
          {...stylex.props(styles.panel)}>
          <section {...stylex.props(styles.panel)} aria-label="Editor workbench">
            <Workbench
              ref={handle}
              controller={controller}
              checkout={selected}
              visible={view !== 'chat'}
              selectClipboardImports={
                selectClipboardImports &&
                ((checkout) =>
                  application.getSnapshot().phase === 'live'
                    ? selectClipboardImports(checkout)
                    : Promise.resolve([]))
              }
            />
          </section>
        </Tabs.Panel>
      ) : null}
      <Tabs.Panel
        value="chat"
        keepMounted
        hidden={view !== 'chat'}
        ref={(element) => {
          panels.current.chat = element;
        }}
        onFocusCapture={(event) => {
          focus.current.chat = event.target as HTMLElement;
        }}
        {...stylex.props(styles.panel)}>
        {lifecycle.chatTargets.length > 1 && (
          <div {...stylex.props(styles.chatTargetBar)}>
            <div {...stylex.props(styles.chatTargetChoice)}>
              <Choice
                label="Chat target"
                compact
                value={lifecycle.chatTargetId ?? ''}
                options={lifecycle.chatTargets.map((target) => ({
                  value: target.id,
                  label: target.label,
                }))}
                disabled={lifecycle.phase !== 'live' || lifecycle.chat.state === 'opening'}
                onChange={(id) => run(application.selectChatTarget(id))}
              />
            </div>
          </div>
        )}
        {chat ? (
          <ChatView
            key={lifecycle.chatTargetId}
            controller={chat}
            chooseFolder={chooseChatFolder}
          />
        ) : (
          <section {...stylex.props(styles.empty)} aria-label="Chat configuration">
            <h1>{chatHeading}</h1>
            <p role="status">
              {lifecycle.chat.error ?? 'Chat is unavailable. Local editing is available.'}
            </p>
            <p>
              Local editing remains available. Open Chat panel to retry initialization, or choose
              another chat target.
            </p>
          </section>
        )}
      </Tabs.Panel>
    </Tabs.Root>
  );
});
