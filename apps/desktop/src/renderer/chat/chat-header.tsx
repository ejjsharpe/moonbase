import { useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { Icon } from '@moonbase/ui/icons';
import { projectInitials, projectTiles } from '@moonbase/ui/projects';
import { colors, space, type } from '@moonbase/ui/tokens.stylex';
import { Context } from 'effect';
import { ChatList, ChatSelection, type ChatComposer } from '@moonbase/application/chat';
import { folderName } from '../components/folder-menu.tsx';
import { activateChatFind, type ChatFindOwner } from './find.tsx';
import { describeOpenChat } from './open-chat.ts';
import { useOpenChat } from './use-open-chat.ts';
import { useChat } from './chat-context.ts';
import type { ChatDock } from './chat-view.tsx';

type OpenChat = ReturnType<typeof useOpenChat>;

/** Settles or unsettles the open chat. */
function SettleButton({ open }: { open: OpenChat }) {
  const { services, act } = useChat();
  const { selected, chat } = open;
  if (!selected || !chat) return null;
  return (
    <Button
      aria-label={chat.settledAt ? 'Unsettle chat' : 'Settle chat'}
      title={chat.settledAt ? 'Unsettle chat' : 'Settle chat'}
      {...stylex.props(controls.button, controls.iconButton)}
      disabled={open.settled === null}
      onClick={() => void act(Context.get(services, ChatList).settle(selected, !chat.settledAt))}>
      <Icon name={chat.settledAt ? 'unsettle' : 'settle'} />
    </Button>
  );
}

/** Opens Find in the open chat's transcript. */
function FindButton({
  find,
  findInput,
}: {
  find: ChatFindOwner;
  findInput: RefObject<HTMLInputElement | null>;
}) {
  const chat = useChat();
  if (!find.selected) return null;
  return (
    <Button
      aria-label="Find"
      title="Find · ⌘F"
      {...stylex.props(controls.button, controls.iconButton)}
      onClick={(event) => activateChatFind(chat, find, event.currentTarget, findInput)}>
      <Icon name="search" />
    </Button>
  );
}

/**
 * Opens a local chat's own folder (one without a project) as a project where it is. Why it
 * couldn't is the composer's message, in that chat.
 */
function TurnButton({
  open,
  composer,
  turnIntoProject,
}: {
  open: OpenChat;
  composer: ChatComposer;
  turnIntoProject: (conversationId: string) => Promise<void>;
}) {
  const { services, runner, act } = useChat();
  const [turning, setTurning] = useState(false);
  if (!open.selected || !open.chat?.ownFolder) return null;
  const id = open.selected.conversationId;
  return (
    <Button
      aria-label="Turn into project"
      title="Turn into project · opens this chat’s folder as a project"
      {...stylex.props(controls.button, controls.iconButton)}
      disabled={turning || !open.ready}
      onClick={() => {
        setTurning(true);
        runner.runSync(composer.dismiss({ chat: id }));
        void turnIntoProject(id)
          .then(
            () => act(Context.get(services, ChatList).reload()),
            (error: unknown) =>
              runner.runSync(
                composer.report({
                  chat: id,
                  text: `The chat could not become a project. ${error instanceof Error ? error.message : ''}`.trim(),
                }),
              ),
          )
          .finally(() => setTurning(false));
      }}>
      <Icon name="newFolder" />
    </Button>
  );
}

/** The dock's own buttons: expand or restore its width, and hide it. */
export function DockButtons({ dock }: { dock: ChatDock }) {
  return (
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
}

/** The open chat's header in a project's dock: back to the project's chats, then its actions. */
export function DockChatHeader({
  find,
  dock,
  findInput,
  onShowList,
}: {
  find: ChatFindOwner;
  dock: ChatDock;
  findInput: RefObject<HTMLInputElement | null>;
  onShowList(): void;
}) {
  const open = useOpenChat();
  const { title, context } = describeOpenChat(open);
  return (
    <header {...stylex.props(workbench.paneHeader, dockHeaderStyles.header)}>
      <Button
        aria-label={`All ${dock.project} chats`}
        title={`All ${dock.project} chats`}
        {...stylex.props(controls.button, controls.iconButton)}
        onClick={onShowList}>
        <Icon name="back" />
      </Button>
      <div
        title={open.selected ? context : `In ${dock.project}`}
        {...stylex.props(dockHeaderStyles.heading)}>
        <h1 {...stylex.props(dockHeaderStyles.title, controls.truncate)}>{title}</h1>
      </div>
      <SettleButton open={open} />
      <FindButton find={find} findInput={findInput} />
      <DockButtons dock={dock} />
    </header>
  );
}

/**
 * The open chat's header in Agents: its project and title, then its actions. Given the window
 * title bar's slot (`titleBar`), it shows there instead of a header of its own; in the compact
 * layout it opens the chat list as a drawer.
 */
export function ChatHeader({
  find,
  composer,
  turnIntoProject,
  findInput,
  titleId,
  titleBar,
  compact,
  list,
  listOpen,
  onListOpenChange,
  onFindKeyDown,
}: {
  composer: ChatComposer;
  turnIntoProject?: (conversationId: string) => Promise<void>;
  findInput: RefObject<HTMLInputElement | null>;
  titleId: string;
  /** The title bar's slot, null until it mounts; undefined for a header of the view's own. */
  titleBar: HTMLElement | null | undefined;
  compact: boolean;
  /** The chat list, for the compact layout's drawer. */
  list: ReactNode;
  listOpen: boolean;
  onListOpenChange(open: boolean): void;
  /** The chat Find belongs to, and its keys, which the title bar's copy needs too. */
  find: ChatFindOwner;
  onFindKeyDown(event: KeyboardEvent<HTMLElement>): void;
}) {
  const { services, act } = useChat();
  const open = useOpenChat();
  const inBar = titleBar !== undefined;
  const { title, context } = describeOpenChat(open);
  const { chat } = open;
  // A chat without a project has no project crumb.
  const folder = chat && !chat.ownFolder ? folderName(chat.cwd) : undefined;
  const content = (
    <>
      {compact && (
        <Dialog.Root open={listOpen} onOpenChange={onListOpenChange}>
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
              {list}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      {/* Breadcrumb: the chat's project, then the chat. Folder and model are in its title. */}
      <div
        title={open.selected ? context : undefined}
        {...stylex.props(styles.crumbs, inBar && styles.barCrumbs)}>
        {open.selected && folder && (
          <>
            <span
              aria-hidden="true"
              data-initials={projectInitials(folder)}
              {...stylex.props(projectTiles.tile, projectTiles.silver, styles.crumbTile)}
            />
            <span {...stylex.props(styles.crumbProject, controls.truncate)}>{folder}</span>
            <span aria-hidden="true" {...stylex.props(styles.crumbSeparator)}>
              /
            </span>
          </>
        )}
        {inBar && !compact && !(open.selected && folder) && (
          <span aria-hidden="true" {...stylex.props(styles.barIcon)}>
            <Icon name="agents" />
          </span>
        )}
        <h1
          id={titleId}
          {...stylex.props(styles.title, inBar && styles.barTitle, controls.truncate)}>
          {title}
        </h1>
      </div>
      <div {...stylex.props(controls.row, inBar && styles.barButtons)}>
        {turnIntoProject && (
          <TurnButton open={open} composer={composer} turnIntoProject={turnIntoProject} />
        )}
        <SettleButton open={open} />
        <FindButton find={find} findInput={findInput} />
        {open.selected && (
          <Button
            aria-label="Close view"
            title="Back to new chat"
            {...stylex.props(controls.button, controls.iconButton)}
            onClick={() => void act(Context.get(services, ChatSelection).closeView)}>
            <Icon name="close" />
          </Button>
        )}
      </div>
    </>
  );
  if (!inBar)
    return <header {...stylex.props(workbench.paneHeader, styles.header)}>{content}</header>;
  return (
    titleBar &&
    createPortal(
      // The bar belongs to this chat for Find, as its header did.
      <div
        data-chat-find-owner={find.owner}
        onKeyDown={onFindKeyDown}
        {...stylex.props(styles.barContext)}>
        {content}
      </div>,
      titleBar,
    )
  );
}

/** The dock's headers: its list's and its open chat's. */
export const dockHeaderStyles = stylex.create({
  header: { gap: space.sm, paddingLeft: 4, paddingRight: 2 },
  // Takes the pointer from the drag region, so its hover text shows.
  heading: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    WebkitAppRegion: 'no-drag',
  },
  title: { margin: 0, fontSize: type.body, fontWeight: 600 },
});

const styles = stylex.create({
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
  header: {
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
});
