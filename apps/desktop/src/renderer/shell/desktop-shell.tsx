import { useStoredToggle } from '../hooks/use-stored-toggle.ts';
import type { TranscriptNative } from '../../ipc/chat-wire.ts';
import {
  Fragment,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Tabs } from '@base-ui/react/tabs';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import type { MoonbaseApplication } from '@moonbase/application';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { Settings, type SettingsSection } from './settings.tsx';
import { formatChatAge } from '../chat/age.ts';
import { getChatPlace } from '../chat/folder.ts';
import { ChatView } from '../chat/view.tsx';
import { checkoutName } from '@moonbase/ui/projects';
import { homePath } from '../folder-menu.tsx';
import { readOwn } from '@moonbase/application/editor';
import { Icon } from '@moonbase/ui/icons';
import {
  isFileDropTaken,
  Workbench,
  type PickerEntry,
  pickerCommand,
  pickerMode,
  type WorkbenchHandle,
} from '@moonbase/workbench';
import { styles } from './shell-styles.ts';
import {
  emptyHistory,
  findStep,
  isSamePlace,
  settleStep,
  stepTo,
  visitPlace,
  type Place,
} from './history.ts';
import { MainTabs, tabValue } from './main-tabs.tsx';

export type DesktopShellHandle = {
  prepareQuit(): Promise<boolean>;
  importFiles(checkout: CheckoutTarget, references: string[]): void;
};
export type DesktopShellProps = {
  application: MoonbaseApplication;
  closing?: boolean;
  /** These callbacks return user-approved roots or opaque native references, never source paths. */
  transcriptNative?: (backendId: string) => TranscriptNative;
  chooseChatFolder?: () => Promise<string | null>;
  /**
   * Folders a new chat on the target may use without a picker: local chat's recently approved
   * ones, or a remote host's approved roots and their folders.
   */
  recentChatFolders?: (targetId: string) => Promise<readonly string[]>;
  /** Creates a new local chat's linked worktree beside the repository, returning its root. */
  createChatWorktree?: (root: string, branch: string, requestId: string) => Promise<string>;
  /** Opens a local chat without a project's folder as a project where it is, returning its root. */
  turnChatIntoProject?: (conversationId: string) => Promise<string>;
  selectCheckout?: () => Promise<string | null>;
  selectClipboardImports?: (checkout: CheckoutTarget) => Promise<string[] | null>;
  /** Copies a checkout's paths to the clipboard, joined by newlines: absolute, or as `relative`. */
  copyPaths?: (checkout: CheckoutTarget, paths: string[], relative: boolean) => Promise<void>;
  /** Shows a checkout's file or folder in the OS file manager. */
  revealPath?: (checkout: CheckoutTarget, path: string) => Promise<void>;
  selectDroppedImports?: (checkout: CheckoutTarget, files: File[]) => Promise<string[]>;
};
const noSubscription = () => () => {};
/** Electron reports MacIntel on Apple silicon too. */
const mac = navigator.platform.startsWith('Mac');
const railCollapsedKey = 'moonbase.rail.collapsed';
const sidebarHiddenKey = 'moonbase.sidebar.hidden';
/**
 * The title never starts before back, forward and the sidebar button, which follow the window
 * controls on macOS.
 */
const titleMinLeft = (mac ? 84 : 8) + 3 * 28 + 2 * 2 + 12;
/** Back and forward through places, as in VS Code: ⌃- and ⌃⇧- on macOS, Alt+← and Alt+→ elsewhere. */
const placeSettleMs = 150,
  stepTimeoutMs = 3000;
const backShortcut = mac ? '⌃-' : 'Alt+←',
  forwardShortcut = mac ? '⌃⇧-' : 'Alt+→';
