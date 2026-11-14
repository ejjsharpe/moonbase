import { useStoredToggle } from '../hooks/use-stored-toggle.ts';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '@base-ui/react/dialog';
import { Button } from '@base-ui/react/button';
import { motion, useReducedMotion } from 'motion/react';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { spinner } from '@moonbase/ui/spinner';
import { workbench } from '@moonbase/ui/workbench';
import { colors, layout, radius, shadow, space, syntax, type } from '@moonbase/ui/tokens.stylex';
import type { ChatModelPreference } from '@moonbase/contracts/chat';
import {
  groupChatsByActivity,
  type ActiveChat,
  type ChatActivityReason,
  type ChatController,
} from '@moonbase/application/chat';
import { formatChatAge } from './age.ts';
import { activateChatFind, FindBar, handleChatFindKeyDown } from './find.tsx';
import { Transcript } from './transcript/transcript.tsx';
import type { TranscriptNative } from '../../ipc/chat-wire.ts';
import { Choice } from './choice.tsx';
import { ModelPicker } from './model-picker.tsx';
import { FolderPicker, type ChatFolderProject } from './folder-picker.tsx';
import { appendMentions } from './composer/mention-text.ts';
import { getChatComposer, type ChatComposerPlace } from './composer/composer.ts';
import { Icon } from '@moonbase/ui/icons';
import { MessageInput } from './composer/message-input.tsx';
import {
  listChatCommands,
  removeCommandLine,
  resolveCommandLine,
  type ChatCommand,
  type ChatCommandOption,
} from './composer/commands.ts';
import { getChatPlace } from './folder.ts';
import { folderName } from '../folder-menu.tsx';
import { projectInitials, projectTiles } from '@moonbase/ui/projects';
const compactLayout = window.matchMedia('(max-width: 640px)');
const subscribeLayout = (listener: () => void) => {
  compactLayout.addEventListener('change', listener);
  return () => compactLayout.removeEventListener('change', listener);
};
export type ChatDock = {
  /** The project's name, for the dock's headings. */
  project: string;
  /** A chat belongs to the project when its working folder is one of these roots or inside one. */
  roots: readonly string[];
  /** The working folder a chat started from the dock uses. */
  cwd: string;
  /** Whether the dock fills most of the project view. */
  expanded: boolean;
  /** Files to mention in the dock's chat, sent from the file tree as absolute paths. */
  mention?: { id: number; files: readonly string[] } | null;
  mentionHandled?(id: number): void;
  toggleExpanded(): void;
  collapse(): void;
};

const glyphs: Record<ChatActivityReason, string> = {
  unconfirmed: '?',
  failed: '✕',
  stopped: '■',
  finished: '●',
  running: '',
  idle: '',
  settled: '',
};
const reasonLabels: Record<ChatActivityReason, string> = {
  unconfirmed: 'send unconfirmed',
  failed: 'failed',
  stopped: 'stopped',
  finished: 'finished',
  running: 'running',
  idle: '',
  settled: '',
};

type ChatState = ReturnType<ChatController['getSnapshot']>;
/** The selected chat's summary, once its snapshot or list entry has loaded. */
function findSelectedChat(state: ChatState) {
  return (
    state.snapshot?.conversation ??
    state.chats.find((c) => c.target.conversationId === state.selected?.conversationId)
  );
}
/**
 * The folder the dock's chat works in: the selected chat's, or a new chat's (`newChatFolder`).
 * Null while it isn't known, so nothing is mentioned against a guess.
 */
function chatFolder(state: ChatState, newChatFolder: string) {
  if (state.selected) return findSelectedChat(state)?.cwd || null;
  return newChatFolder || null;
}

export type ChatHosts = {
  targets: readonly { id: string; label: string }[];
  current: string | null;
  select(id: string): void;
  disabled?: boolean;
};

