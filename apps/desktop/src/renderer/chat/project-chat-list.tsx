import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { Icon } from '@moonbase/ui/icons';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import type { ChatController, ChatState } from '@moonbase/application/chat';
import type { ChatSummary } from '@moonbase/contracts/chat';
import { getChatPlace } from './folder.ts';
import { DockButtons, dockHeaderStyles } from './chat-header.tsx';
import { isBusy } from './open-chat.ts';
import type { ChatDock } from './chat-view.tsx';

/** The project dock's list of the project's chats, with New chat and the dock's own buttons. */
export function ProjectChatList({
  controller,
  state,
  dock,
  chats,
  onChoose,
  onNewChat,
}: {
  controller: ChatController;
  state: ChatState;
  dock: ChatDock;
  /** The chats in the project's folders. */
  chats: readonly ChatSummary[];
  onChoose(chat: ChatSummary): void;
  onNewChat(): void;
}) {
  const connected = state.ready,
    busy = (id: string) => isBusy(state, id);
  return (
    <section aria-label={`${dock.project} chats`} {...stylex.props(styles.list)}>
      <header {...stylex.props(workbench.paneHeader, dockHeaderStyles.header)}>
        <div
          title="This project only · every project's chats are in Agents"
          {...stylex.props(dockHeaderStyles.heading)}>
          <h2 {...stylex.props(dockHeaderStyles.title)}>{dock.project} chats</h2>
        </div>
        <Button
          {...stylex.props(controls.button, styles.newChat)}
          disabled={busy('send') || busy('create')}
          onClick={onNewChat}>
          <Icon name="compose" /> New chat
        </Button>
        <DockButtons dock={dock} />
      </header>
      <div {...stylex.props(workbench.pane, workbench.canvasPane, styles.scrollPane)}>
        <nav aria-label={`${dock.project} conversations`} {...stylex.props(styles.chatList)}>
          {!chats.length ? (
            <p {...stylex.props(styles.empty)}>
              {connected ? `No chats in ${dock.project} yet.` : 'Connect to read saved chats.'}
            </p>
          ) : (
            chats.map((c) => (
              <Button
                key={c.target.conversationId}
                aria-pressed={state.selected?.conversationId === c.target.conversationId}
                {...stylex.props(
                  controls.button,
                  controls.listButton,
                  styles.chat,
                  state.selected?.conversationId === c.target.conversationId && styles.selected,
                )}
                disabled={!connected || busy('open')}
                onClick={() => {
                  onChoose(c);
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
  );
}

const styles = stylex.create({
  list: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' },
  scrollPane: { overflowY: 'auto' },
  newChat: { display: 'inline-flex', alignItems: 'center', gap: space.xs, flexShrink: 0 },
  empty: {
    color: colors.secondary,
    fontSize: type.small,
    lineHeight: 1.6,
    margin: '4px 0',
    overflowWrap: 'anywhere',
    padding: space.md,
  },
  chatList: { display: 'flex', flexDirection: 'column', gap: 2, minHeight: 80 },
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
});