function readHistoryStep(event: KeyboardEvent): 1 | -1 | undefined {
  if (mac) {
    if (event.code !== 'Minus' || !event.ctrlKey || event.metaKey || event.altKey) return undefined;
    return event.shiftKey ? 1 : -1;
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
  if (event.key === 'ArrowLeft') return -1;
  return event.key === 'ArrowRight' ? 1 : undefined;
}
/** Hides and shows the main sidebar, as in most editors; ⌃⌘S, the macOS sidebar key, works too. */
const sidebarShortcut = mac ? '⌘B' : 'Ctrl+B';
/**
 * The letter a shortcut key types, lowercased: its character, so ⌘B follows the layout (on Dvorak
 * the key that types B, not the one where QWERTY has it). A key that types no Latin letter, on a
 * non-Latin layout or with ⌥ held on macOS, falls back to its physical key.
 */
function shortcutLetter(event: KeyboardEvent) {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : undefined;
}
/** The shell last focused, which takes keys pressed on the page itself when several share it. */
let pageKeysOwner: HTMLElement | null = null;
/**
 * Whether a shell takes keys pressed on the page itself: the one last focused, else the first one
 * showing, and none while a modal dialog has marked it aria-hidden.
 */
function ownsPageKeys(element: HTMLElement | null) {
  if (!element?.checkVisibility() || element.closest('[aria-hidden="true"]')) return false;
  const owner =
    pageKeysOwner?.isConnected && pageKeysOwner.checkVisibility()
      ? pageKeysOwner
      : [...document.querySelectorAll<HTMLElement>('[data-moonbase-shell]')].find((shell) =>
          shell.checkVisibility(),
        );
  return owner === element;
}
/** The window's shortcut on the editor's cheat sheet. */
const windowShortcuts = [{ label: 'Project chats', keys: 'Meta+J' }];
const railWidth = (collapsed: boolean) => (collapsed ? 0 : 52);
const dockDefaultWidth = 400,
  dockMinWidth = 320;
const noEditor = () => undefined;

export const DesktopShell = forwardRef<DesktopShellHandle, DesktopShellProps>(function DesktopShell(
  {
    application,
    closing = false,
    chooseChatFolder,
    recentChatFolders,
    createChatWorktree,
    turnChatIntoProject,
    transcriptNative,
    selectCheckout,
    selectClipboardImports,
    selectDroppedImports,
    copyPaths,
    revealPath,
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
  const [dockOpen, setDockOpen] = useState(true);
  const [resizingDock, setResizingDock] = useState(false);
  // Files the tree asked to mention in the dock's chat, until the dock takes them.
  const [chatMention, setChatMention] = useState<{ id: number; files: string[] } | null>(null);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [projectWorktrees, setProjectWorktrees] = useState<{
    checkoutId: string;
    roots: readonly string[];
  } | null>(null);
  const [railCollapsed, toggleRail] = useStoredToggle(railCollapsedKey);
  const [sidebarHidden, toggleSidebar, setSidebarHidden] = useStoredToggle(sidebarHiddenKey);
  // Hiding the rail while focus is in it hands focus back to the view, not the page.
  const toggleRailKeepingFocus = () => {
    if (!railCollapsed && document.activeElement?.closest('[aria-label="Workbench views"]'))
      restoreFocus(view);
    toggleRail();
  };
  const railToggle = useRef(toggleRailKeepingFocus);
  const navigation = useRef<(direction: 1 | -1) => void>(() => {});
  railToggle.current = toggleRailKeepingFocus;
  // The sidebar and rail keys work wherever focus is, even on the page itself. They are caught
  // before anything else sees them: ⌃⌘S would otherwise reach the editor's Save.
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.getModifierState('AltGraph') ||
        (event.target as Element | null)?.closest?.('[role="dialog"], [role="alertdialog"]')
      )
        return;
      const command = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const letter = shortcutLetter(event);
      let toggle: (() => void) | undefined;
      if (letter === 'b' && command && !event.altKey && !event.shiftKey) toggle = toggleSidebar;
      else if (
        letter === 's' &&
        event.ctrlKey &&
        (mac ? event.metaKey && !event.shiftKey : event.altKey && !event.metaKey)
      )
        // ⌃⌘S also toggles the sidebar; the rail adds ⌥ on macOS and Shift elsewhere.
        toggle = (mac ? event.altKey : event.shiftKey) ? railToggle.current : toggleSidebar;
      else {
        // Back and forward belong to the shell the key was pressed in, or that owns the page's.
        const step = readHistoryStep(event);
        const target = event.target;
        const onPage = target === document.body || target === document.documentElement;
        const inShell =
          target instanceof Node &&
          !!root.current?.contains(target) &&
          !root.current.closest('[aria-hidden="true"]');
        if (step && (inShell || (onPage && ownsPageKeys(root.current))))
          toggle = () => navigation.current(step);
      }
      if (!toggle) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggle();
    };
    window.addEventListener('keydown', keyDown, true);
    return () => window.removeEventListener('keydown', keyDown, true);
  }, [toggleSidebar]);
  // The mouse's own back and forward buttons.
  useEffect(() => {
    const mouseUp = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      const shell = root.current;
      if (!(event.target instanceof Node) || !shell?.contains(event.target)) return;
      if (shell.closest('[aria-hidden="true"]')) return;
      event.preventDefault();
      navigation.current(event.button === 3 ? -1 : 1);
    };
    window.addEventListener('mouseup', mouseUp);
    return () => window.removeEventListener('mouseup', mouseUp);
  }, []);
  // Focus falls to the page itself when a focused control unmounts or turns inert; the shell's keys
  // still work there, in one shell: the one last focused, else the first one showing. A modal
  // dialog marks the shell aria-hidden while it is open, and then owns the keys. The live handlers
  // are read on each key.
  const root = useRef<HTMLDivElement>(null);
  const shellKeys = useRef<{ down(event: KeyboardEvent): void; up(event: KeyboardEvent): void }>({
    down() {},
    up() {},
  });
  useEffect(() => {
    const forward = (event: KeyboardEvent) => {
      if (event.target !== document.body && event.target !== document.documentElement) return;
      if (!ownsPageKeys(root.current)) return;
      if (event.type === 'keydown') shellKeys.current.down(event);
      else shellKeys.current.up(event);
    };
    window.addEventListener('keydown', forward);
    window.addEventListener('keyup', forward);
    return () => {
      window.removeEventListener('keydown', forward);
      window.removeEventListener('keyup', forward);
    };
  }, []);
  const [dockWidth, setDockWidth] = useState(dockDefaultWidth),
    [dockRestoreWidth, setDockRestoreWidth] = useState(dockDefaultWidth);
  const handle = useRef<WorkbenchHandle>(null),
    requestedFocus = useRef<string | null>(null),
    panels = useRef<Record<string, HTMLElement | null>>({}),
    focus = useRef<Record<string, HTMLElement | null>>({});
  const openCheckouts =
    state?.recovery.openCheckoutIds
      .map((id) => state.recovery.checkouts.find((checkout) => checkout.checkoutId === id))
      .filter((checkout) => checkout !== undefined) ?? [];
  // Every checkout the editor has opened is approved, so a new local chat may start in it.
  const folderProjects = (state?.recovery.checkouts ?? []).map((checkout) => ({
    root: checkout.root,
    projectId: checkout.projectId,
    ...(checkout.vcs === 'git' ? { branch: checkout.branch, worktree: checkout.worktree } : {}),
    open: !!state?.recovery.openCheckoutIds.includes(checkout.checkoutId),
  }));
  // Closed projects, newest first: one per repository whose projects are all closed, its main
  // worktree when the editor knows it. The editor approved each, so it reopens without a picker.
  const recentCheckouts: CheckoutTarget[] = [];
  const isMain = (checkout: CheckoutTarget) =>
    checkout.vcs === 'git' && checkout.worktree === 'main';
  for (const checkout of [...(state?.recovery.checkouts ?? [])].reverse()) {
    const sameProject = (other: CheckoutTarget) =>
      other.hostId === checkout.hostId && other.projectId === checkout.projectId;
    if (openCheckouts.some(sameProject)) continue;
    const listed = recentCheckouts.findIndex(sameProject);
    if (listed < 0) recentCheckouts.push(checkout);
    else if (isMain(checkout) && !isMain(recentCheckouts[listed]))
      recentCheckouts[listed] = checkout;
  }
  const selected = openCheckouts.find(
    (checkout) => checkout.checkoutId === state?.recovery.selectedCheckoutId,
  );
  const chatTab = !!chat || !['closed', 'cleanup-blocked'].includes(lifecycle.chat.state);
  const projectValue = selected ? tabValue({ kind: 'project', checkout: selected }) : 'empty';
  const view = (destination === 'chat' || !selected) && chatTab ? 'chat' : projectValue;
  // One ChatView at a time: in the project dock while it shows, otherwise in Agents.
  const dockVisible = view !== 'chat' && !!selected && !!chat && dockOpen;
  // The title starts over the content column's left edge, wherever the rail and sidebar leave it,
  // and after the sidebar button when the sidebar is hidden.
  const title = useRef<HTMLDivElement>(null);
  // Agents puts the open chat's title and actions here, in place of a header of its own.
  const [chatTitle, setChatTitle] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const panel = view === 'chat' ? panels.current.chat : panels.current.project;
    const anchor = panel?.querySelector('[data-title-anchor]');
    if (!anchor) return;
    const observer = new ResizeObserver(() => {
      if (title.current)
        title.current.style.left = `${Math.max(titleMinLeft, Math.round(anchor.getBoundingClientRect().left))}px`;
    });
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [view, railCollapsed, sidebarHidden, selected?.checkoutId, dockVisible, chat]);
  const activePath =
    selected && state && readOwn(state.recovery.views, selected.checkoutId)?.active;
  // Where the window is, for back and forward: a chat in Agents, or a project and its file.
  const chatSelected = useSyncExternalStore(
    chat?.subscribe ?? noSubscription,
    () => chat?.getSnapshot().selected ?? null,
  );
  let place: Place | null = null;
  if (view === 'chat') place = chat ? { kind: 'chat', chat: chatSelected } : null;
  else if (selected)
    place = { kind: 'project', checkoutId: selected.checkoutId, path: activePath || null };
  const [history, setHistory] = useState(emptyHistory);
  // The step back or forward on its way: until it is done, what shows isn't a visit of its own.
  const stepping = useRef<{ place: Place; from: number; to: number; reached: boolean } | null>(
    null,
  );
  const stepCount = useRef(0);
  const placeNow = useRef(place);
  placeNow.current = place;
  const placeKey = place && JSON.stringify(place);
  useEffect(() => {
    if (!place) return;
    const step = stepping.current;
    if (step) {
      if (isSamePlace(place, step.place)) step.reached = true;
      return;
    }
    // A place counts once it settles: one shown on the way, as when a project shows its last file
    // before the one asked for opens, is passed over.
    const visited = place;
    const settle = setTimeout(
      () => setHistory((history) => visitPlace(history, visited)),
      placeSettleMs,
    );
    return () => clearTimeout(settle);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- The key stands for the place.
  }, [placeKey]);
  const projectCheckouts = selected
    ? openCheckouts.filter(
        (checkout) =>
          checkout.hostId === selected.hostId && checkout.projectId === selected.projectId,
      )
    : [];
  // A chat in any of the project's worktrees, including one a chat created, belongs to its dock.
  // Only the latest listing applies, and a failed one keeps the last good roots.
  const worktreeListing = useRef(0);
  const listProjectWorktrees = (checkout: CheckoutTarget) => {
    if (!controller) return Promise.resolve();
    const listing = ++worktreeListing.current;
    return controller.listWorktrees(checkout).then(
      (result) => {
        if (listing === worktreeListing.current)
          setProjectWorktrees({
            checkoutId: checkout.checkoutId,
            roots: result.worktrees.map((worktree) => worktree.root),
          });
      },
      () => {},
    );
  };
  const dockCheckout = dockVisible ? selected : undefined;
  useEffect(() => {
    if (dockCheckout) void listProjectWorktrees(dockCheckout);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Listed again only for another checkout.
  }, [dockCheckout?.checkoutId]);
  const dockRoots = [
    ...projectCheckouts.map((checkout) => checkout.root),
    ...(projectWorktrees && projectWorktrees.checkoutId === selected?.checkoutId
      ? projectWorktrees.roots
      : []),
  ];
  // The dock leaves the explorer and a usable editor beside it.
  const dockMaxWidth = Math.max(dockMinWidth, window.innerWidth - railWidth(railCollapsed) - 560);
  const resizeDock = (width: number) =>
    setDockWidth(Math.round(Math.min(Math.max(width, dockMinWidth), dockMaxWidth)));
  const dockExpanded = dockWidth >= dockMaxWidth;
  const projectName = checkoutName(projectCheckouts.find(isMain) ?? selected ?? { root: '' });
  const report = controller?.report ?? application.reportCleanup;
  const run = (task: Promise<unknown>) => {
    void task.catch(report);
  };
  const restoreFocus = (value: string) => {
    requestedFocus.current = value;
  };
  const startNewChat = () => {
    if (!chat) return;
    setDestination('chat');
    run(chat.closeView().then(() => document.getElementById('message')?.focus()));
  };
  const showChat = () => {
    setDestination('chat');
    if (view !== 'chat') restoreFocus('chat');
  };
  // A project since closed is passed over; a chat or file that has gone drops out once tried.
  const canShow = (place: Place) =>
    place.kind === 'chat'
      ? !!chat
      : openCheckouts.some((checkout) => checkout.checkoutId === place.checkoutId);
  const showPlace = async (place: Place) => {
    if (place.kind === 'chat') {
      if (!chat) return;
      setDestination('chat');
      await (place.chat ? chat.select(place.chat) : chat.closeView());
      return;
    }
    const checkout = openCheckouts.find((open) => open.checkoutId === place.checkoutId);
    if (!checkout || !controller) return;
    setDestination('project');
    if (checkout.checkoutId !== selected?.checkoutId) await controller.selectCheckout(checkout);
    // A file closed since opens again, as a preview, as in VS Code.
    if (place.path) await controller.open({ checkout, path: place.path }, { intent: 'preview' });
  };
  const backIndex = findStep(history, -1, canShow),
    forwardIndex = findStep(history, 1, canShow);
  const goTo = (index: number | undefined) => {
    if (index === undefined) return;
    const target = history.places[index];
    const step = { place: target, from: history.index, to: index, reached: false };
    const count = ++stepCount.current;
    stepping.current = step;
    setHistory((current) => stepTo(current, index));
    // Once the step is done and has had a moment to show, the history follows what is showing.
    void Promise.race([
      showPlace(target).catch(report),
      new Promise((resolve) => setTimeout(resolve, stepTimeoutMs)),
    ])
      .then(() => new Promise((resolve) => setTimeout(resolve, placeSettleMs)))
      .then(() => {
        if (count !== stepCount.current) return;
        stepping.current = null;
        const showing = placeNow.current;
        if (showing && isSamePlace(showing, target)) step.reached = true;
        setHistory((current) => settleStep(current, step, showing));
      });
  };
  navigation.current = (direction) => goTo(direction < 0 ? backIndex : forwardIndex);
  // The picker's chats, projects and app commands, read only while it is open; the workbench
  // adds files and editor commands.
  const pickerEntries = (): PickerEntry[] => [
    ...(chat?.getSnapshot().chats ?? []).map((summary, index) => ({
      id: summary.target.conversationId,
      kind: 'chat' as const,
      label: summary.title,
      detail: `${getChatPlace(summary)} · ${formatChatAge(summary.activity?.at ?? summary.createdAt)}`,
      recent: index < 3,
      run: () => {
        if (!chat) return;
        run(chat.select(summary.target));
        showChat();
      },
    })),
    ...openCheckouts.map((checkout) => ({
      id: checkout.checkoutId,
      kind: 'project' as const,
      label: checkoutName(checkout),
      detail: checkout.vcs === 'git' ? '⎇ ' + checkout.branch : homePath(checkout.root),
      projectId: checkout.projectId,
      run: () => {
        if (controller) run(controller.selectCheckout(checkout));
        setDestination('project');
        restoreFocus(tabValue({ kind: 'project', checkout }));
      },
    })),
    ...(chat
      ? [
          {
            id: 'new-chat',
            kind: 'command' as const,
            label: 'New chat',
            shortcut: '⌘N',
            run: startNewChat,
          },
        ]
      : []),
    ...(view !== 'chat' && chat && selected
      ? [
          {
            id: 'toggle-dock',
            kind: 'command' as const,
            label: dockOpen ? 'Hide project chats' : 'Show project chats',
            shortcut: '⌘J',
            run: () => showDock(!dockOpen),
          },
        ]
      : []),
    ...(view !== 'chat' && chatTab
      ? [{ id: 'show-agents', kind: 'command' as const, label: 'Go to Agents', run: showChat }]
      : []),
    ...(selectCheckout && controller
      ? [
          {
            id: 'open-project',
            kind: 'command' as const,
            label: 'Open project…',
            run: () => run(openCheckout()),
          },
        ]
      : []),
  ];
  /**
   * Focuses a view where it was last focused, else its editor or first control, skipping anything
   * in `leaving`: a part about to hide, which would drop focus to the page.
   */
  const focusView = (value: string, leaving?: Element | null) => {
    const panel = panels.current[value === 'chat' ? 'chat' : 'project'];
    const usable = (element: HTMLElement | null | undefined): element is HTMLElement =>
      !!element?.isConnected && !!panel?.contains(element) && !leaving?.contains(element);
    const candidates = [
      focus.current[value],
      ...(panel?.querySelectorAll<HTMLElement>('.monaco-editor textarea[role="textbox"]') ?? []),
      ...(panel?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') ?? []),
    ];
    for (const target of candidates) {
      if (!usable(target)) continue;
      target.focus();
      // An inert or hidden candidate refuses focus; try the next.
      if (document.activeElement === target) return;
    }
  };
  useLayoutEffect(() => {
    const value = requestedFocus.current;
    requestedFocus.current = null;
    if (value === view) focusView(value);
  });
  // Hiding project chats while focus is in them hands it back to the project, not the page.
  const dock = useRef<HTMLElement>(null),
    projectFocus = useRef<HTMLElement | null>(null);
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
  // Chat stays attached while it exists, behind a project or a hidden window too, so coming back
  // shows the transcript as it was, still following a running reply. Disposal detaches it.
  useEffect(() => {
    if (chat) void chat.start().catch(report);
  }, [chat, report]);
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
  const shellInert =
    closing || ['prepared', 'disposing', 'disposed', 'failed'].includes(lifecycle.phase);
  /** The window's keys, from inside the shell or, through the listener below, the page itself. */
  const keyDown = (event: ReactKeyboardEvent | KeyboardEvent) => {
    if (event.metaKey && !event.altKey && !event.shiftKey && event.key === ',') {
      event.preventDefault();
      setSettings((open) => open ?? 'hosts');
      return;
    }
    if (
      chat &&
      event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === 'n' &&
      !(event.target as HTMLElement).closest('[role="dialog"], [role="alertdialog"]')
    ) {
      event.preventDefault();
      startNewChat();
      return;
    }
    // ⌘ on a Mac, where Control+P is "previous line" in text fields; Ctrl elsewhere.
    const mode = pickerMode(event, pickerCommand(event));
    if (
      controller &&
      mode &&
      !(event.target as HTMLElement).closest(
        '[role="dialog"]:not([data-picker]), [role="alertdialog"], [role="menu"]',
      )
    ) {
      event.preventDefault();
      handle.current?.openPicker(mode);
      return;
    }
    if (
      view !== 'chat' &&
      chat &&
      event.metaKey &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 'j'
    ) {
      event.preventDefault();
      showDock(!dockOpen);
      return;
    }
    if (view !== 'chat' && !event.defaultPrevented)
      handle.current?.keyDown(event as ReactKeyboardEvent);
  };
  const keyUp = (event: ReactKeyboardEvent | KeyboardEvent) => {
    if (view !== 'chat' && !event.defaultPrevented)
      handle.current?.keyUp(event as ReactKeyboardEvent);
  };
  shellKeys.current = {
    down: (event) => !shellInert && keyDown(event),
    up: (event) => !shellInert && keyUp(event),
  };
  let status = view === 'chat' ? 'Agents · Explicit Send' : 'Explicit Save · Local workspace';
  if (closing || lifecycle.phase === 'prepared') status = 'Closing workbench…';
  else if (state?.publication) status = 'Recovery confirmation pending';
  let chatHeading = 'Chat is unavailable';
  if (lifecycle.chat.state === 'initialization-failed') chatHeading = 'Chat could not initialize';
  else if (lifecycle.chat.state === 'cleanup-blocked') chatHeading = 'Chat cleanup is blocked';
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
          if (checkout && controller) {
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
      onFocusCapture={(event) => {
        pageKeysOwner = event.currentTarget;
      }}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        // The files tree takes a drop on it, importing into the folder dropped on.
        if (isFileDropTaken(event.nativeEvent) || !event.dataTransfer.files.length) return;
        event.preventDefault();
        if (application.getSnapshot().phase !== 'live' || view === 'chat' || !selectDroppedImports)
          return;
        if (!selected) {
          report(Error('Open a checkout before importing files.'));
          return;
        }
        run(importFiles(selected, selectDroppedImports(selected, [...event.dataTransfer.files])));
      }}>
      <header aria-label="Window title bar" {...stylex.props(styles.titleBar)}>
        <div {...stylex.props(styles.barStart, mac && styles.barStartMac)}>
          <Button
            aria-label="Back"
            title={`Back · ${backShortcut}`}
            disabled={backIndex === undefined}
            onClick={() => goTo(backIndex)}
            {...stylex.props(controls.button, styles.barStartButton)}>
            <Icon name="goBack" />
          </Button>
          <Button
            aria-label="Forward"
            title={`Forward · ${forwardShortcut}`}
            disabled={forwardIndex === undefined}
            onClick={() => goTo(forwardIndex)}
            {...stylex.props(controls.button, styles.barStartButton)}>
            <Icon name="goForward" />
          </Button>
          <Button
            aria-label={sidebarHidden ? 'Show sidebar' : 'Hide sidebar'}
            title={`${sidebarHidden ? 'Show' : 'Hide'} sidebar · ${sidebarShortcut}`}
            onClick={toggleSidebar}
            {...stylex.props(controls.button, styles.barStartButton)}>
            <Icon name="sidebar" />
          </Button>
        </div>
        <div
          ref={title}
          {...stylex.props(styles.title, view === 'chat' && chat && styles.titleBesideNew)}>
          <span aria-hidden="true" {...stylex.props(styles.titleDivider)} />
          {view === 'chat' && chat && (
            <div ref={setChatTitle} {...stylex.props(styles.titleSlot)} />
          )}
          {view === 'chat' && !chat && <span {...stylex.props(styles.titleCurrent)}>Agents</span>}
          {view !== 'chat' && selected && (
            <>
              <span aria-hidden="true" {...stylex.props(styles.titleIcon)}>
                <Icon name="folder" />
              </span>
              <span>{checkoutName(selected)}</span>
              {activePath &&
                activePath.split('/').map((part, index, parts) => (
                  <Fragment key={index}>
                    <span aria-hidden="true" {...stylex.props(styles.titleSeparator)}>
                      /
                    </span>
                    <span {...stylex.props(index === parts.length - 1 && styles.titleCurrent)}>
                      {part}
                    </span>
                  </Fragment>
                ))}
            </>
          )}
        </div>
        <div {...stylex.props(styles.barActions)}>
          {view !== 'chat' && chat && selected && (
            <Button
              aria-label="Toggle project chats"
              title={`${dockOpen ? 'Hide' : 'Show'} project chats · ⌘J`}
              aria-pressed={dockOpen}
              onClick={() => showDock(!dockOpen)}
              {...stylex.props(controls.button, styles.barButton, dockOpen && styles.barButtonOn)}>
              <Icon name="sidebarRight" />
            </Button>
          )}
          {chat && (
            <Button
              aria-label="Start a new chat"
              title="New chat · ⌘N"
              onClick={startNewChat}
              {...stylex.props(controls.button, styles.barButton)}>
              <Icon name="plus" />
            </Button>
          )}
        </div>
      </header>
      <MainTabs
        checkouts={openCheckouts}
        selectedCheckoutId={state?.recovery.selectedCheckoutId}
        value={view}
        chatVisible={chatTab}
        chatOpen={!!chat}
        disabled={lifecycle.phase !== 'live'}
        preserving={!!state?.preserving}
        openCheckout={selectCheckout && controller ? () => run(openCheckout()) : undefined}
        recentCheckouts={recentCheckouts}
        reopenCheckout={
          controller
            ? (checkout) => {
                setDestination('project');
                run(controller.openCheckout(checkout.root));
              }
            : undefined
        }
        openSettings={() => setSettings('hosts')}
        collapsed={railCollapsed}
        toggleCollapsed={toggleRailKeepingFocus}
        focusView={() => focusView(view)}
        mac={mac}
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
          <p>
            Files show as unavailable with Retry until the daemon returns. Open Chat panel to retry
            before closing this workbench.
          </p>
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
              controller={controller}
              checkout={selected}
              showBreadcrumbs={false}
              sidebarHidden={sidebarHidden}
              onShowSidebar={() => setSidebarHidden(false)}
              shortcuts={windowShortcuts}
              visible={view !== 'chat'}
              pickerEntries={pickerEntries}
              copyPaths={copyPaths}
              revealPath={revealPath}
              mentionInChat={
                chat
                  ? (checkout, paths) => {
                      setDockOpen(true);
                      setChatMention((current) => ({
                        id: (current?.id ?? 0) + 1,
                        files: paths.map((path) => `${checkout.root}/${path}`),
                      }));
                    }
                  : undefined
              }
              onShowEditor={() => {
                if (view !== 'chat') return;
                setDestination('project');
                restoreFocus(projectValue);
              }}
              trailing={
                chat && selected ? (
                  <aside
                    ref={dock}
                    aria-label="Project chats"
                    inert={!dockVisible}
                    {...stylex.props(
                      styles.dock,
                      dockVisible
                        ? styles.dockWidth(Math.min(dockWidth, dockMaxWidth))
                        : styles.dockClosed,
                      resizingDock && styles.dockStill,
                    )}>
                    {dockVisible && (
                      <div
                        role="separator"
                        tabIndex={0}
                        aria-label="Resize project chats"
                        aria-orientation="vertical"
                        aria-valuemin={dockMinWidth}
                        aria-valuemax={dockMaxWidth}
                        aria-valuenow={Math.min(dockWidth, dockMaxWidth)}
                        {...stylex.props(styles.dockResize)}
                        onKeyDown={(event) => {
                          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
                            return;
                          event.preventDefault();
                          event.stopPropagation();
                          // The edge is on the dock's left, so ArrowLeft widens it.
                          let width = dockWidth + (event.key === 'ArrowLeft' ? 20 : -20);
                          if (event.key === 'Home') width = dockMinWidth;
                          else if (event.key === 'End') width = dockMaxWidth;
                          resizeDock(width);
                        }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setResizingDock(true);
                        }}
                        onLostPointerCapture={() => setResizingDock(false)}
                        onPointerMove={(event) => {
                          if (event.currentTarget.hasPointerCapture(event.pointerId))
                            resizeDock(
                              event.currentTarget.parentElement!.getBoundingClientRect().right -
                                event.clientX,
                            );
                        }}
                        onPointerUp={(event) => {
                          if (event.currentTarget.hasPointerCapture(event.pointerId))
                            event.currentTarget.releasePointerCapture(event.pointerId);
                        }}
                      />
                    )}
                    {dockVisible ? (
                      <ChatView
                        key={`${lifecycle.chatTargetId}:${selected.checkoutId}`}
                        controller={chat}
                        chooseFolder={chooseChatFolder}
                        recentFolders={
                          recentChatFolders &&
                          (() => recentChatFolders(lifecycle.chatTargetId ?? 'local'))
                        }
                        folderProjects={folderProjects}
                        createWorktree={
                          createChatWorktree &&
                          (async (root, branch, requestId) => {
                            const created = await createChatWorktree(root, branch, requestId);
                            await listProjectWorktrees(selected);
                            // Kept even if listing failed, so the new chat stays in this dock.
                            setProjectWorktrees((listed) => {
                              const roots =
                                listed?.checkoutId === selected.checkoutId ? listed.roots : [];
                              return roots.includes(created)
                                ? listed
                                : { checkoutId: selected.checkoutId, roots: [...roots, created] };
                            });
                            return created;
                          })
                        }
                        transcriptNative={transcriptNative?.(lifecycle.chatTargetId ?? 'remote')}
                        dock={{
                          project: projectName,
                          roots: dockRoots,
                          cwd: selected.root,
                          expanded: dockExpanded,
                          toggleExpanded: () => {
                            if (dockExpanded) setDockWidth(dockRestoreWidth);
                            else {
                              setDockRestoreWidth(dockWidth);
                              setDockWidth(dockMaxWidth);
                            }
                          },
                          collapse: () => showDock(false),
                          mention: chatMention,
                          mentionHandled: (id) =>
                            setChatMention((current) => (current?.id === id ? null : current)),
                        }}
                      />
                    ) : null}
                  </aside>
                ) : undefined
              }
              selectClipboardImports={
                selectClipboardImports &&
                ((checkout) =>
                  application.getSnapshot().phase === 'live'
                    ? selectClipboardImports(checkout)
                    : Promise.resolve([]))
              }
              selectDroppedImports={
                selectDroppedImports &&
                ((checkout, files) =>
                  application.getSnapshot().phase === 'live'
                    ? selectDroppedImports(checkout, files)
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
          if (event.currentTarget.contains(event.target)) focus.current.chat = event.target;
        }}
        {...stylex.props(styles.panel, styles.framed, railCollapsed && styles.framedFlush)}>
        {chat ? (
          !dockVisible && (
            <ChatView
              key={lifecycle.chatTargetId}
              controller={chat}
              titleBar={chatTitle}
              sidebarHidden={sidebarHidden}
              chooseFolder={chooseChatFolder}
              recentFolders={
                recentChatFolders && (() => recentChatFolders(lifecycle.chatTargetId ?? 'local'))
              }
              folderProjects={folderProjects}
              createWorktree={createChatWorktree}
              turnIntoProject={
                turnChatIntoProject && controller
                  ? async (conversationId) => {
                      const root = await turnChatIntoProject(conversationId);
                      // The new project joins the rail; the chat stays open here.
                      if (application.getSnapshot().phase === 'live')
                        await controller.openCheckout(root);
                    }
                  : undefined
              }
              transcriptNative={transcriptNative?.(lifecycle.chatTargetId ?? 'remote')}
              hosts={
                lifecycle.chatTargets.length
                  ? {
                      targets: lifecycle.chatTargets,
                      current: lifecycle.chatTargetId,
                      select: (id) => run(application.selectChatTarget(id)),
                      disabled: lifecycle.phase !== 'live' || lifecycle.chat.state === 'opening',
                    }
                  : undefined
              }
              setUpProviders={chat.providers ? () => setSettings('providers') : undefined}
              visible={view === 'chat'}
            />
          )
        ) : (
          <section {...stylex.props(styles.empty)} aria-label="Chat configuration">
            <h1>{chatHeading}</h1>
            <p role="status">{lifecycle.chat.error ?? 'Chat is unavailable.'}</p>
            <p>
              Files need the same daemon, so they show as unavailable with Retry until it returns.
              Open Chat panel to retry initialization, or choose another host in Settings.
            </p>
            {lifecycle.chatTargets.length > 1 && (
              <Button {...stylex.props(controls.button)} onClick={() => setSettings('hosts')}>
                Choose a host
              </Button>
            )}
          </section>
        )}
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
