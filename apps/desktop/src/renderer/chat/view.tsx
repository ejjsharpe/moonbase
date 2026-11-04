import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { colors, layout, radius, space, type } from '@moonbase/ui/tokens.stylex';
import type { ChatEntry, ChatModelPreference } from '@moonbase/contracts/chat';
import type { ChatController } from '@moonbase/application/chat';
import { ProviderSetup } from './setup.tsx';
import { Choice } from './choice.tsx';
import { Icon } from '../icon.tsx';
const compactLayout = window.matchMedia('(max-width: 640px)');
const subscribeLayout = (listener: () => void) => {
  compactLayout.addEventListener('change', listener);
  return () => compactLayout.removeEventListener('change', listener);
};
/** The consumer owns the clients/runtime and controller lifetime; this view installs no capabilities. */
export function ChatView({
  controller,
  chooseFolder,
}: {
  controller: ChatController;
  chooseFolder?: () => Promise<string | null>;
}) {
  const compact = useSyncExternalStore(subscribeLayout, () => compactLayout.matches);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot),
    [cwd, setCwd] = useState(''),
    [folderError, setFolderError] = useState<string | null>(null);
  const providerState = useSyncExternalStore(
    controller.providers?.subscribe ?? noSubscription,
    controller.providers?.getSnapshot ?? noProviders,
  );
  const local = state.mode === 'local';
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
  let connectionLabel = state.connection?.state ?? 'Loading configuration';
  if (local) connectionLabel = state.ready ? 'Local ready' : 'Loading local chats';
  let contextLabel = local
    ? 'Each conversation retains its working folder and model.'
    : 'Fixed working folder and model are read from the verified remote host.';
  if (state.host && 'cwd' in state.host) contextLabel = `${state.host.cwd} · ${state.host.model}`;
  if (state.snapshot)
    contextLabel = `${state.snapshot.conversation.cwd} · ${state.snapshot.conversation.model}`;
  let conversationTitle = 'New chat';
  if (state.selected) conversationTitle = 'Saved chat selected';
  if (state.snapshot) conversationTitle = state.snapshot.conversation.title;
  let toolNotice = 'Messages and tools run on your configured host.';
  if (local)
    toolNotice =
      state.selected || cwd
        ? 'Local tools can access files outside the working folder.'
        : 'Choose a working folder to send. Local tools are not sandboxed.';
  if (local && !state.selected && !models.length)
    toolNotice = 'Set up a provider to send. Local tools are not sandboxed.';
  const connected = state.ready,
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
  const sidebar = (
    <aside
      aria-label="Saved chats"
      {...stylex.props(styles.sidebar, compact && styles.drawerSidebar)}>
      <Button
        {...stylex.props(controls.button, styles.newChat)}
        onClick={() => {
          setSidebarOpen(false);
          void controller.closeView().then(() => document.getElementById('message')?.focus());
        }}>
        <Icon name="compose" /> New chat
      </Button>
      <div {...stylex.props(controls.row, styles.listHeader)}>
        <h2 {...stylex.props(styles.label)}>Conversations</h2>
        <Button
          aria-label="Refresh saved chats"
          title="Refresh saved chats"
          {...stylex.props(controls.button, controls.iconButton)}
          disabled={!connected || busy('refresh')}
          onClick={() => void controller.firstChats()}>
          <Icon name="refresh" />
        </Button>
      </div>
      <nav aria-label="Conversations" {...stylex.props(styles.chatList)}>
        {!state.chats.length ? (
          <p {...stylex.props(styles.small)}>
            {connected ? 'Your conversations will appear here.' : 'Connect to read saved chats.'}
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
              onClick={() => {
                void controller.select(c.target);
                setSidebarOpen(false);
              }}>
              <span aria-hidden="true" {...stylex.props(styles.chatDot)} />
              <span {...stylex.props(styles.chatSummary)}>
                <span {...stylex.props(controls.truncate)}>{c.title}</span>
                <span {...stylex.props(styles.chatFolder, controls.truncate)}>
                  {c.cwd.split('/').filter(Boolean).at(-1) || '/'}
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
      {state.nextChats && (
        <Button
          {...stylex.props(controls.button, controls.quietButton)}
          disabled={!connected || busy('chats')}
          onClick={() => void controller.moreChats()}>
          Next saved chats
        </Button>
      )}
      <div {...stylex.props(styles.sidebarFoot)}>
        {controller.providers && <ProviderSetup controller={controller.providers} />}
        <div {...stylex.props(controls.row, styles.connectionRow)}>
          <Icon name="computer" />
          <span role="status" {...stylex.props(styles.connection)}>
            {connectionLabel}
          </span>
          {!local &&
            (connected || state.connection?.state === 'connecting' ? (
              <Button
                {...stylex.props(controls.button, controls.quietButton)}
                disabled={busy('disconnect')}
                onClick={() => void controller.disconnect()}>
                Disconnect
              </Button>
            ) : (
              <Button
                {...stylex.props(controls.button)}
                disabled={
                  !state.connection || busy('connect') || state.connection.state === 'disconnecting'
                }
                onClick={() => void controller.connect()}>
                {busy('connect') ? 'Connecting…' : 'Connect'}
              </Button>
            ))}
        </div>
        <details {...stylex.props(styles.small)}>
          <summary {...stylex.props(controls.summary)}>Connection details</summary>
          <p>
            {local
              ? 'Read, write, edit and shell tools use your OS permissions. The working folder is not a sandbox.'
              : state.connection?.profile.destination}
          </p>
          <p>
            Host {controller.context.host.hostId}
            <br />
            Store {controller.context.host.storeId}
            <br />
            Actor {controller.context.actorId}
          </p>
          <p role="status">{state.notice}</p>
          <p>
            {local
              ? 'Hiding Moonbase or switching views keeps local agents running.'
              : 'Disconnect ends connectivity. Remote work continues until you Stop it.'}
          </p>
        </details>
      </div>
    </aside>
  );
  return (
    <div {...stylex.props(workbench.page, styles.page)}>
      <div {...stylex.props(styles.workspace)}>
        {!compact && sidebar}
        <main aria-label="Agent workspace" {...stylex.props(styles.content)}>
          <header
            {...stylex.props(styles.context, !state.selected && !compact && styles.newChatContext)}>
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
            <div {...stylex.props(controls.truncate)}>
              <h1 {...stylex.props(styles.title, !state.selected && !compact && controls.hidden)}>
                {conversationTitle}
              </h1>
              {state.selected && (
                <p title={contextLabel} {...stylex.props(styles.small, controls.truncate)}>
                  {contextLabel}
                </p>
              )}
            </div>
            <div {...stylex.props(controls.row)}>
              {run && (
                <Button
                  {...stylex.props(controls.button, controls.quietButton)}
                  onClick={() => {
                    follow.current = true;
                    if (transcript.current)
                      transcript.current.scrollTop = transcript.current.scrollHeight;
                  }}>
                  Latest output
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
          </header>
          <div {...stylex.props(styles.notices)}>
            {state.notice &&
              !['Disconnected.', 'Verified host.', 'Local chat.', 'Local tools use'].some(
                (prefix) => state.notice.startsWith(prefix),
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
                    {p.operation === 'createChat' && (
                      <p {...stylex.props(styles.small)}>
                        {p.input.title}
                        {p.input.settings
                          ? ` · ${p.input.settings.cwd} · ${p.input.settings.model.provider}/${p.input.settings.model.modelId}${p.input.settings.reasoningEffort ? ` · ${effortLabels[p.input.settings.reasoningEffort]}` : ''}`
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
                      One older page shown. Reading another replaces it; stored history remains on
                      the host.
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
          )}
          <div {...stylex.props(styles.composeArea, !state.selected && styles.starter)}>
            {!state.selected && local && (
              <div {...stylex.props(styles.composeContext)}>
                <Button
                  aria-label="Choose working folder"
                  {...stylex.props(controls.button, controls.quietButton, styles.folderChoice)}
                  disabled={!chooseFolder || busy('send')}
                  title={cwd || 'Choose working folder'}
                  onClick={() => {
                    setFolderError(null);
                    void chooseFolder?.()
                      .then((folder) => {
                        if (folder) setCwd(folder);
                      })
                      .catch(() =>
                        setFolderError(
                          'The folder could not be approved. Choose an existing working folder again.',
                        ),
                      );
                  }}>
                  <Icon name="folder" />
                  <span {...stylex.props(controls.truncate)}>
                    {cwd ? cwd.split('/').filter(Boolean).at(-1) || '/' : 'Choose working folder'}
                  </span>
                  <Icon name="chevron" />
                </Button>
                <span {...stylex.props(styles.localLabel)}>
                  <Icon name="computer" />
                  This Mac
                </span>
              </div>
            )}
            {folderError && (
              <p role="alert" {...stylex.props(styles.warning)}>
                {folderError}
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
              {...stylex.props(styles.composer)}
              onSubmit={(e) => {
                e.preventDefault();
                void controller.send(
                  local && !state.selected && cwd && selection ? { cwd, ...selection } : undefined,
                );
              }}>
              <label htmlFor="message" {...stylex.props(controls.hidden)}>
                Message
              </label>
              <textarea
                id="message"
                {...stylex.props(controls.field, styles.textarea)}
                placeholder={
                  state.selected ? 'Reply…' : 'Ask anything, or describe what you want to build…'
                }
                value={state.draft}
                onChange={(e) => controller.setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <div {...stylex.props(controls.row, styles.composeActions)}>
                <div {...stylex.props(controls.row, styles.modelActions)}>
                  {local && !state.selected ? (
                    <>
                      <div {...stylex.props(styles.modelChoice)}>
                        <Choice
                          compact
                          label="Conversation model"
                          value={selectedModel}
                          options={models}
                          onChange={(value) => {
                            const entry = models.find((model) => model.value === value);
                            if (entry)
                              controller.setModelPreference({
                                model: entry.model,
                                ...(entry.defaultReasoningEffort
                                  ? { reasoningEffort: entry.defaultReasoningEffort }
                                  : {}),
                              });
                          }}
                          disabled={!models.length || busy('send')}
                        />
                      </div>
                      {!!selectedEntry?.reasoningEfforts?.length && (
                        <div {...stylex.props(styles.effortChoice)}>
                          <Choice
                            compact
                            label="Reasoning effort"
                            value={effortUnavailable ? '' : (selectedEffort ?? '')}
                            options={selectedEntry.reasoningEfforts.map((value) => ({
                              value,
                              label: effortLabels[value],
                            }))}
                            onChange={(value) => {
                              const effort = selectedEntry.reasoningEfforts?.find(
                                (effort) => effort === value,
                              );
                              if (effort)
                                controller.setModelPreference({
                                  model: selectedEntry.model,
                                  reasoningEffort: effort,
                                });
                            }}
                            disabled={busy('send')}
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <span {...stylex.props(styles.small, controls.truncate)}>
                      {snapshot?.conversation.model ??
                        (state.host && 'model' in state.host ? state.host.model : 'Remote model')}
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
                    title="Send message · ⌘ Enter"
                    {...stylex.props(controls.button, styles.sendButton)}
                    disabled={
                      !connected ||
                      !state.draft.trim() ||
                      busy('send') ||
                      busy('create') ||
                      !!state.storageError ||
                      (!state.selected && local && (!cwd || !selection)) ||
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
                ⌘ / Ctrl Enter
              </span>
            </div>
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
  drawerSidebar: { paddingTop: 48 },
  page: { fontFamily: type.sans, flex: 1, height: 'auto', minHeight: 0, overflowY: 'auto' },
  connection: {
    textTransform: 'capitalize',
    color: colors.secondary,
    fontSize: type.small,
    flex: 1,
  },
  workspace: {
    display: 'grid',
    gridTemplateColumns: {
      default: '288px minmax(0, 1fr)',
      '@media (max-width: 760px)': '210px minmax(0, 1fr)',
      '@media (max-width: 640px)': 'minmax(0, 1fr)',
    },
    flex: 1,
    minHeight: 0,
  },
  sidebar: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.chrome,
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.border,
    padding: '12px 8px 16px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
  },
  newChat: {
    fontSize: type.body,
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    textAlign: 'left',
    padding: '9px 12px',
    borderWidth: 0,
    borderRadius: radius.row,
    backgroundColor: { default: colors.elevated, ':hover:not(:disabled)': colors.hover },
  },
  small: {
    color: colors.secondary,
    fontSize: type.small,
    lineHeight: 1.6,
    margin: '4px 0',
    overflowWrap: 'anywhere',
  },
  label: { fontSize: type.small, fontWeight: 400, margin: 0, color: colors.muted },
  listHeader: { justifyContent: 'space-between', margin: '24px 8px 4px' },
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
  chatFolder: { color: colors.muted, fontSize: type.small, fontWeight: 400 },
  chatDot: {
    marginTop: 7,
    width: 5,
    height: 5,
    borderRadius: '50%',
    backgroundColor: colors.muted,
    flexShrink: 0,
  },
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
  sidebarFoot: {
    marginTop: 'auto',
    padding: '16px 8px 0',
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    fontSize: type.small,
  },
  connectionRow: { margin: '12px 0 8px', gap: 6, color: colors.secondary },
  content: {
    backgroundColor: colors.canvas,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflowY: 'auto',
  },
  newChatContext: { minHeight: 0, padding: 0 },
  context: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    padding: '16px 28px',
    minHeight: 56,
    flexShrink: 0,
  },
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
  composeArea: {
    width: 'calc(100% - 48px)',
    maxWidth: layout.conversation,
    margin: '12px auto 8px',
    flexShrink: 0,
  },
  starter: { margin: 'auto', paddingBottom: 40 },
  composeContext: {
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
    margin: '0 4px 8px',
    flexWrap: 'wrap',
  },
  folderChoice: { maxWidth: '100%' },
  localLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
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
  textarea: {
    width: '100%',
    resize: 'none',
    minHeight: 48,
    maxHeight: '25vh',
    fontSize: type.message,
    lineHeight: 1.6,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    padding: 0,
    ':focus-visible': { outline: 'none' },
  },
  composeActions: { minHeight: 32, justifyContent: 'flex-end', flexWrap: 'wrap', gap: space.sm },
  modelActions: { marginLeft: 'auto', minWidth: 0, maxWidth: '100%', flexWrap: 'nowrap' },
  modelChoice: { maxWidth: 280, minWidth: 0 },
  effortChoice: { flexShrink: 0, width: 116 },
  sendButton: {
    display: 'inline-flex',
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
    width: 32,
    height: 32,
    padding: 7,
    borderWidth: 0,
    borderRadius: '50%',
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
