import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import { workbench } from '@moonbase/ui/workbench';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import type { ChatComposer } from '@moonbase/application/chat';
import type { DesktopRunner } from '../shell/desktop-application.ts';
import { FindBar, handleChatFindKeyDown } from './find.tsx';
import { Transcript } from './transcript/transcript.tsx';
import type { TranscriptNative } from './transcript/transcript-actions.ts';
import type { ChatFolderProject } from './folder-picker.tsx';
import { ChatList } from './chat-list.tsx';
import { ProjectChatList } from './project-chat-list.tsx';
import { ChatHeader, DockChatHeader } from './chat-header.tsx';
import { PendingCommands } from './pending-commands.tsx';
import { Composer } from './composer/composer.tsx';
import { focusMessage } from './open-chat.ts';
import type { DesktopChat } from './desktop-chat.ts';

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
  toggleExpanded(): void;
  collapse(): void;
};

export type ChatHosts = {
  targets: readonly { id: string; label: string }[];
  current: string | null;
  select(id: string): void;
  disabled?: boolean;
};

/** Notices about the chat as a whole: the controller's status, storage and errors. */
const hiddenNotices = ['Disconnected.', 'Verified host.', 'Local chat.', 'Local tools use'];

/**
 * A chat target's chats: in Agents, the chat list beside the open chat; in a project's dock, that
 * project's chats or one of them. The consumer owns the controller, its composer and the runtime;
 * this view installs no capabilities.
 */
export function ChatView({
  controller,
  composer,
  runner,
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
  controller: DesktopChat;
  /** The chat's composer, made beside its controller: it outlives this view. */
  composer: ChatComposer;
  /** The renderer root's runners, which the composer's and transcript's actions run on. */
  runner: DesktopRunner;
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
  const [listOpen, setListOpen] = useState(false),
    [dockList, setDockList] = useState(false);
  const titleId = useId();
  const findInput = useRef<HTMLInputElement>(null);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const connected = state.ready;
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
  const startNewChat = () => void controller.closeView().then(focusMessage);
  // A remote host's own folders never open here as a project, nor in this Mac's folder picker.
  const remote = state.remote;
  const findOwner = JSON.stringify([controller.backendId, state.selected]);
  const onFindKeyDown = (event: KeyboardEvent<HTMLElement>) =>
    handleChatFindKeyDown(event, controller, findInput);
  const chat = (
    <div {...stylex.props(workbench.pane, workbench.canvasPane)}>
      {state.transcript.find.open && (
        <FindBar controller={controller} state={state.transcript.find} input={findInput} />
      )}
      <div {...stylex.props(styles.notices)}>
        {state.notice && !hiddenNotices.some((prefix) => state.notice.startsWith(prefix)) && (
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
      <PendingCommands controller={controller} state={state} />
      {state.selected && (
        <Transcript
          key={controller.backendId + JSON.stringify(state.selected)}
          controller={controller}
          state={state}
          native={transcriptNative}
          runner={runner}
        />
      )}
      <Composer
        controller={controller}
        composer={composer}
        runner={runner}
        state={state}
        dockProject={dock?.project}
        dockCwd={dock?.cwd}
        hosts={hosts}
        folderProjects={folderProjects}
        recentFolders={recentFolders}
        chooseFolder={chooseFolder}
        createWorktree={createWorktree}
        setUpProviders={setUpProviders}
      />
    </div>
  );
  if (dock) {
    const inProject = (folder: string) =>
      dock.roots.some(
        (root) => folder === root || folder.startsWith(root.replace(/\/$/, '') + '/'),
      );
    const selectedCwd = state.snapshot?.conversation.cwd ?? openListing?.cwd;
    // A chat from another project is never shown here; the dock opens on this project's list.
    const listing = dockList || (!!state.selected && !!selectedCwd && !inProject(selectedCwd));
    return (
      <div
        data-chat-find-owner={findOwner}
        onKeyDown={onFindKeyDown}
        {...stylex.props(workbench.page, styles.page, styles.dockPage)}>
        {listing ? (
          <ProjectChatList
            controller={controller}
            state={state}
            dock={dock}
            chats={state.chats.filter((c) => inProject(c.cwd))}
            onChoose={() => setDockList(false)}
            onNewChat={() => {
              setDockList(false);
              startNewChat();
            }}
          />
        ) : (
          <main aria-label="Agent workspace" {...stylex.props(styles.content, styles.dockContent)}>
            <DockChatHeader
              controller={controller}
              state={state}
              dock={dock}
              findInput={findInput}
              onShowList={() => setDockList(true)}
            />
            {chat}
          </main>
        )}
      </div>
    );
  }
  const inBar = titleBar !== undefined;
  const list = (
    <ChatList
      controller={controller}
      state={state}
      compact={compact}
      hidden={sidebarHidden}
      onChosen={() => setListOpen(false)}
      startNewChat={startNewChat}
    />
  );
  return (
    <div
      data-chat-find-owner={findOwner}
      onKeyDown={onFindKeyDown}
      {...stylex.props(workbench.page, styles.page)}>
      <div
        {...stylex.props(
          styles.workspace,
          !compact && styles.expandedWorkspace,
          !compact && sidebarHidden && styles.closedWorkspace,
        )}>
        {!compact && list}
        <main
          aria-label="Agent workspace"
          // The title is in the window's title bar, outside this landmark, so it names the chat here.
          aria-describedby={inBar && titleBar ? titleId : undefined}
          data-title-anchor=""
          {...stylex.props(styles.content)}>
          <ChatHeader
            controller={controller}
            state={state}
            composer={composer}
            runner={runner}
            turnIntoProject={remote ? undefined : turnIntoProject}
            findInput={findInput}
            titleId={titleId}
            titleBar={titleBar}
            compact={compact}
            list={list}
            listOpen={listOpen}
            onListOpenChange={setListOpen}
            findOwner={findOwner}
            onFindKeyDown={onFindKeyDown}
          />
          {chat}
        </main>
      </div>
    </div>
  );
}

const styles = stylex.create({
  dockPage: { display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'hidden' },
  dockContent: { flex: 1 },
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
  content: {
    backgroundColor: colors.canvas,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  },
  notices: { padding: '0 24px', flexShrink: 0 },
  small: {
    color: colors.secondary,
    fontSize: type.small,
    lineHeight: 1.6,
    margin: '4px 0',
    overflowWrap: 'anywhere',
  },
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
});
