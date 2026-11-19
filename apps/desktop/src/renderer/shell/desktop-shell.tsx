import {
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Context, Effect } from 'effect';
import { RegistryContext, useAtomValue } from '@effect/atom-react';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import { Tabs } from '@base-ui/react/tabs';
import * as stylex from '@stylexjs/stylex';
import { titleBar } from './title-bar.stylex.ts';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { Place } from '@moonbase/application';
import { ChatConnection, ChatSelection, findComposerPlace } from '@moonbase/application/chat';
import { EditorWorktrees } from '@moonbase/application/editor';
import { colors, rail } from '@moonbase/ui/tokens.stylex';
import { workbench } from '@moonbase/ui/workbench';
import { checkoutName } from '@moonbase/ui/projects';
import {
  isFileDropTaken,
  useEditorActions,
  Workbench,
  type WorkbenchEditor,
  type WorkbenchHandle,
} from '@moonbase/workbench';
import { useStoredToggle } from '../hooks/use-stored-toggle.ts';
import { nowAtom } from '../hooks/use-now.ts';
import { focusMessage, focusMessageEnd } from '../chat/open-chat.ts';
import type { DesktopNativeShape } from '../ipc/desktop-native.ts';
import type { ChatTargetId } from '../../ipc/chat-rpcs.ts';
import { reporting, useRun, type ViewWork } from '../hooks/use-run.ts';
import { Settings, type SettingsSection } from './settings.tsx';
import { Rail, tabValue } from './rail/rail.tsx';
import { TitleBar } from './title-bar.tsx';
import { defaultDockWidths, ProjectDock } from './project-dock.tsx';
import { ShellNotices } from './shell-notices.tsx';
import { AgentsChat } from './agents-chat.tsx';
import { makeCheckoutActions } from './checkout-actions.ts';
import { makePickerEntries } from './picker-entries.ts';
import { mac, ownPageKeys, readShellCommand, useShellKeys } from './use-shell-keys.ts';
import { isMainCheckout, readShellCheckouts } from './shell-checkouts.ts';
import { useViewFocus } from './use-view-focus.ts';
import { usePlaceHistory } from './use-place-history.ts';
import { useDesktopApplication, type DesktopApplication } from './desktop-application.ts';

export type DesktopShellHandle = {
  /** Asks to quit, showing what must be answered first; succeeds whether the window may close. */
  prepareQuit: Effect.Effect<boolean, unknown>;
  importFiles(checkout: CheckoutTarget, references: string[]): void;
};
/**
 * Main's native capabilities the shell offers (`DesktopNative`'s), each only where supplied. They
 * return user-approved roots, never source paths. The editor's own (Copy Path, Reveal, imports)
 * are its workbench platform.
 */
export type ShellNative = Partial<
  Pick<
    DesktopNativeShape,
    | 'transcripts'
    | 'chooseChatFolder'
    | 'listChatFolders'
    | 'createChatWorktree'
    | 'turnChatIntoProject'
    | 'chooseCheckout'
  >
>;
export type DesktopShellProps = {
  application: DesktopApplication;
  /** The project editor the shell's workbench shows. */
  editor: WorkbenchEditor;
  closing?: boolean;
  native?: ShellNative;
};
const railCollapsedKey = 'moonbase.rail.collapsed';
const sidebarHiddenKey = 'moonbase.sidebar.hidden';
/** The window's shortcut on the editor's cheat sheet. */
const windowShortcuts = [{ label: 'Project chats', keys: 'Meta+J' }];
/**
 * The window: its title bar, the project rail, and a view at a time (Agents, or a project's
 * workbench with its chats docked beside it), with Settings over them.
 */
