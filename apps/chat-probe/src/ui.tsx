import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { colors, layout, radius, space, type } from '@moonbase/ui/tokens.stylex';
import type { ChatClient, ChatEntry, ChatSession } from '@moonbase/application/chat-client';
import type { ConnectionClient } from '@moonbase/application/connection-client';
import { ChatProofController, type DraftStorage } from './controller.ts';
export { ChatProofController } from './controller.ts';
export type { ChatProofState, Pending, DraftStorage } from './controller.ts';

export type ChatProofProps = {
  chat: ChatClient;
  connection: ConnectionClient;
  context: ChatSession;
  storage: DraftStorage;
};
/** The consumer owns the clients/runtime and controller lifetime; this view installs no capabilities. */
export function ChatProof({ controller }: { controller: ChatProofController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot),
    [title, setTitle] = useState('');
  const connected = state.connection?.state === 'connected',
    busy = (id: string) => state.active.includes(id);
  const snapshot = state.snapshot,
    run = snapshot?.run;
  const transcript = useRef<HTMLElement>(null),
    follow = useRef(true);
  useLayoutEffect(() => {
    if (follow.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [snapshot, state.pending.length]);
  const entries = [...(snapshot?.entries ?? []), ...state.older]
    .filter((e, i, all) => all.findIndex((q) => q.id === e.id) === i)
    .reverse();
  useEffect(() => {
    void controller.start();
  }, [controller]);
  return (
    <div {...stylex.props(workbench.page, styles.page)}>
      <header {...stylex.props(workbench.toolbar, styles.header)}>
        <strong>
          Moonbase <span {...stylex.props(styles.muted)}>Chat</span>
        </strong>
        <div {...stylex.props(controls.row)}>
          <span role="status" {...stylex.props(styles.connection)}>
            {state.connection?.state ?? 'Loading configuration'}
          </span>
          {connected || state.connection?.state === 'connecting' ? (
            <Button
              {...stylex.props(controls.button)}
              disabled={busy('disconnect')}
              onClick={() => void controller.disconnect()}>
              Disconnect
            </Button>
          ) : (
            <Button
              {...stylex.props(controls.button, styles.primary)}
              disabled={
                !state.connection || busy('connect') || state.connection.state === 'disconnecting'
              }
              onClick={() => void controller.connect()}>
              {busy('connect') ? 'Connecting…' : 'Connect'}
            </Button>
          )}
        </div>
      </header>
      <div {...stylex.props(styles.workspace)}>
        <aside aria-label="Saved chats" {...stylex.props(styles.sidebar)}>
          <section {...stylex.props(styles.profile)}>
            <h1 {...stylex.props(styles.heading)}>
              {state.connection?.profile.label ?? 'Configured host'}
            </h1>
            <p {...stylex.props(styles.small)}>
              {state.connection?.profile.destination ?? 'Loading…'}
            </p>
            <p {...stylex.props(styles.small)}>
              Host {controller.context.host.hostId}
              <br />
              Store {controller.context.host.storeId}
              <br />
              Actor {controller.context.actorId}
            </p>
          </section>
          <form
            {...stylex.props(styles.create)}
            onSubmit={(e) => {
              e.preventDefault();
              void controller.create(title);
            }}>
            <label htmlFor="chat-title" {...stylex.props(styles.label)}>
              New saved chat
            </label>
            <input
              id="chat-title"
              {...stylex.props(controls.field, controls.fullWidth)}
              placeholder="Chat title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
            <Button
              type="submit"
              {...stylex.props(controls.button)}
              disabled={!connected || busy('create') || !!state.storageError || !title.trim()}>
              Create chat
            </Button>
          </form>
          <div {...stylex.props(controls.row, styles.listHeader)}>
            <h2 {...stylex.props(styles.label)}>Saved chats</h2>
            <Button
              {...stylex.props(controls.button)}
              disabled={!connected || busy('refresh')}
              onClick={() => void controller.firstChats()}>
              Refresh
            </Button>
          </div>
          <nav {...stylex.props(styles.chatList)}>
            {!state.chats.length ? (
              <p {...stylex.props(styles.small)}>
                {connected ? 'No saved chats in this page.' : 'Connect to read saved chats.'}
              </p>
            ) : (
              state.chats.map((c) => (
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
                  onClick={() => void controller.select(c.target)}>
                  {c.title}
                  <span {...stylex.props(styles.chatDate)}>
                    {new Date(c.createdAt).toLocaleDateString()}
                  </span>
                </Button>
              ))
            )}
          </nav>
          {state.nextChats && (
            <Button
              {...stylex.props(controls.button)}
              disabled={!connected || busy('chats')}
              onClick={() => void controller.moreChats()}>
              Next saved chats
            </Button>
          )}
          <p {...stylex.props(styles.small, styles.sidebarFoot)}>
            Disconnect ends connectivity.
            <br />
            Remote work continues until you Stop it.
          </p>
        </aside>
        <main {...stylex.props(styles.content)}>
          <div {...stylex.props(styles.context)}>
            <div>
              <h2 {...stylex.props(styles.title)}>
                {snapshot?.conversation.title ??
                  (state.selected ? 'Saved chat selected' : 'Remote chat')}
              </h2>
              <p {...stylex.props(styles.small)}>
                {state.host
                  ? `${state.host.cwd} · ${state.host.model}`
                  : 'Fixed working folder and model are read from the verified remote host.'}
              </p>
            </div>
            {run && (
              <Button
                {...stylex.props(controls.button)}
                onClick={() => {
                  follow.current = true;
                  if (transcript.current)
                    transcript.current.scrollTop = transcript.current.scrollHeight;
                }}>
                Latest output
              </Button>
            )}
            {state.selected && (
              <Button {...stylex.props(controls.button)} onClick={() => controller.closeView()}>
                Close view
              </Button>
            )}
          </div>
          <div {...stylex.props(styles.notices)}>
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
            <p role="status" {...stylex.props(styles.small)}>
              {state.notice}
            </p>
          </div>
          {state.pending.length > 0 && (
            <section aria-label="Retained commands" {...stylex.props(styles.pending)}>
              <h3 {...stylex.props(styles.label)}>Retained command identities</h3>
              {state.pending.map((p) => {
                let identity = '';
                if (p.operation === 'sendChat')
                  identity = ` · chat ${p.input.target.conversationId}`;
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
          <section
            ref={transcript}
            onWheel={(event) => {
              if (event.deltaY < 0) follow.current = false;
              else {
                const el = event.currentTarget;
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) follow.current = true;
              }
            }}
            onKeyDown={(event) => {
              if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) follow.current = false;
              if (event.key === 'End') follow.current = true;
            }}
            onPointerDown={() => {
              follow.current = false;
            }}
            aria-label="Chat transcript"
            {...stylex.props(styles.transcript)}>
            {!state.selected && (
              <div {...stylex.props(styles.empty)}>
                <h2 {...stylex.props(styles.emptyTitle)}>A saved conversation, on your host.</h2>
                <p>
                  {connected
                    ? 'Create a chat or open one from the sidebar.'
                    : 'Connect to your configured host to begin.'}
                </p>
                <p {...stylex.props(styles.small)}>
                  Messages and tools run remotely. Reconnecting reads the current chat and never
                  resends your input.
                </p>
              </div>
            )}
            {state.selected && !snapshot && (
              <div {...stylex.props(styles.empty)}>
                <p>
                  {connected
                    ? 'Reading the saved chat…'
                    : 'This view is offline. Its draft and unresolved command identities are retained.'}
                </p>
              </div>
            )}
            {state.selected && snapshot && (
              <div {...stylex.props(styles.measure)}>
                {state.olderCursor && (
                  <Button
                    {...stylex.props(controls.button)}
                    disabled={!connected || busy('history')}
                    onClick={() => {
                      follow.current = false;
                      void controller.older();
                    }}>
                    Read older page
                  </Button>
                )}
                {state.older.length > 0 && (
                  <p {...stylex.props(styles.small)}>
                    One older page shown. Reading another replaces it; stored history remains on the
                    host.
                  </p>
                )}
                {entries.map((e) => (
                  <Entry key={e.id} entry={e} />
                ))}
                {run && (
                  <article aria-label="Live response" {...stylex.props(styles.message)}>
                    <div {...stylex.props(styles.messageHeader)}>
                      <strong>Assistant</strong>
                      <span>{run.state}</span>
                    </div>
                    <p {...stylex.props(styles.messageText)}>{run.text || 'Working…'}</p>
                    {run.truncated && (
                      <p {...stylex.props(styles.small)}>Live preview truncated to 4 KiB.</p>
                    )}
                    {run.tools.map((t) => (
                      <details key={t.taskId} open {...stylex.props(styles.tool)}>
                        <summary {...stylex.props(controls.summary)}>
                          {t.name} · {t.state}
                        </summary>
                        <pre {...stylex.props(controls.pre, styles.toolText)}>
                          {t.text || 'Tool activity in progress…'}
                        </pre>
                        {t.truncated && (
                          <p {...stylex.props(styles.small)}>Tool preview truncated.</p>
                        )}
                      </details>
                    ))}
                  </article>
                )}
                <p role="status" {...stylex.props(styles.small)}>
                  Chat {snapshot.state}
                  {snapshot.message ? ` · ${snapshot.message}` : ''}
                </p>
              </div>
            )}
          </section>
          <form
            {...stylex.props(styles.composer)}
            onSubmit={(e) => {
              e.preventDefault();
              void controller.send();
            }}>
            <label htmlFor="message" {...stylex.props(styles.label)}>
              Message
            </label>
            <textarea
              id="message"
              {...stylex.props(controls.field, styles.textarea)}
              placeholder="Write to the remote chat…"
              value={state.draft}
              disabled={!state.selected}
              onChange={(e) => controller.setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void controller.send();
                }
              }}
            />
            <div {...stylex.props(controls.row, styles.composeActions)}>
              <span {...stylex.props(styles.small)}>
                {new TextEncoder().encode(state.draft).length.toLocaleString()} / 32,768 bytes ·
                ⌘/Ctrl Enter
              </span>
              <div {...stylex.props(controls.row)}>
                <Button
                  {...stylex.props(controls.button)}
                  disabled={!connected || !run || busy('stop') || !!state.storageError}
                  onClick={() => void controller.stop()}>
                  Stop
                </Button>
                <Button
                  type="submit"
                  {...stylex.props(controls.button, styles.primary)}
                  disabled={
                    !connected ||
                    !state.selected ||
                    !state.draft.trim() ||
                    busy('send') ||
                    !!state.storageError ||
                    state.pending.some(
                      (p) =>
                        p.operation === 'sendChat' &&
                        p.input.target.conversationId === state.selected?.conversationId,
                    )
                  }>
                  Send message
                </Button>
              </div>
            </div>
          </form>
        </main>
      </div>
      <footer {...stylex.props(controls.status)}>
        Chat proof · human acceptance pending · Closing a view or quitting does not Stop remote
        work.
      </footer>
    </div>
  );
}
function Entry({ entry: e }: { entry: ChatEntry }) {
  let label = e.toolName ?? e.role;
  if (e.role === 'user') label = 'You';
  else if (e.role === 'assistant') label = 'Assistant';
  return (
    <article {...stylex.props(styles.message)}>
      <div {...stylex.props(styles.messageHeader)}>
        <strong>{label}</strong>
        {e.isError && <span>Failed</span>}
      </div>
      <p {...stylex.props(styles.messageText)}>{e.text}</p>
      {e.truncated && (
        <p {...stylex.props(styles.small)}>
          Preview truncated to 4 KiB. The full transcript remains on the host.
        </p>
      )}
    </article>
  );
}
export function createChatProof(props: ChatProofProps) {
  return new ChatProofController(props.chat, props.connection, props.context, props.storage);
}
const styles = stylex.create({
  page: { fontFamily: type.sans },
  header: { minHeight: 56 },
  muted: { color: colors.secondary, fontWeight: 400 },
  connection: { textTransform: 'capitalize', color: colors.secondary },
  primary: {
    backgroundColor: { default: colors.accent, ':hover:not(:disabled)': colors.link },
    color: colors.onAccent,
  },
  workspace: {
    display: 'grid',
    gridTemplateColumns: {
      default: '256px minmax(0, 1fr)',
      '@media (max-width: 760px)': '190px minmax(0, 1fr)',
    },
    flex: 1,
    minHeight: 0,
  },
  sidebar: {
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.border,
    padding: space.lg,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: space.lg,
  },
  profile: {
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
    paddingBottom: space.sm,
  },
  heading: { fontSize: type.body, margin: '0 0 4px', overflowWrap: 'anywhere' },
  small: {
    color: colors.secondary,
    fontSize: type.small,
    lineHeight: 1.6,
    margin: '4px 0',
    overflowWrap: 'anywhere',
  },
  label: { fontSize: type.small, fontWeight: 600, margin: 0, color: colors.secondary },
  create: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: space.sm },
  listHeader: { justifyContent: 'space-between' },
  chatList: { display: 'flex', flexDirection: 'column', gap: space.xs },
  chat: { padding: '10px 8px', borderRadius: radius.row },
  selected: {
    backgroundColor: { default: colors.selected, ':hover:not(:disabled)': colors.selectedHover },
  },
  chatDate: { display: 'block', color: colors.muted, fontSize: type.caption, marginTop: space.xs },
  sidebarFoot: { marginTop: 'auto' },
  content: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
  },
  context: {
    display: 'flex',
    alignItems: 'start',
    justifyContent: 'space-between',
    gap: space.sm,
    padding: '16px 24px',
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
    flexShrink: 0,
  },
  title: { fontSize: type.heading, margin: 0, overflowWrap: 'anywhere' },
  notices: { padding: '8px 24px', flexShrink: 0 },
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
    padding: '8px 24px',
    maxHeight: '30vh',
    overflowY: 'auto',
    flexShrink: 0,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
  },
  pendingItem: { margin: '8px 0', color: colors.warningText },
  pendingText: { maxHeight: 100, overflowY: 'auto', color: colors.text },
  identity: {
    fontFamily: type.mono,
    fontSize: type.caption,
    overflowWrap: 'anywhere',
    color: colors.secondary,
  },
  transcript: { overflowY: 'auto', flex: 1, minHeight: 60, padding: '8px 24px' },
  empty: {
    maxWidth: layout.conversation,
    margin: '48px auto',
    lineHeight: 1.7,
    color: colors.secondary,
  },
  emptyTitle: { fontSize: type.heading, color: colors.text, fontWeight: 500 },
  measure: { maxWidth: layout.conversation, margin: '0 auto' },
  message: { margin: '24px 0' },
  messageHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: space.sm,
    fontSize: type.small,
    color: colors.secondary,
  },
  messageText: {
    fontSize: type.message,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    margin: '8px 0',
  },
  tool: {
    backgroundColor: colors.surface,
    borderRadius: radius.row,
    padding: space.md,
    marginTop: space.md,
  },
  toolText: { maxHeight: 96, overflowY: 'auto' },
  composer: {
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    width: 'calc(100% - 48px)',
    maxWidth: layout.conversation,
    margin: '12px auto 16px',
    padding: space.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    borderRadius: radius.composer,
  },
  textarea: {
    width: '100%',
    resize: 'vertical',
    minHeight: 76,
    maxHeight: '25vh',
    fontSize: type.body,
    lineHeight: 1.6,
    backgroundColor: colors.surface,
  },
  composeActions: { justifyContent: 'space-between' },
});
