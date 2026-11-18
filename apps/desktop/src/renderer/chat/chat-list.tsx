import { useLayoutEffect, useRef } from 'react';
import { Context } from 'effect';
import { useAtomValue } from '@effect/atom-react';
import { Button } from '@base-ui/react/button';
import { motion, useReducedMotion } from 'motion/react';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { spinner } from '@moonbase/ui/spinner';
import { workbench } from '@moonbase/ui/workbench';
import { Icon } from '@moonbase/ui/icons';
import { colors, radius, space, syntax, type } from '@moonbase/ui/tokens.stylex';
import {
  ChatConnection,
  ChatList as ChatListService,
  ChatSelection,
  groupChatsByActivity,
  type ActiveChat,
  type ChatActivityReason,
} from '@moonbase/application/chat';
import { useStoredToggle } from '../hooks/use-stored-toggle.ts';
import { useNow } from '../hooks/use-now.ts';
import { formatChatAge } from './age.ts';
import { getChatPlace } from './folder.ts';
import { focusMessage, isBusy } from './open-chat.ts';
import { useChat } from './chat-context.ts';

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

/**
 * Agents' chat list: Ready, Working and Idle, with older pages and a Settled drawer at its foot,
 * and Connect for a remote host that isn't connected.
 */
export function ChatList({
  compact,
  hidden,
  onChosen,
  startNewChat,
}: {
  /** Whether the list is the compact layout's drawer. */
  compact: boolean;
  /** Whether the list is hidden beside the chat, leaving the chat the full width. */
  hidden: boolean;
  /** Told when a chat or a new chat was chosen, so a drawer can close. */
  onChosen(): void;
  startNewChat(): void;
}) {
  const [settledShown, toggleSettled] = useStoredToggle('moonbase.chats.settled');
  const { atoms, services, act } = useChat();
  const list = Context.get(services, ChatListService);
  const { remote, connection, ready: connected } = useAtomValue(atoms.link);
  const { chats, nextChats } = useAtomValue(atoms.list);
  const seen = useAtomValue(atoms.seen);
  const pending = useAtomValue(atoms.pending);
  const dispatching = useAtomValue(atoms.dispatching);
  const snapshot = useAtomValue(atoms.snapshot);
  const selected = useAtomValue(atoms.selected);
  const active = useAtomValue(atoms.active);
  const busy = (id: string) => isBusy(active, id);
  // Ages are in minutes, so the list reads the time each minute.
  const now = useNow(60_000);
  const groups = groupChatsByActivity({ chats, seen, pending, dispatching, open: snapshot });
  const reducedMotion = useReducedMotion();
  const settledMotion = { duration: reducedMotion ? 0 : 0.22, ease: [0.2, 0.8, 0.2, 1] as const };
  const chatRow = ({ chat: c, reason, at }: ActiveChat) => (
    <Button
      key={c.target.conversationId}
      aria-pressed={selected?.conversationId === c.target.conversationId}
      {...stylex.props(
        controls.button,
        controls.listButton,
        styles.chat,
        (reason === 'idle' || reason === 'settled') && styles.restingChat,
        selected?.conversationId === c.target.conversationId && styles.selected,
      )}
      disabled={!connected || busy('open')}
      onClick={() => {
        void act(Context.get(services, ChatSelection).select(c.target));
        onChosen();
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
        {now !== undefined && formatChatAge(at, now)}
      </time>
    </Button>
  );
  let emptyList = '';
  if (connected) emptyList = 'Your conversations will appear here.';
  else if (!remote) emptyList = 'Loading chats…';
  // Hiding the list while focus is in it hands focus to the composer rather than the page.
  const focusInList = useRef(false);
  useLayoutEffect(() => {
    if (!hidden || compact || !focusInList.current) return;
    focusInList.current = false;
    focusMessage();
  }, [hidden, compact]);
  const group = (label: string, rows: readonly ActiveChat[]) =>
    rows.length > 0 && (
      <>
        <h3 {...stylex.props(styles.groupHeading)}>
          {label} <span {...stylex.props(styles.groupCount)}>{rows.length}</span>
        </h3>
        {rows.map(chatRow)}
      </>
    );
  return (
    <aside
      aria-label="Saved chats"
      onFocusCapture={() => (focusInList.current = true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusInList.current = false;
      }}
      inert={!compact && hidden}
      {...stylex.props(
        styles.sidebar,
        compact && styles.drawerSidebar,
        !compact && hidden && styles.sidebarClosed,
      )}>
      <div {...stylex.props(workbench.pane, styles.listPane)}>
        <div {...stylex.props(controls.row, styles.listHeader)}>
          <h2 {...stylex.props(styles.sidebarTitle)}>Agents</h2>
          <Button
            aria-label="Refresh saved chats"
            title="Refresh saved chats"
            {...stylex.props(controls.button, controls.iconButton)}
            disabled={!connected || busy('refresh')}
            onClick={() => void act(Context.get(services, ChatConnection).refresh)}>
            <Icon name="refresh" />
          </Button>
          <Button
            aria-label="New chat"
            title="New chat · ⌘N"
            {...stylex.props(controls.button, styles.newChat)}
            onClick={() => {
              onChosen();
              startNewChat();
            }}>
            <Icon name="compose" />
            New <kbd {...stylex.props(styles.newKey)}>⌘N</kbd>
          </Button>
        </div>
        {remote && !connected && (
          <div {...stylex.props(controls.row, styles.offline)}>
            <span role="status" {...stylex.props(styles.offlineText)}>
              {connection?.state === 'connecting' ? 'Connecting…' : 'Not connected'}
            </span>
            <Button
              {...stylex.props(controls.button)}
              disabled={
                !connection ||
                busy('connect') ||
                ['connecting', 'disconnecting'].includes(connection.state)
              }
              onClick={() => void act(Context.get(services, ChatConnection).connect)}>
              {busy('connect') ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        )}
        <nav
          aria-label="Conversations"
          {...stylex.props(styles.chatList, !settledShown && styles.clipList)}>
          {!chats.length &&
            // Offline, the Connect line above says why the list is empty.
            emptyList && <p {...stylex.props(styles.small)}>{emptyList}</p>}
          {group('Ready', groups.ready)}
          {group('Working', groups.working)}
          {group('Idle', groups.idle)}
          {nextChats && (
            // Older pages hold idle and settled chats alike, so this sits outside the drawer.
            <Button
              {...stylex.props(controls.button, controls.quietButton, styles.older)}
              disabled={!connected || busy('chats')}
              onClick={() => void act(list.more)}>
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
                  .filter((row) => row.chat.target.conversationId === selected?.conversationId)
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
}

const styles = stylex.create({
  listPane: { padding: '10px 8px 16px', gap: space.sm, overflowY: 'auto' },
  drawerSidebar: { paddingTop: 48 },
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
  listHeader: { gap: space.xs, flexWrap: 'nowrap', paddingRight: 2 },
  /** The list fills its column, so a closed Settled toggle can sit at its foot. */
  chatList: { display: 'flex', flexDirection: 'column', gap: 2, minHeight: 80, flex: 1 },
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