export const DesktopShell = forwardRef<DesktopShellHandle, DesktopShellProps>(function DesktopShell(
  { application: desktopApplication, editor, closing = false, native = {} },
  ref,
) {
  const application = useDesktopApplication(desktopApplication),
    controller = useEditorActions(editor),
    { lifecycle, chat, composer } = application,
    state = useAtomValue(editor.atoms.snapshot);
  const worktrees = Context.get(editor.context, EditorWorktrees);
  const registry = useContext(RegistryContext);
  const [destination, setDestination] = useState<'project' | 'chat'>('chat');
  // Kept here, so the dock comes back at its width after a host switch or chat reopens.
  const [dockWidths, setDockWidths] = useState(defaultDockWidths);
  const [dockOpen, setDockOpen] = useState(true);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  // Agents puts the open chat's title and actions here, in place of a header of its own.
  const [chatTitle, setChatTitle] = useState<HTMLDivElement | null>(null);
  const projectWorktrees = useAtomValue(editor.atoms.worktrees);
  const [railCollapsed, toggleRail] = useStoredToggle(railCollapsedKey);
  const [sidebarHidden, toggleSidebar, setSidebarHidden] = useStoredToggle(sidebarHiddenKey);
  const root = useRef<HTMLDivElement>(null),
    handle = useRef<WorkbenchHandle>(null),
    dock = useRef<HTMLElement>(null),
    projectFocus = useRef<HTMLElement | null>(null);
  const {
    open: openCheckouts,
    selected,
    folderProjects,
    recent: recentCheckouts,
  } = readShellCheckouts(state?.recovery);
  const chatTab = !!chat || !['closed', 'cleanup-blocked'].includes(lifecycle.chat.state);
  const projectValue = selected ? tabValue({ kind: 'project', checkout: selected }) : 'empty';
  const view = (destination === 'chat' || !selected) && chatTab ? 'chat' : projectValue;
  const { panels, focus, focusView, restoreFocus } = useViewFocus(view);
  // One ChatView at a time: in the project dock while it shows, otherwise in Agents.
  const dockVisible = view !== 'chat' && !!selected && !!chat && dockOpen;
  const activePath = selected && state && state.recovery.views.get(selected.checkoutId)?.active;
  const projectCheckouts = selected
    ? openCheckouts.filter(
        (checkout) =>
          checkout.hostId === selected.hostId && checkout.projectId === selected.projectId,
      )
    : [];
  // A chat in any of the project's worktrees, including one a chat created, belongs to its dock.
  const dockCheckout = dockVisible ? selected : undefined;
  useEffect(() => {
    if (dockCheckout) controller.start(worktrees.list(dockCheckout));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Listed again only for another checkout.
  }, [dockCheckout?.checkoutId]);
  const dockRoots = [
    ...projectCheckouts.map((checkout) => checkout.root),
    ...(projectWorktrees && projectWorktrees.checkoutId === selected?.checkoutId
      ? projectWorktrees.roots
      : []),
  ];
  const report = controller.report;
  // The shell's own work, which ends with it; a failure shows in the editor's alerts.
  const start = useRun();
  const run = (work: ViewWork) => start(reporting(work, report));
  /** One of the open chat's actions, which shows its own failure. */
  const actInChat = (action: (selection: ChatSelection['Service']) => Effect.Effect<void>) =>
    chat ? action(Context.get(chat, ChatSelection)) : Effect.void;
  const startNewChat = () => {
    if (!chat) return;
    setDestination('chat');
    run(
      Effect.tap(
        actInChat((selection) => selection.closeView),
        () => Effect.sync(focusMessage),
      ),
    );
  };
  const showChat = () => {
    setDestination('chat');
    if (view !== 'chat') restoreFocus('chat');
  };
  const showPlace = (place: Place) =>
    Effect.gen(function* () {
      if (place.kind === 'chat') {
        if (!chat) return;
        setDestination('chat');
        const target = place.chat;
        yield* actInChat((selection) => (target ? selection.select(target) : selection.closeView));
        return;
      }
      const checkout = openCheckouts.find((open) => open.checkoutId === place.checkoutId);
      if (!checkout) return;
      setDestination('project');
      if (checkout.checkoutId !== selected?.checkoutId) yield* controller.selectCheckout(checkout);
      // A file closed since opens again, as a preview, as in VS Code.
      if (place.path) yield* controller.open({ checkout, path: place.path }, { intent: 'preview' });
    });
  const { back, forward } = usePlaceHistory({
    application: desktopApplication,
    chat,
    project: view === 'chat' ? undefined : selected,
    activePath,
    openCheckouts,
    show: showPlace,
    report,
  });
  // Hiding the rail while focus is in it hands focus back to the view, not the page.
  const toggleRailKeepingFocus = () => {
    if (!railCollapsed && document.activeElement?.closest('[aria-label="Workbench views"]'))
      restoreFocus(view);
    toggleRail();
  };
  // Hiding project chats while focus is in them hands it back to the project, not the page.
  const showDock = (open: boolean) => {
    const element = dock.current;
    if (!open && element?.contains(document.activeElement)) {
      const previous = projectFocus.current;
      if (previous?.isConnected && !element.contains(previous)) previous.focus();
      if (element.contains(document.activeElement)) focusView(projectValue, element);
    } else if (
      !open &&
      element?.contains(focus.current[projectValue]) &&
      document.activeElement?.closest('[role="dialog"]')
    ) {
      // From a dialog such as the picker, which would return focus to the dock as it goes: focus
      // goes back to the project once both have.
      focus.current[projectValue] = projectFocus.current;
      restoreFocus(projectValue);
    }
    setDockOpen(open);
  };
  useImperativeHandle(ref, () => ({
    prepareQuit: Effect.gen(function* () {
      // Reveal the editor's exact prompts and uncertainty controls, including Quit from Chat.
      if (openCheckouts.length) setDestination('project');
      const consent = yield* application.prepareQuit;
      if (
        !consent &&
        (application.readChat((atoms) => atoms.storageError) ||
          application.getSnapshot().chat.state === 'initialization-failed')
      )
        setDestination('chat');
      return consent;
    }),
    importFiles(checkout, references) {
      if (application.getSnapshot().phase === 'live') {
        setDestination('project');
        handle.current?.importFiles(checkout, references);
      }
    },
  }));
  // Chat stays attached while it exists, behind a project or a hidden window too, so coming back
  // shows the transcript as it was, still following a running reply. Disposal detaches it.
  useEffect(() => {
    if (chat) start(Context.get(chat, ChatConnection).start);
  }, [chat, start]);
  const checkoutActions = makeCheckoutActions({
    editor: controller,
    isLive: () => application.getSnapshot().phase === 'live',
    selectCheckout: native.chooseCheckout,
    showProject: () => setDestination('project'),
    importInto: (checkout, references) => handle.current?.importFiles(checkout, references),
  });
  const { openCheckout, closeCheckout } = checkoutActions;
  const shellInert =
    closing || ['prepared', 'disposing', 'disposed', 'failed'].includes(lifecycle.phase);
  /** The window's keys, from inside the shell or, when pressed on the page, the one it owns. */
  const keyDown = (event: ReactKeyboardEvent | KeyboardEvent) => {
    const command = readShellCommand(event, {
      chat: !!chat,
      picker: !!controller,
      project: view !== 'chat',
    });
    if (command) event.preventDefault();
    if (command?.kind === 'settings') setSettings((open) => open ?? 'hosts');
    else if (command?.kind === 'new-chat') startNewChat();
    else if (command?.kind === 'picker') handle.current?.openPicker(command.mode);
    else if (command?.kind === 'dock') showDock(!dockOpen);
    else if (view !== 'chat' && !event.defaultPrevented)
      handle.current?.keyDown(event as ReactKeyboardEvent);
  };
  const keyUp = (event: ReactKeyboardEvent | KeyboardEvent) => {
    if (view !== 'chat' && !event.defaultPrevented)
      handle.current?.keyUp(event as ReactKeyboardEvent);
  };
  useShellKeys({
    root,
    toggleSidebar,
    toggleRail: toggleRailKeepingFocus,
    step: (direction) => (direction < 0 ? back : forward)?.(),
    keyDown: (event) => !shellInert && keyDown(event),
    keyUp: (event) => !shellInert && keyUp(event),
  });
  const chatTargetId = lifecycle.chatTargetId;
  // Each target's recent folders, listed again each time a folder menu opens.
  const { listChatFolders, createChatWorktree, turnChatIntoProject } = native;
  const recentChatFolders = useMemo(
    () =>
      listChatFolders &&
      Atom.family((targetId: string) => Atom.make(listChatFolders(targetId as ChatTargetId))),
    [listChatFolders],
  );
  // What both chat views (Agents and the dock) take.
  const chatViews = chat &&
    composer && {
      services: chat,
      composer,
      chooseFolder: native.chooseChatFolder,
      recentFolders: recentChatFolders?.(chatTargetId ?? 'local'),
      folderProjects,
      transcriptNative: native.transcripts?.[(chatTargetId ?? 'remote') as ChatTargetId],
    };
  return (
    <Tabs.Root
      aria-label="Moonbase workbench"
      orientation="vertical"
      value={view}
      onValueChange={(value, details) => {
        const next = String(value);
        if (next === 'chat') setDestination('chat');
        else {
          const checkout = openCheckouts.find(
            (checkout) => tabValue({ kind: 'project', checkout }) === next,
          );
          if (checkout) {
            run(controller.selectCheckout(checkout));
            setDestination('project');
          }
        }
        if (next !== view && details.event instanceof MouseEvent && details.event.detail > 0)
          restoreFocus(next);
      }}
      inert={shellInert}
      {...stylex.props(workbench.document, styles.shell, railCollapsed && styles.shellCollapsed)}
      ref={root}
      data-moonbase-shell=""
      onFocusCapture={(event) => ownPageKeys(event.currentTarget)}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        // The files tree takes a drop on it, importing into the folder dropped on.
        if (isFileDropTaken(event.nativeEvent) || !event.dataTransfer.files.length) return;
        event.preventDefault();
        if (view !== 'chat')
          run(checkoutActions.dropFiles(selected, [...event.dataTransfer.files]));
      }}>
      <TitleBar
        agents={view === 'chat'}
        chatOpen={!!chat}
        checkout={selected}
        activePath={activePath}
        back={back}
        forward={forward}
        sidebarHidden={sidebarHidden}
        toggleSidebar={toggleSidebar}
        dockOpen={dockOpen}
        toggleDock={() => showDock(!dockOpen)}
        startNewChat={startNewChat}
        chatTitle={setChatTitle}
        findAnchor={() =>
          (view === 'chat' ? panels.current.chat : panels.current.project)?.querySelector(
            '[data-title-anchor]',
          )
        }
        layout={JSON.stringify([
          view,
          railCollapsed,
          sidebarHidden,
          selected?.checkoutId,
          dockVisible,
          chatTargetId,
          !!chat,
        ])}
      />
      <Rail
        checkouts={openCheckouts}
        selectedCheckoutId={state?.recovery.selectedCheckoutId}
        value={view}
        chatVisible={chatTab}
        chatOpen={!!chat}
        disabled={lifecycle.phase !== 'live'}
        preserving={!!state?.preserving}
        openCheckout={native.chooseCheckout ? () => run(openCheckout) : undefined}
        recentCheckouts={recentCheckouts}
        reopenCheckout={(checkout) => {
          setDestination('project');
          run(controller.openCheckout(checkout.root));
        }}
        openSettings={() => setSettings('hosts')}
        collapsed={railCollapsed}
        toggleCollapsed={toggleRailKeepingFocus}
        focusView={() => focusView(view)}
        mac={mac}
        openChat={
          !chat && lifecycle.chat.state !== 'unavailable'
            ? () =>
                run(
                  Effect.tap(application.openChat, () => Effect.sync(() => setDestination('chat'))),
                )
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
      <ShellNotices
        lifecycle={lifecycle}
        closing={closing}
        agents={view === 'chat'}
        recoveryFailed={!!state?.recoveryFailed}
        preserving={!!state?.preserving}
        editorError={view === 'chat' && !selected ? state?.errors.at(-1) : undefined}
        clearEditorErrors={() => controller.clearErrors()}
      />
      {controller ? (
        <Tabs.Panel
          value={projectValue}
          keepMounted
          hidden={view === 'chat'}
          ref={(element) => {
            panels.current.project = element;
          }}
          onFocusCapture={(event) => {
            const target = event.target as HTMLElement;
            // Not a dialog the panel's tree portals elsewhere, such as the picker.
            if (!event.currentTarget.contains(target)) return;
            focus.current[projectValue] = target;
            if (!dock.current?.contains(target)) projectFocus.current = target;
          }}
          {...stylex.props(styles.panel, styles.framed, railCollapsed && styles.framedFlush)}>
          <section {...stylex.props(styles.panel)} aria-label="Editor workbench">
            <Workbench
              ref={handle}
              editor={editor}
              checkout={selected}
              showBreadcrumbs={false}
              sidebarHidden={sidebarHidden}
              onShowSidebar={() => setSidebarHidden(false)}
              shortcuts={windowShortcuts}
              visible={view !== 'chat'}
              // Read only while the picker is open.
              pickerEntries={() =>
                makePickerEntries({
                  chats: application.readChat((atoms) => atoms.list)?.chats ?? [],
                  now: AsyncResult.getOrThrow(registry.get(nowAtom(60_000))),
                  checkouts: openCheckouts,
                  showChat: chat
                    ? (summary) => {
                        run(actInChat((selection) => selection.select(summary.target)));
                        showChat();
                      }
                    : undefined,
                  showCheckout: (checkout) => {
                    run(controller.selectCheckout(checkout));
                    setDestination('project');
                    restoreFocus(tabValue({ kind: 'project', checkout }));
                  },
                  startNewChat: chat ? startNewChat : undefined,
                  dock:
                    view !== 'chat' && chat && selected
                      ? { open: dockOpen, toggle: () => showDock(!dockOpen) }
                      : undefined,
                  showAgents: view !== 'chat' && chatTab ? showChat : undefined,
                  openProject: native.chooseCheckout ? () => run(openCheckout) : undefined,
                })
              }
              mentionInChat={
                chat && composer && selected
                  ? (checkout, paths) => {
                      setDockOpen(true);
                      // The dock's chat takes them, relative to its folder, then has focus.
                      const remote = !!application.readChat((atoms) => atoms.link)?.remote;
                      const place = findComposerPlace(selected.root, remote);
                      const files = paths.map((path) => `${checkout.root}/${path}`);
                      run(
                        Effect.tap(composer.mention(place, files), () =>
                          Effect.sync(focusMessageEnd),
                        ),
                      );
                    }
                  : undefined
              }
              onShowEditor={() => {
                if (view !== 'chat') return;
                setDestination('project');
                restoreFocus(projectValue);
              }}
              trailing={
                chat && composer && selected ? (
                  <ProjectDock
                    widths={dockWidths}
                    onWidthsChange={setDockWidths}
                    dock={dock}
                    visible={dockVisible}
                    railCollapsed={railCollapsed}
                    project={checkoutName(projectCheckouts.find(isMainCheckout) ?? selected)}
                    roots={dockRoots}
                    cwd={selected.root}
                    collapse={() => showDock(false)}
                    chatKey={`${chatTargetId}:${selected.checkoutId}`}
                    chat={{
                      ...chatViews!,
                      createWorktree:
                        createChatWorktree &&
                        ((root, branch, requestId) =>
                          Effect.tap(createChatWorktree(root, branch, requestId), (created) =>
                            Effect.andThen(
                              worktrees.list(selected),
                              // Kept even if listing failed, so the new chat stays in this dock.
                              worktrees.add(selected.checkoutId, created),
                            ),
                          )),
                    }}
                  />
                ) : undefined
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
          if (event.currentTarget.contains(event.target)) focus.current.chat = event.target;
        }}
        {...stylex.props(styles.panel, styles.framed, railCollapsed && styles.framedFlush)}>
        <AgentsChat
          chat={
            chatViews && {
              ...chatViews,
              titleBar: chatTitle,
              sidebarHidden,
              createWorktree: createChatWorktree,
              turnIntoProject:
                turnChatIntoProject &&
                ((conversationId: string) =>
                  Effect.flatMap(turnChatIntoProject(conversationId), (root) =>
                    // The new project joins the rail; the chat stays open here.
                    application.getSnapshot().phase === 'live'
                      ? Effect.asVoid(controller.openCheckout(root))
                      : Effect.void,
                  )),
              visible: view === 'chat',
            }
          }
          lifecycle={lifecycle}
          shown={!dockVisible}
          selectTarget={(id) => run(application.selectChatTarget(id))}
          openSettings={setSettings}
        />
      </Tabs.Panel>
      {settings && (
        <Settings
          application={application}
          chat={chat}
          section={settings}
          onSectionChange={setSettings}
          close={() => setSettings(null)}
        />
      )}
    </Tabs.Root>
  );
});

const styles = stylex.create({
  // The rail is laid over this padding, so panels stay direct children of the tabs root.
  shell: {
    position: 'relative',
    height: '100%',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    paddingTop: titleBar.height,
    paddingLeft: rail.width,
    overflow: 'hidden',
    transitionProperty: 'padding',
    transitionDuration: '180ms',
    transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    backgroundColor: colors.chrome,
    color: colors.text,
  },
  // Collapsed: the rail slides out and the panes take its place; the header row stays as it was.
  shellCollapsed: { paddingLeft: 0 },
  // Each view is a panel tucked into the frame, its top-left corner rounded.
  framed: {
    borderWidth: 0,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    borderTopLeftRadius: 12,
    backgroundColor: colors.canvas,
  },
  // With the rail hidden, the panel meets the window's left edge.
  framedFlush: { borderLeftWidth: 0, borderTopLeftRadius: 0 },
  panel: { flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' },
});