/** The consumer owns the clients/runtime and controller lifetime; this view installs no capabilities. */
export function ChatView({
  controller,
  chooseFolder,
  recentFolders,
  folderProjects = [],
  createWorktree,
  turnIntoProject,
  transcriptNative,
  dock,
  hosts,
  setUpProviders,
  visible = true,
  sidebarHidden = false,
  titleBar,
}: {
  controller: ChatController;
  chooseFolder?: () => Promise<string | null>;
  /** Folders the native picker approved before, offered again without it. */
  recentFolders?: () => Promise<readonly string[]>;
  /** The editor's checkouts, which local chat may use without the picker. */
  folderProjects?: readonly ChatFolderProject[];
  /** Creates a linked worktree of a local folder, named for the branch, and returns its root. */
  createWorktree?: (root: string, branch: string, requestId: string) => Promise<string>;
  /** Opens a local chat without a project's folder as a project where it is. */
  turnIntoProject?: (conversationId: string) => Promise<void>;
  transcriptNative?: TranscriptNative;
  /** Shows only one project's chats, beside its editor, with a back arrow to their list. */
  dock?: ChatDock;
  /** Where a new chat can run; choosing one switches this view to that host's chats. */
  hosts?: ChatHosts;
  /** Opens provider setup, offered from the model menu. */
  setUpProviders?: () => void;
  /** Whether this view is on screen, so the open chat counts as looked at. */
  visible?: boolean;
  /** Hides the chat list, leaving the chat the full width. */
  sidebarHidden?: boolean;
  /**
   * The window title bar's slot for the open chat's title and actions. Given one, the view has no
   * header of its own; it is null until the slot mounts.
   */
  titleBar?: HTMLElement | null;
}) {
  const compact = useSyncExternalStore(subscribeLayout, () => compactLayout.matches);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const titleId = useId();
  const [settledOpen, toggleSettled] = useStoredToggle('moonbase.chats.settled');

  const findInput = useRef<HTMLInputElement>(null);
  const [dockList, setDockList] = useState(false),
    // An error belongs to the command line it was about; editing it or changing chat hides it.
    [commandError, setCommandError] = useState<{ text: string; message: string } | null>(null),
    [turning, setTurning] = useState(false),
    // Why a chat could not become a project, in the chat it was for.
    [turnError, setTurnError] = useState<{ chat: string; message: string } | null>(null),
    // Why files from the file tree weren't mentioned, in the chat (or new chat, '') they were for.
    [mentionError, setMentionError] = useState<{ chat: string; message: string } | null>(null);
  // A new chat's folder choices outlive this view, which unmounts while another view shows the chat.
  const composer = getChatComposer(controller),
    composerState = useSyncExternalStore(composer.subscribe, composer.getSnapshot);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  // A remote host's chats use its folders, never this Mac's: no picker, editor projects,
  // worktrees or dock folder apply to them.
  const remote = state.remote;
  const placeKey = dock ? `dock:${dock.cwd}` : 'agents',
    initialCwd = (!remote && dock?.cwd) || '';
  const { cwd, newWorktree, folderError } = composer.readPlace(placeKey, initialCwd),
    creatingWorktree = composerState.creatingWorktree;
  const updatePlace = (change: Partial<ChatComposerPlace>) =>
    composer.updatePlace(placeKey, initialCwd, change);
  const setFolderError = (folderError: string | null) => updatePlace({ folderError });
  const setCwd = (folder: string) => updatePlace({ cwd: folder, newWorktree: false });
  const providerState = useSyncExternalStore(
    controller.providers?.subscribe ?? noSubscription,
    controller.providers?.getSnapshot ?? noProviders,
  );
  const models =
    providerState?.status?.providers
      .filter((provider) => provider.configured)
      .flatMap((provider) =>
        provider.models.map((model) => ({
          value: JSON.stringify({ provider: provider.id, modelId: model.modelId }),
          label: `${model.name} · ${provider.name}`,
          model: { provider: provider.id, modelId: model.modelId },
          reasoningEfforts: model.reasoningEfforts,
          defaultReasoningEffort: model.defaultReasoningEffort,
        })),
      ) ?? [];
  const preference =
    state.modelPreference ??
    providerState?.status?.providers.find(
      (provider) => provider.configured && provider.defaultModel,
    )?.defaultModel;
  const selectedEntry =
    preference &&
    models.find(
      (entry) =>
        entry.model.provider === preference.model.provider &&
        entry.model.modelId === preference.model.modelId,
    );
  const selectedModel = selectedEntry?.value ?? '';
  const selectedEffort = preference?.reasoningEffort ?? selectedEntry?.defaultReasoningEffort;
  const effortUnavailable =
    !!selectedEffort &&
    !!selectedEntry?.reasoningEfforts &&
    !selectedEntry.reasoningEfforts.includes(selectedEffort);
  const selection: ChatModelPreference | undefined =
    selectedEntry && !effortUnavailable
      ? {
          model: selectedEntry.model,
          ...(selectedEffort ? { reasoningEffort: selectedEffort } : {}),
        }
      : undefined;
  let contextLabel = 'Each conversation retains its working folder and model.';
  if (state.snapshot)
    contextLabel = `${state.snapshot.conversation.cwd} · ${state.snapshot.conversation.model}`;
  let conversationTitle = 'New chat';
  if (state.selected) conversationTitle = 'Saved chat selected';
  if (state.snapshot) conversationTitle = state.snapshot.conversation.title;
  const tools = remote ? 'Tools on the host' : 'Local tools';
  let toolNotice =
    state.selected || cwd
      ? `${tools} can access files outside the working folder.`
      : `Runs in a new empty folder. ${tools} are not sandboxed.`;
  if (!state.selected && !models.length)
    toolNotice = `Set up a provider to send. ${tools} are not sandboxed.`;
  const selectedChat = findSelectedChat(state);
  // A chat without a project has no project crumb.
  const selectedFolder =
    selectedChat && !selectedChat.ownFolder ? folderName(selectedChat.cwd) : undefined;
  const connected = state.ready,
    busy = (id: string) => state.active.includes(id);
  // Whether the open chat is settled, or null while it can't be settled or unsettled.
  const openSettled =
    state.selected && selectedChat && connected && !busy('settle')
      ? selectedChat.settledAt !== undefined
      : null;
  const settleOpen = (settled: boolean) => {
    if (state.selected) void controller.settle(state.selected, settled);
  };
  const settleButton = state.selected && selectedChat && (
    <Button
      aria-label={selectedChat.settledAt ? 'Unsettle chat' : 'Settle chat'}
      title={selectedChat.settledAt ? 'Unsettle chat' : 'Settle chat'}
      {...stylex.props(controls.button, controls.iconButton)}
      disabled={openSettled === null}
      onClick={() => settleOpen(!selectedChat.settledAt)}>
      <Icon name={selectedChat.settledAt ? 'unsettle' : 'settle'} />
    </Button>
  );
  // A chat without a project can become one: its folder opens as a project where it is.
  // A remote host's own folders never open here as a project, nor in this Mac's folder picker.
  const turnable = remote ? undefined : turnIntoProject,
    browseFolder = remote ? undefined : chooseFolder;
  const turnButton = turnable && state.selected && selectedChat?.ownFolder && (
    <Button
      aria-label="Turn into project"
      title="Turn into project · opens this chat’s folder as a project"
      {...stylex.props(controls.button, controls.iconButton)}
      disabled={turning || !connected}
      onClick={() => {
        const id = state.selected!.conversationId;
        setTurning(true);
        setTurnError(null);
        void turnable(id)
          .then(
            () => controller.reloadChats(),
            (error: unknown) =>
              setTurnError({
                chat: id,
                message:
                  `The chat could not become a project. ${error instanceof Error ? error.message : ''}`.trim(),
              }),
          )
          .finally(() => setTurning(false));
      }}>
      <Icon name="newFolder" />
    </Button>
  );
  const hostDot = (
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.localDot,
        remote && !connected && styles.offlineDot,
        remote && state.connection?.state === 'connecting' && styles.pendingDot,
      )}
    />
  );
  const snapshot = state.snapshot,
    run = snapshot?.run;
  const chooseModel = (value: string) => {
    const entry = models.find((model) => model.value === value);
    if (entry)
      controller.setModelPreference({
        model: entry.model,
        ...(entry.defaultReasoningEffort ? { reasoningEffort: entry.defaultReasoningEffort } : {}),
      });
  };
  const chooseEffort = (value: string) => {
    const effort = selectedEntry?.reasoningEfforts?.find((effort) => effort === value);
    if (selectedEntry && effort)
      controller.setModelPreference({ model: selectedEntry.model, reasoningEffort: effort });
  };
  // The open chat counts as looked at while it is on screen, up to its latest listed activity.
  const openListing = state.chats.find(
    (c) => c.target.conversationId === state.selected?.conversationId,
  );
  const openSeenAt = openListing && (openListing.activity?.at ?? openListing.createdAt);
  useEffect(() => {
    if (!visible || !openListing || !openSeenAt || document.visibilityState !== 'visible') return;
    controller.markSeen(openListing.target.conversationId, openSeenAt);
  }, [controller, visible, openListing, openSeenAt]);
  // The list follows the host's chat list watch. Becoming visible watches it again if that watch
  // stopped, and lists again once it delivers.
  useEffect(() => {
    if (!connected) return;
    const resume = () => {
      if (document.visibilityState === 'visible') void controller.watchChats();
    };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [controller, connected]);
  // Files sent from the file tree join the draft as mentions relative to the chat's folder.
  const mentionRequest = dock?.mention;
  const mentionHandled = dock?.mentionHandled;
  useEffect(() => {
    if (!mentionRequest) return;
    mentionHandled?.(mentionRequest.id);
    const current = controller.getSnapshot();
    const newLocal = !current.selected;
    // The draft being sent in a new worktree keeps the mentions it has.
    const making = newLocal && composer.getSnapshot().creatingWorktree;
    const folder = making ? null : chatFolder(current, cwd);
    // A path the new chat draft already mentions in another folder would name two files at once.
    const prefix = (folder ?? '').replace(/\/+$/, '') + '/';
    const clashes = new Map<string, string>();
    if (newLocal && folder)
      for (const file of mentionRequest.files) {
        const clash = file.startsWith(prefix)
          ? composer.findMentionClash(file.slice(prefix.length), folder)
          : null;
        if (clash) clashes.set(file, clash);
      }
    const files = mentionRequest.files.filter((file) => !clashes.has(file));
    const next = folder ? appendMentions(current.draft, current.mentions, files, folder) : null;
    if (next && next.text !== current.draft) {
      controller.setDraft(next.text, next.mentions);
      if (newLocal && controller.getSnapshot().draft === next.text)
        composer.noteMentions(
          next.mentions.slice(current.mentions.length).map((mention) => mention.path),
          folder!,
        );
    }
    const count = mentionRequest.files.length;
    let error: string | null = null;
    if (making) error = 'A worktree is being made for this chat, so the files weren’t mentioned.';
    else if (!next)
      error = newLocal
        ? "Choose this chat's working folder first, so the files can be mentioned in it."
        : "This chat's working folder isn't known yet, so the files weren't mentioned.";
    else {
      const skipped: string[] = [];
      if (clashes.size)
        skipped.push(
          clashes.size === 1
            ? [...clashes.values()][0]!
            : `${clashes.size} of the files have paths the draft already mentions in another folder, so they weren't mentioned.`,
        );
      if (next.outside)
        skipped.push(
          next.outside === count
            ? "Those files are outside this chat's working folder, so they weren't mentioned."
            : `${next.outside} of the files are outside this chat's working folder and weren't mentioned.`,
        );
      // A mention can't hold every path a file can have; the controller would refuse the draft.
      if (next.unmentionable) {
        let paths = `${next.unmentionable} of the files' paths`;
        if (next.unmentionable === count)
          paths = count === 1 ? "That file's path" : "Those files' paths";
        skipped.push(
          `${paths} can't be mentioned: a mention can't hold quotes, backslashes or control characters, or exceed 1,024 bytes.`,
        );
      }
      if (skipped.length) error = skipped.join(' ');
    }
    const chat = current.selected?.conversationId ?? '';
    requestAnimationFrame(() => {
      setMentionError(error ? { chat, message: error } : null);
      const input = document.getElementById('message');
      if (!(input instanceof HTMLTextAreaElement)) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }, [controller, composer, mentionRequest, mentionHandled, cwd]);
  const focusMessage = () => document.getElementById('message')?.focus();
  const startNewChat = () => void controller.closeView().then(focusMessage);
  const choosing = !state.selected && !busy('send') && !creatingWorktree;
  // A new worktree is made only when the first message is sent, so an unsent chat leaves no trace.
  // A project without Git has no worktrees to make.
  const worktreeChoice =
    !state.selected &&
    !remote &&
    !!createWorktree &&
    !!cwd &&
    !folderProjects.some((project) => project.root === cwd && project.branch === undefined);
  const commands = listChatCommands({
    selected: !!state.selected,
    running: !!run && connected && !busy('stop') && !state.storageError,
    settled: openSettled,
    models: choosing
      ? models.map((entry) => ({
          value: entry.value,
          label: entry.label,
          current: entry.value === selectedModel,
        }))
      : [],
    efforts: choosing
      ? (selectedEntry?.reasoningEfforts ?? []).map((value) => ({
          value,
          label: effortLabels[value],
          current: !effortUnavailable && value === selectedEffort,
        }))
      : [],
    // The lines after `/new` start the new chat's draft; the open chat's is left empty.
    newChat: () => {
      const rest = removeCommandLine(state.draft),
        target = state.selected?.conversationId ?? '';
      void composer
        .startNewChat(rest, state.mentions, findSelectedChat(state)?.cwd)
        .then((message) =>
          message ? setCommandError({ text: `${target}\n${rest}`, message }) : focusMessage(),
        );
    },
    stop: () => void controller.stop(),
    settle: () => settleOpen(true),
    unsettle: () => settleOpen(false),
    clearDraft: () => controller.setDraft(''),
    chooseModel,
    chooseEffort,
  });
  // A command consumes its line before it runs, so `/clear` starts from the rest; `/new` takes the
  // rest to the new chat itself.
  const runCommand = (command: ChatCommand, option?: ChatCommandOption) => {
    setCommandError(null);
    if (command.name !== 'new') controller.setDraft(removeCommandLine(state.draft), state.mentions);
    command.run(option);
  };
  const typedCommand = resolveCommandLine(state.draft, commands);
  const groups = groupChatsByActivity({
    chats: state.chats,
    seen: state.seen,
    pending: state.pending,
    dispatching: state.dispatching,
    open: state.snapshot,
  });
  const settledShown = settledOpen;
  const reducedMotion = useReducedMotion();
  const settledMotion = { duration: reducedMotion ? 0 : 0.22, ease: [0.2, 0.8, 0.2, 1] as const };
  const chatRow = ({ chat: c, reason, at }: ActiveChat) => (
    <Button
      key={c.target.conversationId}
      aria-pressed={state.selected?.conversationId === c.target.conversationId}
      {...stylex.props(
        controls.button,
        controls.listButton,
        styles.chat,
        (reason === 'idle' || reason === 'settled') && styles.restingChat,
        state.selected?.conversationId === c.target.conversationId && styles.selected,
      )}
      disabled={!connected || busy('open')}
      onClick={() => {
        void controller.select(c.target);
        setSidebarOpen(false);
      }}>
      <span
        aria-hidden="true"
        {...stylex.props(styles.glyph, glyphStyles[reason], reason === 'running' && spinner.glyph)}>
        {glyphs[reason]}
      </span>
      <span {...stylex.props(styles.chatSummary)}>
        <span {...stylex.props(controls.truncate)}>{c.title}</span>
        <span {...stylex.props(styles.chatFolder, controls.truncate)}>
          {getChatPlace(c)}
          {reasonLabels[reason] && ` · ${reasonLabels[reason]}`}
        </span>
      </span>
      <time dateTime={at} {...stylex.props(styles.chatDate)}>
        {formatChatAge(at)}
      </time>
    </Button>
  );
  let emptyList = '';
  if (connected) emptyList = 'Your conversations will appear here.';
  else if (!remote) emptyList = 'Loading chats…';
  const listElement = useRef<HTMLElement>(null),
    focusInList = useRef(false);
  // Hiding the chat list while focus is in it hands focus to the composer rather than the page.
  useLayoutEffect(() => {
    if (!sidebarHidden || compact || !focusInList.current) return;
    focusInList.current = false;
    document.getElementById('message')?.focus();
  }, [sidebarHidden, compact]);
  const sidebar = (
    <aside
      aria-label="Saved chats"
      ref={listElement}
      onFocusCapture={() => (focusInList.current = true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusInList.current = false;
      }}
      inert={!compact && sidebarHidden}
      {...stylex.props(
        styles.sidebar,
        compact && styles.drawerSidebar,
        !compact && sidebarHidden && styles.sidebarClosed,
      )}>
      <div {...stylex.props(workbench.pane, styles.listPane)}>
        <div {...stylex.props(controls.row, styles.listHeader)}>
          <h2 {...stylex.props(styles.sidebarTitle)}>Agents</h2>
          <Button
            aria-label="Refresh saved chats"
            title="Refresh saved chats"
            {...stylex.props(controls.button, controls.iconButton)}
            disabled={!connected || busy('refresh')}
            onClick={() => void controller.firstChats()}>
            <Icon name="refresh" />
          </Button>
          <Button
            aria-label="New chat"
            title="New chat · ⌘N"
            {...stylex.props(controls.button, styles.newChat)}
            onClick={() => {
              setSidebarOpen(false);
              startNewChat();
            }}>
            <Icon name="compose" />
            New <kbd {...stylex.props(styles.newKey)}>⌘N</kbd>
          </Button>
        </div>
        {remote && !connected && (
          <div {...stylex.props(controls.row, styles.offline)}>
            <span role="status" {...stylex.props(styles.offlineText)}>
              {state.connection?.state === 'connecting' ? 'Connecting…' : 'Not connected'}
            </span>
            <Button
              {...stylex.props(controls.button)}
              disabled={
                !state.connection ||
                busy('connect') ||
                ['connecting', 'disconnecting'].includes(state.connection.state)
              }
              onClick={() => void controller.connect()}>
              {busy('connect') ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        )}
        <nav
          aria-label="Conversations"
          {...stylex.props(styles.chatList, styles.fillList, !settledShown && styles.clipList)}>
          {!state.chats.length &&
            // Offline, the Connect line above says why the list is empty.
            emptyList && <p {...stylex.props(styles.small)}>{emptyList}</p>}
          {groups.ready.length > 0 && (
            <h3 {...stylex.props(styles.groupHeading)}>
              Ready <span {...stylex.props(styles.groupCount)}>{groups.ready.length}</span>
            </h3>
          )}
          {groups.ready.map(chatRow)}
          {groups.working.length > 0 && (
            <h3 {...stylex.props(styles.groupHeading)}>
              Working <span {...stylex.props(styles.groupCount)}>{groups.working.length}</span>
            </h3>
          )}
          {groups.working.map(chatRow)}
          {groups.idle.length > 0 && (
            <h3 {...stylex.props(styles.groupHeading)}>
              Idle <span {...stylex.props(styles.groupCount)}>{groups.idle.length}</span>
            </h3>
          )}
          {groups.idle.map(chatRow)}
          {state.nextChats && (
            // Older pages hold idle and settled chats alike, so this sits outside the drawer.
            <Button
              {...stylex.props(controls.button, controls.quietButton, styles.older)}
              disabled={!connected || busy('chats')}
              onClick={() => void controller.moreChats()}>
              Show older
            </Button>
          )}
          {groups.settled.length > 0 && (
            // One block, like a drawer: closed, the heading waits at the foot of the list with its
            // chats clipped below it; opening slides the whole block up, and closing slides it back.
            <motion.div
              layout={reducedMotion ? false : 'position'}
              transition={settledMotion}
              {...stylex.props(styles.settled, !settledShown && styles.settledClosed)}>
              <Button
                aria-expanded={settledShown}
                {...stylex.props(
                  controls.button,
                  styles.settledToggle,
                  (groups.ready.length > 0 ||
                    groups.working.length > 0 ||
                    groups.idle.length > 0) &&
                    styles.settledSeparated,
                )}
                onClick={toggleSettled}>
                <span
                  aria-hidden="true"
                  {...stylex.props(
                    styles.settledChevron,
                    settledShown && styles.settledChevronOpen,
                  )}>
                  <Icon name="chevronRight" />
                </span>
                Settled <span {...stylex.props(styles.groupCount)}>{groups.settled.length}</span>
              </Button>
              {!settledShown &&
                // The open chat stays in view after it settles, until another is chosen.
                groups.settled
                  .filter(
                    (row) => row.chat.target.conversationId === state.selected?.conversationId,
                  )
                  .map(chatRow)}
              <div
                inert={!settledShown}
                aria-hidden={settledShown ? undefined : true}
                {...stylex.props(styles.settledRows, !settledShown && styles.settledRowsClosed)}>
                {groups.settled.map(chatRow)}
              </div>
            </motion.div>
          )}
        </nav>
      </div>
    </aside>
  );
  const findBar = state.transcript.find.open && (
    <FindBar controller={controller} state={state.transcript.find} input={findInput} />
  );
  const body = (
    <>
      <div {...stylex.props(styles.notices)}>
        {state.notice &&
          !['Disconnected.', 'Verified host.', 'Local chat.', 'Local tools use'].some((prefix) =>
            state.notice.startsWith(prefix),
          ) && (
            <p role="status" {...stylex.props(styles.small)}>
              {state.notice}
            </p>
          )}
        {state.storageError && (
          <p role="alert" {...stylex.props(styles.warning)}>
            {state.storageError} Preserve this window and data. Sending and Quit are blocked.
          </p>
        )}
        {state.error && (
          <p role="alert" {...stylex.props(styles.warning)}>
            {state.error}
          </p>
        )}
      </div>
      {state.pending.length > 0 && (
        <section aria-label="Retained commands" {...stylex.props(styles.pending)}>
          <h3 {...stylex.props(styles.label)}>Retained command identities</h3>
          {state.pending.map((p) => {
            let identity = '';
            if (p.operation === 'sendChat') identity = ` · chat ${p.input.target.conversationId}`;
            else if (p.operation === 'stopChat')
              identity = ` · submission ${p.input.stop.submissionId} · task ${p.input.stop.taskId ?? 'queued'}`;
            return (
              <details key={p.input.requestId} {...stylex.props(styles.pendingItem)}>
                <summary {...stylex.props(controls.summary)}>
                  {p.operation} · {p.message}
                </summary>
                <p {...stylex.props(styles.identity)}>
                  {p.input.requestId}
                  {identity}
                </p>
                {p.operation === 'createChat' && (
                  <p {...stylex.props(styles.small)}>
                    {p.input.title}
                    {p.input.settings
                      ? ` · ${p.input.settings.cwd ?? 'No project'} · ${p.input.settings.model.provider}/${p.input.settings.model.modelId}${p.input.settings.reasoningEffort ? ` · ${effortLabels[p.input.settings.reasoningEffort]}` : ''}`
                      : ''}
                  </p>
                )}
                {p.operation === 'createChat' && p.firstMessage && (
                  <>
                    <p {...stylex.props(styles.small)}>
                      Retry creates the conversation and sends this original message.
                    </p>
                    <p {...stylex.props(styles.identity)}>Send · {p.firstMessage.requestId}</p>
                    <pre {...stylex.props(controls.pre, styles.pendingText)}>
                      {p.firstMessage.text}
                    </pre>
                  </>
                )}
                {p.operation === 'sendChat' && (
                  <pre {...stylex.props(controls.pre, styles.pendingText)}>{p.input.text}</pre>
                )}
                <div {...stylex.props(controls.row)}>
                  <Button
                    {...stylex.props(controls.button)}
                    disabled={!connected || busy('query:' + p.input.requestId)}
                    onClick={() => void controller.query(p.input.requestId)}>
                    Query outcome
                  </Button>
                  <Button
                    {...stylex.props(controls.button)}
                    disabled={!connected || busy(p.input.requestId) || !!state.storageError}
                    onClick={() => void controller.retry(p.input.requestId)}>
                    Retry original{' '}
                    {{ stopChat: 'Stop', sendChat: 'Send', createChat: 'Create' }[p.operation]}
                  </Button>
                </div>
              </details>
            );
          })}
        </section>
      )}
      {state.selected && (
        <Transcript
          key={controller.backendId + JSON.stringify(state.selected)}
          controller={controller}
          state={state}
          native={transcriptNative}
        />
      )}
      <div {...stylex.props(styles.composeArea, !state.selected && styles.starter)}>
        {!state.selected && (
          <h2 {...stylex.props(styles.starterHeading)}>
            {dock ? `What should we work on in ${dock.project}?` : 'What should we work on?'}
          </h2>
        )}
        {/* The new chat's folder and worktree messages belong to its composer, not an open chat. */}
        {!state.selected && composerState.notice && (
          <p role="alert" {...stylex.props(styles.warning)}>
            {composerState.notice}
          </p>
        )}
        {!state.selected && folderError && (
          <p role="alert" {...stylex.props(styles.warning)}>
            {folderError}
          </p>
        )}
        {state.selected && turnError?.chat === state.selected.conversationId && (
          <p role="alert" {...stylex.props(styles.warning)}>
            {turnError.message}
          </p>
        )}
        {mentionError?.chat === (state.selected?.conversationId ?? '') && (
          <p role="alert" {...stylex.props(styles.warning)}>
            {mentionError.message}
          </p>
        )}
        {commandError?.text === `${state.selected?.conversationId ?? ''}\n${state.draft}` && (
          <p role="alert" {...stylex.props(styles.warning)}>
            {commandError.message}
          </p>
        )}
        {!state.selected &&
          state.modelPreference &&
          providerState?.status &&
          (!selectedEntry || effortUnavailable) && (
            <p role="status" {...stylex.props(styles.warning)}>
              {!selectedEntry
                ? `Your saved model (${state.modelPreference.model.modelId}) is unavailable. Choose another model to send.`
                : 'Your saved reasoning effort is unavailable for this model. Choose another effort to send.'}
            </p>
          )}
        <form
          {...stylex.props(styles.composer, !state.selected && styles.starterComposer)}
          onSubmit={(e) => {
            e.preventDefault();
            if (typedCommand) {
              if ('error' in typedCommand)
                setCommandError({
                  text: `${state.selected?.conversationId ?? ''}\n${state.draft}`,
                  message: typedCommand.error,
                });
              else runCommand(typedCommand.command, typedCommand.option);
              return;
            }
            setCommandError(null);
            // Enter submits even while Send is disabled; one worktree per first message.
            if (creatingWorktree) return;
            setMentionError(null);
            // The new chat's messages are about its own sends, which an open chat's leave alone.
            if (!state.selected) composer.clearMessages(placeKey);
            // Without a folder, a new local chat runs in one the host makes for it.
            const settings =
              !state.selected && selection ? { ...(cwd ? { cwd } : {}), ...selection } : undefined;
            // Mentions picked in another view's folder are checked against this one before sending.
            const problem = settings && composer.checkMentions(cwd);
            if (problem) {
              setFolderError(problem);
              return;
            }
            if (worktreeChoice && newWorktree && selection) {
              composer.sendInWorktree(placeKey, initialCwd, createWorktree!, selection);
              return;
            }
            void controller.send(settings);
          }}>
          <div {...stylex.props(styles.messageRow)}>
            <span aria-hidden="true" {...stylex.props(styles.prompt)}>
              ❯
            </span>
            <MessageInput
              controller={controller}
              draft={state.draft}
              mentions={state.mentions}
              searchable={connected && (!!state.selected || (!!cwd && !creatingWorktree))}
              cwd={!state.selected && cwd ? cwd : undefined}
              onMention={
                !state.selected && cwd ? (path) => composer.noteMentions([path], cwd) : undefined
              }
              refuseMention={
                !state.selected && cwd ? (path) => composer.findMentionClash(path, cwd) : undefined
              }
              placeholder={
                state.selected
                  ? 'Message the agent…'
                  : 'Describe a task — @ to mention files, / for commands'
              }
              starter={!state.selected}
              commands={commands}
              onCommand={runCommand}
            />
          </div>
          <div {...stylex.props(controls.row, styles.composeActions)}>
            {!state.selected && (
              <div {...stylex.props(styles.composeContext)}>
                <FolderPicker
                  cwd={cwd}
                  projects={remote ? [] : folderProjects}
                  recentFolders={recentFolders}
                  hostFolders={
                    remote
                      ? {
                          label: 'On the host',
                          empty:
                            'The host offers no folders. Add approved roots to its daemon.json.',
                        }
                      : undefined
                  }
                  disabled={busy('send') || creatingWorktree}
                  noProject={
                    // A project's dock keeps its chats in the project.
                    dock
                      ? undefined
                      : () => updatePlace({ cwd: '', newWorktree: false, folderError: null })
                  }
                  choose={(folder) => {
                    setFolderError(null);
                    if (folder !== cwd) setCwd(folder);
                  }}
                  browse={
                    browseFolder &&
                    (() => {
                      setFolderError(null);
                      void browseFolder()
                        .then((folder) => {
                          if (folder) setCwd(folder);
                        })
                        .catch(() =>
                          setFolderError(
                            'The folder could not be approved. Choose an existing working folder again.',
                          ),
                        );
                    })
                  }
                />
                {worktreeChoice && (
                  <div {...stylex.props(styles.worktreeChoice)}>
                    <Choice
                      compact
                      label="Worktree"
                      value={newWorktree ? 'new' : 'folder'}
                      options={[
                        { value: 'folder', label: 'This folder' },
                        { value: 'new', label: 'New worktree' },
                      ]}
                      onChange={(value) => updatePlace({ newWorktree: value === 'new' })}
                      disabled={busy('send') || creatingWorktree}
                    />
                  </div>
                )}
                {hosts && hosts.targets.length > 1 ? (
                  <div {...stylex.props(styles.hostChoice)}>
                    <Choice
                      compact
                      label="Chat target"
                      value={hosts.current ?? ''}
                      options={hosts.targets.map(({ id, label }) => ({ value: id, label }))}
                      onChange={(id) => id !== hosts.current && hosts.select(id)}
                      disabled={hosts.disabled || busy('send') || creatingWorktree}
                      leading={hostDot}
                    />
                  </div>
                ) : (
                  <span {...stylex.props(styles.localLabel)}>
                    {hostDot}
                    {hosts?.targets.find((target) => target.id === hosts.current)?.label ??
                      (remote ? 'remote' : 'local')}
                  </span>
                )}
              </div>
            )}
            <div {...stylex.props(controls.row, styles.modelActions)}>
              {!state.selected ? (
                <>
                  <div {...stylex.props(styles.modelChoice)}>
                    <ModelPicker
                      providers={
                        providerState?.status?.providers.filter(
                          (provider) => provider.configured,
                        ) ?? []
                      }
                      model={selectedEntry?.model ?? preference?.model}
                      effort={selectedEffort}
                      effortAvailable={!effortUnavailable}
                      effortLabels={effortLabels}
                      chooseModel={(model) => chooseModel(JSON.stringify(model))}
                      chooseEffort={chooseEffort}
                      setUpProviders={setUpProviders}
                      disabled={(!models.length && !setUpProviders) || busy('send')}
                    />
                  </div>
                </>
              ) : (
                <span {...stylex.props(styles.small, controls.truncate)}>
                  {snapshot?.conversation.model}
                  {snapshot?.conversation.reasoningEffort
                    ? ` · ${effortLabels[snapshot.conversation.reasoningEffort]}`
                    : ''}
                </span>
              )}
              {run && (
                <Button
                  aria-label="Stop"
                  title="Stop"
                  {...stylex.props(controls.button, controls.iconButton)}
                  disabled={!connected || busy('stop') || !!state.storageError}
                  onClick={() => void controller.stop()}>
                  <Icon name="stop" />
                </Button>
              )}
              <Button
                type="submit"
                aria-label="Send message"
                title="Send message · Enter"
                {...stylex.props(controls.button, styles.sendButton)}
                disabled={
                  typedCommand
                    ? false
                    : !connected ||
                      !state.draft.trim() ||
                      creatingWorktree ||
                      busy('send') ||
                      busy('create') ||
                      !!state.storageError ||
                      (!state.selected && !selection) ||
                      state.pending.some(
                        (p) =>
                          (p.operation === 'sendChat' &&
                            p.input.target.conversationId === state.selected?.conversationId) ||
                          (!state.selected && p.operation === 'createChat' && !!p.firstMessage),
                      )
                }>
                <Icon name="send" />
              </Button>
            </div>
          </div>
        </form>
        <div {...stylex.props(styles.composerHelp)}>
          <span>{toolNotice}</span>
          <span
            title={`${new TextEncoder().encode(state.draft).length.toLocaleString()} / 32,768 bytes`}>
            ⇧ Enter for a new line
          </span>
        </div>
      </div>
    </>
  );
  if (dock) {
    const inProject = (folder: string) =>
      dock.roots.some(
        (root) => folder === root || folder.startsWith(root.replace(/\/$/, '') + '/'),
      );
    const projectChats = state.chats.filter((c) => inProject(c.cwd));
    const selectedCwd =
      snapshot?.conversation.cwd ??
      state.chats.find((c) => c.target.conversationId === state.selected?.conversationId)?.cwd;
    // A chat from another project is never shown here; the dock opens on this project's list.
    const listing = dockList || (!!state.selected && !!selectedCwd && !inProject(selectedCwd));
    const collapse = (
      <>
        <Button
          aria-label={dock.expanded ? 'Restore project chats width' : 'Expand project chats'}
          title={dock.expanded ? 'Restore width' : 'Expand'}
          {...stylex.props(controls.button, controls.iconButton)}
          onClick={dock.toggleExpanded}>
          <Icon name={dock.expanded ? 'restore' : 'expand'} />
        </Button>
        <Button
          aria-label="Hide project chats"
          title="Hide project chats · ⌘J"
          {...stylex.props(controls.button, controls.iconButton)}
          onClick={dock.collapse}>
          <Icon name="close" />
        </Button>
      </>
    );
    return (
      <div
        data-chat-find-owner={JSON.stringify([controller.backendId, state.selected])}
        onKeyDown={(event) => handleChatFindKeyDown(event, controller, findInput)}
        {...stylex.props(workbench.page, styles.page, styles.dockPage)}>
        {listing ? (
          <section aria-label={`${dock.project} chats`} {...stylex.props(styles.dockList)}>
            <header {...stylex.props(workbench.paneHeader, styles.dockHeader)}>
              <div
                title="This project only · every project's chats are in Agents"
                {...stylex.props(styles.dockHeading)}>
                <h2 {...stylex.props(styles.dockTitle)}>{dock.project} chats</h2>
              </div>
              <Button
                {...stylex.props(controls.button, styles.dockNew)}
                disabled={busy('send') || busy('create')}
                onClick={() => {
                  setDockList(false);
                  void controller
                    .closeView()
                    .then(() => document.getElementById('message')?.focus());
                }}>
                <Icon name="compose" /> New chat
              </Button>
              {collapse}
            </header>
            <div {...stylex.props(workbench.pane, workbench.canvasPane, styles.scrollPane)}>
              <nav aria-label={`${dock.project} conversations`} {...stylex.props(styles.chatList)}>
                {!projectChats.length ? (
                  <p {...stylex.props(styles.small, styles.dockEmpty)}>
                    {connected
                      ? `No chats in ${dock.project} yet.`
                      : 'Connect to read saved chats.'}
                  </p>
                ) : (
                  projectChats.map((c) => (
                    <Button
                      key={c.target.conversationId}
                      aria-pressed={state.selected?.conversationId === c.target.conversationId}
                      {...stylex.props(
                        controls.button,
                        controls.listButton,
                        styles.chat,
                        state.selected?.conversationId === c.target.conversationId &&
                          styles.selected,
                      )}
                      disabled={!connected || busy('open')}
                      onClick={() => {
                        setDockList(false);
                        void controller.select(c.target);
                      }}>
                      <span aria-hidden="true" {...stylex.props(styles.chatDot)} />
                      <span {...stylex.props(styles.chatSummary)}>
                        <span {...stylex.props(controls.truncate)}>{c.title}</span>
                        <span {...stylex.props(styles.chatFolder, controls.truncate)}>
                          {getChatPlace(c)}
                        </span>
                      </span>
                      <time dateTime={c.createdAt} {...stylex.props(styles.chatDate)}>
                        {new Date(c.createdAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </time>
                    </Button>
                  ))
                )}
              </nav>
            </div>
          </section>
        ) : (
          <main aria-label="Agent workspace" {...stylex.props(styles.content, styles.dockContent)}>
            <header {...stylex.props(workbench.paneHeader, styles.dockHeader)}>
              <Button
                aria-label={`All ${dock.project} chats`}
                title={`All ${dock.project} chats`}
                {...stylex.props(controls.button, controls.iconButton)}
                onClick={() => setDockList(true)}>
                <Icon name="back" />
              </Button>
              <div
                title={state.selected ? contextLabel : `In ${dock.project}`}
                {...stylex.props(styles.dockHeading)}>
                <h1 {...stylex.props(styles.dockTitle, controls.truncate)}>{conversationTitle}</h1>
              </div>
              {settleButton}
              {state.selected && (
                <Button
                  aria-label="Find"
                  title="Find · ⌘F"
                  {...stylex.props(controls.button, controls.iconButton)}
                  onClick={(event) => activateChatFind(controller, event.currentTarget, findInput)}>
                  <Icon name="search" />
                </Button>
              )}
              {collapse}
            </header>
            <div {...stylex.props(workbench.pane, workbench.canvasPane)}>
              {findBar}
              {body}
            </div>
          </main>
        )}
      </div>
    );
  }
  const inBar = titleBar !== undefined;
  const context = (
    <>
      {compact && (
        <Dialog.Root open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <Dialog.Trigger
            aria-label="Show conversations"
            {...stylex.props(controls.button, controls.iconButton)}>
            <Icon name="agents" />
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Backdrop {...stylex.props(styles.drawerBackdrop)} />
            <Dialog.Popup {...stylex.props(workbench.document, styles.drawer)}>
              <Dialog.Title {...stylex.props(controls.hidden)}>Conversations</Dialog.Title>
              <Dialog.Close
                aria-label="Close conversations"
                {...stylex.props(controls.button, controls.iconButton, styles.drawerClose)}>
                <Icon name="close" />
              </Dialog.Close>
              {sidebar}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      {/* Breadcrumb: the chat's project, then the chat. Folder and model are in its title. */}
      <div
        title={state.selected ? contextLabel : undefined}
        {...stylex.props(styles.crumbs, inBar && styles.barCrumbs)}>
        {state.selected && selectedFolder && (
          <>
            <span
              aria-hidden="true"
              data-initials={projectInitials(selectedFolder)}
              {...stylex.props(projectTiles.tile, projectTiles.silver, styles.crumbTile)}
            />
            <span {...stylex.props(styles.crumbProject, controls.truncate)}>{selectedFolder}</span>
            <span aria-hidden="true" {...stylex.props(styles.crumbSeparator)}>
              /
            </span>
          </>
        )}
        {inBar && !compact && !(state.selected && selectedFolder) && (
          <span aria-hidden="true" {...stylex.props(styles.barIcon)}>
            <Icon name="agents" />
          </span>
        )}
        <h1
          id={titleId}
          {...stylex.props(styles.title, inBar && styles.barTitle, controls.truncate)}>
          {conversationTitle}
        </h1>
      </div>
      <div {...stylex.props(controls.row, inBar && styles.barButtons)}>
        {turnButton}
        {settleButton}
        {state.selected && (
          <Button
            aria-label="Find"
            title="Find · ⌘F"
            {...stylex.props(controls.button, controls.iconButton)}
            onClick={(event) => activateChatFind(controller, event.currentTarget, findInput)}>
            <Icon name="search" />
          </Button>
        )}
        {state.selected && (
          <Button
            aria-label="Close view"
            title="Back to new chat"
            {...stylex.props(controls.button, controls.iconButton)}
            onClick={() => void controller.closeView()}>
            <Icon name="close" />
          </Button>
        )}
      </div>
    </>
  );
  return (
    <div
      data-chat-find-owner={JSON.stringify([controller.backendId, state.selected])}
      onKeyDown={(event) => handleChatFindKeyDown(event, controller, findInput)}
      {...stylex.props(workbench.page, styles.page)}>
      <div
        {...stylex.props(
          styles.workspace,
          !compact && styles.expandedWorkspace,
          !compact && sidebarHidden && styles.closedWorkspace,
        )}>
        {!compact && sidebar}
        <main
          aria-label="Agent workspace"
          // The title is in the window's title bar, outside this landmark, so it names the chat here.
          aria-describedby={inBar && titleBar ? titleId : undefined}
          data-title-anchor=""
          {...stylex.props(styles.content)}>
          {inBar ? (
            titleBar &&
            createPortal(
              // The bar belongs to this chat for Find, as its header did.
              <div
                data-chat-find-owner={JSON.stringify([controller.backendId, state.selected])}
                onKeyDown={(event) => handleChatFindKeyDown(event, controller, findInput)}
                {...stylex.props(styles.barContext)}>
                {context}
              </div>,
              titleBar,
            )
          ) : (
            <header {...stylex.props(workbench.paneHeader, styles.context)}>{context}</header>
          )}
          <div {...stylex.props(workbench.pane, workbench.canvasPane)}>
            {findBar}
            {body}
          </div>
        </main>
      </div>
    </div>
  );
}
const noSubscription = () => () => {};
const noProviders = () => null;
const effortLabels = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
const styles = stylex.create({
  dockPage: { display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'hidden' },
  dockContent: { flex: 1 },
  dockList: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' },
  dockHeader: { gap: space.sm, paddingLeft: 4, paddingRight: 2 },
  scrollPane: { overflowY: 'auto' },
  listPane: { padding: '10px 8px 16px', gap: space.sm, overflowY: 'auto' },
  // Takes the pointer from the drag region, so its hover text shows.
  dockHeading: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    WebkitAppRegion: 'no-drag',
  },
  dockTitle: { margin: 0, fontSize: type.body, fontWeight: 600 },
  dockNew: { display: 'inline-flex', alignItems: 'center', gap: space.xs, flexShrink: 0 },
  dockEmpty: { padding: space.md },
  drawerBackdrop: { position: 'fixed', inset: 0, zIndex: 50, backgroundColor: colors.backdrop },
  drawer: {
    position: 'fixed',
    top: 0,
    left: 0,
    bottom: 0,
    width: 'min(280px, calc(100% - 32px))',
    zIndex: 51,
    display: 'flex',
    flexDirection: 'column',
    outline: 'none',
  },
  drawerClose: { position: 'absolute', right: space.sm, top: space.sm, zIndex: 1 },
  drawerSidebar: { paddingTop: 48 },
  page: { fontFamily: type.ui, flex: 1, height: 'auto', minHeight: 0, overflowY: 'auto' },
  workspace: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    flex: 1,
    minHeight: 0,
  },
  expandedWorkspace: {
    gridTemplateColumns: {
      default: '288px minmax(0, 1fr)',
      '@media (max-width: 760px)': '210px minmax(0, 1fr)',
    },
    transitionProperty: 'grid-template-columns',
    transitionDuration: '160ms',
    transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  },
  // The chat list slides to nothing; the chat takes the whole width.
  closedWorkspace: {
    gridTemplateColumns: {
      default: '0px minmax(0, 1fr)',
      '@media (max-width: 760px)': '0px minmax(0, 1fr)',
    },
  },
  sidebarClosed: { borderRightWidth: 0 },
  sidebar: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.border,
    backgroundColor: colors.surface,
  },
  newChat: {
    fontSize: type.small,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    height: 28,
    padding: '0 9px',
    borderRadius: radius.row,
    backgroundColor: { default: colors.elevated, ':hover:not(:disabled)': colors.hover },
  },
  newKey: { font: 'inherit', color: colors.muted },
  sidebarTitle: { flex: 1, margin: 0, fontSize: type.heading, fontWeight: 700 },
  groupHeading: {
    margin: '12px 8px 2px',
    color: colors.muted,
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  groupCount: { color: colors.secondary },
  settledToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    padding: '7px 8px',
    borderWidth: 0,
    borderRadius: radius.row,
    backgroundColor: { default: 'transparent', ':hover:not(:disabled)': colors.hover },
    color: colors.secondary,
    fontSize: type.small,
    textAlign: 'left',
  },
  settledSeparated: {
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    borderRadius: 0,
    paddingTop: 10,
  },
  settled: { position: 'relative', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  settledClosed: { marginTop: 'auto' },
  settledRows: { display: 'flex', flexDirection: 'column', gap: 2 },
  // Closed, the chats hang below the heading, past the foot of the list, where it clips them.
  settledRowsClosed: { position: 'absolute', top: '100%', left: 0, right: 0 },
  settledChevron: { display: 'inline-flex', color: colors.muted, transition: 'transform 120ms' },
  settledChevronOpen: { transform: 'rotate(90deg)' },
  /** An idle or settled chat: nothing in it needs you. */
  restingChat: { color: colors.secondary },
  older: { alignSelf: 'flex-start', fontSize: type.small },
  glyph: {
    flexShrink: 0,
    width: 12,
    marginTop: 3,
    textAlign: 'center',
    fontSize: type.caption,
    lineHeight: 1.4,
  },
  small: {
    color: colors.secondary,
    fontSize: type.small,
    lineHeight: 1.6,
    margin: '4px 0',
    overflowWrap: 'anywhere',
  },
  label: { fontSize: type.small, fontWeight: 400, margin: 0, color: colors.muted },
  listHeader: { gap: space.xs, flexWrap: 'nowrap', paddingRight: 2 },
  chatList: { display: 'flex', flexDirection: 'column', gap: 2, minHeight: 80 },
  /** The sidebar list fills its column, so a closed Settled toggle can sit at its foot. */
  fillList: { flex: 1 },
  // `clip` keeps a long Ready or Working list scrolling with the sidebar; `hidden` would cut it short.
  clipList: { overflow: 'clip' },
  chat: {
    display: 'flex',
    alignItems: 'start',
    gap: 10,
    padding: '9px 12px',
    borderRadius: radius.row,
    color: colors.secondary,
    flexShrink: 0,
    minWidth: 0,
  },
  chatSummary: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  chatDot: {
    marginTop: 7,
    width: 5,
    height: 5,
    borderRadius: '50%',
    backgroundColor: colors.muted,
    flexShrink: 0,
  },
  chatFolder: { color: colors.muted, fontSize: type.small, fontWeight: 400 },
  selected: {
    backgroundColor: { default: colors.selected, ':hover:not(:disabled)': colors.selectedHover },
    color: colors.text,
  },
  chatDate: {
    color: colors.muted,
    fontSize: type.caption,
    marginLeft: 'auto',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  offline: { gap: space.sm, padding: '6px 8px', fontSize: type.small },
  offlineText: { flex: 1, color: colors.secondary },
  hostChoice: { flexShrink: 0, maxWidth: 200 },
  offlineDot: { backgroundColor: colors.muted },
  pendingDot: { backgroundColor: colors.warningText },
  content: {
    backgroundColor: colors.canvas,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  },
  context: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingLeft: 12,
    paddingRight: 2,
  },
  // In the window title bar: the chat's crumbs, then its actions at the bar's end.
  barContext: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    // Room for the last button's focus ring inside the title's clipped box.
    paddingRight: 4,
  },
  barButtons: { flexWrap: 'nowrap', flexShrink: 0 },
  // The title drags the window, like the file path on a project.
  barCrumbs: { WebkitAppRegion: 'drag' },
  barIcon: { display: 'flex', flexShrink: 0, color: colors.muted },
  barTitle: { color: colors.text, fontWeight: 600 },
  crumbs: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minWidth: 0,
    WebkitAppRegion: 'no-drag',
  },
  crumbTile: { width: 20, height: 20, borderRadius: 5, fontSize: 9 },
  // The project gives way before the chat's own title.
  crumbProject: { flexShrink: 4, maxWidth: 200, color: colors.secondary, fontSize: type.body },
  crumbSeparator: { color: colors.muted },
  title: {
    fontSize: type.body,
    fontWeight: 500,
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  notices: { padding: '0 24px', flexShrink: 0 },
  warning: {
    backgroundColor: colors.warningSurface,
    color: colors.warningText,
    padding: space.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.warningBorder,
    borderRadius: radius.control,
    overflowWrap: 'anywhere',
    margin: '4px 0',
  },
  pending: {
    paddingBlock: space.sm,
    paddingInline: space.xl,
    maxHeight: '30vh',
    overflowY: 'auto',
    flexShrink: 0,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
  },
  pendingItem: { marginBlock: space.sm, marginInline: 0, color: colors.warningText },
  pendingText: { maxHeight: 100, overflowY: 'auto', color: colors.text },
  identity: {
    fontFamily: type.mono,
    fontSize: type.caption,
    overflowWrap: 'anywhere',
    color: colors.secondary,
  },
  composeArea: {
    width: 'calc(100% - 48px)',
    maxWidth: layout.conversation,
    margin: '12px auto 8px',
    flexShrink: 0,
  },
  starter: { margin: 'auto', paddingBottom: 80, maxWidth: 720 },
  starterHeading: {
    margin: '0 0 16px',
    textAlign: 'center',
    color: colors.secondary,
    fontSize: type.heading,
    fontWeight: 600,
  },
  messageRow: { display: 'flex', gap: 10 },
  prompt: {
    flexShrink: 0,
    color: colors.accent,
    fontFamily: type.mono,
    fontSize: type.message,
    fontWeight: 700,
    lineHeight: 1.6,
  },
  starterComposer: { boxShadow: shadow.raised, padding: '16px 10px 10px 16px' },
  localDot: { width: 7, height: 7, borderRadius: '50%', backgroundColor: syntax.string },
  composeContext: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
    rowGap: 4,
    minWidth: 0,
    marginRight: 'auto',
  },
  localLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: 6,
    height: 30,
    padding: '0 10px',
    color: colors.secondary,
    fontSize: type.small,
  },
  composer: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    padding: space.md,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    borderRadius: radius.composer,
    ':focus-within': { borderColor: colors.muted },
  },
  composeActions: { minHeight: 32, justifyContent: 'flex-end', flexWrap: 'wrap', gap: space.sm },
  modelActions: { marginLeft: 'auto', minWidth: 0, maxWidth: '100%', flexWrap: 'nowrap' },
  modelChoice: { minWidth: 0 },
  worktreeChoice: { flexShrink: 0 },
  sendButton: {
    display: 'inline-flex',
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
    width: 32,
    height: 32,
    padding: 7,
    borderWidth: 0,
    borderRadius: radius.row,
    backgroundColor: { default: colors.accent, ':hover:not(:disabled)': colors.link },
    color: colors.onAccent,
  },
  composerHelp: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: space.sm,
    padding: '10px 8px',
    color: colors.muted,
    fontSize: type.caption,
  },
});

const glyphStyles = stylex.create({
  unconfirmed: { color: colors.warningText, fontWeight: 700 },
  failed: { color: colors.danger, fontWeight: 700 },
  stopped: { color: colors.warningText },
  finished: { color: syntax.keyword, fontSize: 9, marginTop: 4 },
  running: { color: syntax.keyword },
  idle: {},
  settled: {},
});
