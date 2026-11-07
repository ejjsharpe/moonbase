import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { workbench } from '@moonbase/ui/workbench';
import { colors, layout, radius, shadow, space, syntax, type } from '@moonbase/ui/tokens.stylex';
import type { ChatModelPreference } from '@moonbase/contracts/chat';
import type { ChatController } from '@moonbase/application/chat';
import { activateChatFind, FindBar, handleChatFindKeyDown } from './find.tsx';
import { Transcript } from './transcript.tsx';
import type { TranscriptNative } from '../../chat/wire.ts';
import { ProviderSetup } from './setup.tsx';
import { Choice } from './choice.tsx';
import { Icon } from '../icon.tsx';
import { MessageInput } from './message-input.tsx';
import {
  listChatCommands,
  removeCommandLine,
  resolveCommandLine,
  type ChatCommand,
  type ChatCommandOption,
} from './commands.ts';
import { chatWorktreeBranch } from './worktree.ts';
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
  toggleExpanded(): void;
  collapse(): void;
};

/** The consumer owns the clients/runtime and controller lifetime; this view installs no capabilities. */
export function ChatView({
  controller,
  chooseFolder,
  createWorktree,
  transcriptNative,
  dock,
}: {
  controller: ChatController;
  chooseFolder?: () => Promise<string | null>;
  /** Creates a linked worktree of a local folder, named for the branch, and returns its root. */
  createWorktree?: (root: string, branch: string) => Promise<string>;
  transcriptNative?: TranscriptNative;
  /** Shows only one project's chats, beside its editor, with a back arrow to their list. */
  dock?: ChatDock;
}) {
  const compact = useSyncExternalStore(subscribeLayout, () => compactLayout.matches);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot),
    [cwd, setCwd] = useState(dock?.cwd ?? ''),
    [dockList, setDockList] = useState(false),
    [folderError, setFolderError] = useState<string | null>(null),
    // An error belongs to the command line it was about; editing it or changing chat hides it.
    [commandError, setCommandError] = useState<{ text: string; message: string } | null>(null),
    [newWorktree, setNewWorktree] = useState(false),
    [creatingWorktree, setCreatingWorktree] = useState(false);
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
  const folderName = cwd ? cwd.split('/').filter(Boolean).at(-1) || '/' : '';
  const selectedFolder = (
    state.snapshot?.conversation.cwd ??
    state.chats.find((c) => c.target.conversationId === state.selected?.conversationId)?.cwd ??
    ''
  )
    .split('/')
    .filter(Boolean)
    .at(-1);
  const connected = state.ready,
    busy = (id: string) => state.active.includes(id);
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
  const startNewChat = () =>
    void controller.closeView().then(() => document.getElementById('message')?.focus());
  const choosing = local && !state.selected && !busy('send') && !creatingWorktree;
  // A new worktree is made only when the first message is sent, so an unsent chat leaves no trace.
  const worktreeChoice = !state.selected && local && !!createWorktree && !!cwd;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const sendInWorktree = (settings: ChatModelPreference) => {
    setCreatingWorktree(true);
    void createWorktree!(cwd, chatWorktreeBranch(state.draft)).then(
      (root) => {
        // Git may take a while: send only if this view still shows the new chat it was made for.
        if (!mounted.current) return;
        setCreatingWorktree(false);
        // The chat keeps this worktree, so a retried send never makes a second one.
        setCwd(root);
        setNewWorktree(false);
        if (controller.getSnapshot().selected)
          setFolderError(
            `The worktree is ready at ${root}. Send from a new chat there to start it.`,
          );
        else void controller.send({ cwd: root, ...settings });
      },
      (error: unknown) => {
        if (!mounted.current) return;
        setCreatingWorktree(false);
        setFolderError(
          `The worktree could not be created. ${error instanceof Error ? error.message : ''}`.trim(),
        );
      },
    );
  };
  const commands = listChatCommands({
    selected: !!state.selected,
    running: !!run && connected && !busy('stop') && !state.storageError,
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
    newChat: startNewChat,
    stop: () => void controller.stop(),
    clearDraft: () => controller.setDraft(''),
    chooseModel,
    chooseEffort,
  });
  // A command consumes its line before it runs, so `/clear` and `/new` start from the rest.
  const runCommand = (command: ChatCommand, option?: ChatCommandOption) => {
    setCommandError(null);
    controller.setDraft(removeCommandLine(state.draft), state.mentions);
    command.run(option);
  };
  const typedCommand = resolveCommandLine(state.draft, commands);
  const sidebar = (
    <aside
      aria-label="Saved chats"
      {...stylex.props(styles.sidebar, compact && styles.drawerSidebar)}>
      <Button
        {...stylex.props(controls.button, styles.newChat)}
        onClick={() => {
          setSidebarOpen(false);
          startNewChat();
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
        {folderError && (
          <p role="alert" {...stylex.props(styles.warning)}>
            {folderError}
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
            // ⌘ Enter submits even while Send is disabled; one worktree per first message.
            if (creatingWorktree) return;
            if (worktreeChoice && newWorktree && selection) {
              setFolderError(null);
              sendInWorktree(selection);
              return;
            }
            void controller.send(
              local && !state.selected && cwd && selection ? { cwd, ...selection } : undefined,
            );
          }}>
          <div {...stylex.props(styles.messageRow)}>
            <span aria-hidden="true" {...stylex.props(styles.prompt)}>
              ❯
            </span>
            <MessageInput
              controller={controller}
              draft={state.draft}
              mentions={state.mentions}
              searchable={
                controller.canFindFiles && connected && (!!state.selected || !local || !!cwd)
              }
              cwd={!state.selected && local && cwd ? cwd : undefined}
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
            {!state.selected && local && (
              <div {...stylex.props(styles.composeContext)}>
                <Button
                  aria-label="Choose working folder"
                  {...stylex.props(controls.button, controls.quietButton, styles.folderChoice)}
                  disabled={!chooseFolder || busy('send') || creatingWorktree}
                  title={cwd || 'Choose working folder'}
                  onClick={() => {
                    setFolderError(null);
                    void chooseFolder?.()
                      .then((folder) => {
                        if (folder) {
                          setCwd(folder);
                          setNewWorktree(false);
                        }
                      })
                      .catch(() =>
                        setFolderError(
                          'The folder could not be approved. Choose an existing working folder again.',
                        ),
                      );
                  }}>
                  {folderName ? (
                    <span
                      aria-hidden="true"
                      data-initials={projectInitials(folderName)}
                      {...stylex.props(projectTiles.tile, projectTiles.silver, styles.folderTile)}
                    />
                  ) : (
                    <Icon name="folder" />
                  )}
                  <span {...stylex.props(controls.truncate)}>
                    {folderName || 'Choose working folder'}
                  </span>
                  <span aria-hidden="true" {...stylex.props(styles.caret)}>
                    ▾
                  </span>
                </Button>
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
                      onChange={(value) => setNewWorktree(value === 'new')}
                      disabled={busy('send') || creatingWorktree}
                    />
                  </div>
                )}
                <span {...stylex.props(styles.localLabel)}>
                  <span aria-hidden="true" {...stylex.props(styles.localDot)} />
                  local
                </span>
              </div>
            )}
            <div {...stylex.props(controls.row, styles.modelActions)}>
              {local && !state.selected ? (
                <>
                  <div {...stylex.props(styles.modelChoice)}>
                    <Choice
                      compact
                      label="Conversation model"
                      value={selectedModel}
                      options={models}
                      onChange={chooseModel}
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
                        onChange={chooseEffort}
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
                  typedCommand
                    ? false
                    : !connected ||
                      !state.draft.trim() ||
                      creatingWorktree ||
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
            <header {...stylex.props(styles.dockHeader)}>
              <div {...stylex.props(styles.dockHeading)}>
                <h2 {...stylex.props(styles.dockTitle)}>{dock.project} chats</h2>
                <p {...stylex.props(styles.small, controls.truncate)}>
                  This project only · every project&apos;s chats are in Agents
                </p>
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
            <nav aria-label={`${dock.project} conversations`} {...stylex.props(styles.chatList)}>
              {!projectChats.length ? (
                <p {...stylex.props(styles.small, styles.dockEmpty)}>
                  {connected ? `No chats in ${dock.project} yet.` : 'Connect to read saved chats.'}
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
                      state.selected?.conversationId === c.target.conversationId && styles.selected,
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
          </section>
        ) : (
          <main aria-label="Agent workspace" {...stylex.props(styles.content, styles.dockContent)}>
            {findBar}
            <header {...stylex.props(styles.dockHeader)}>
              <Button
                aria-label={`All ${dock.project} chats`}
                title={`All ${dock.project} chats`}
                {...stylex.props(controls.button, controls.iconButton)}
                onClick={() => setDockList(true)}>
                <Icon name="back" />
              </Button>
              <div {...stylex.props(styles.dockHeading)}>
                <h1 {...stylex.props(styles.dockTitle, controls.truncate)}>{conversationTitle}</h1>
                <p title={contextLabel} {...stylex.props(styles.small, controls.truncate)}>
                  {state.selected ? contextLabel : `In ${dock.project}`}
                </p>
              </div>
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
            {body}
          </main>
        )}
      </div>
    );
  }
  return (
    <div
      data-chat-find-owner={JSON.stringify([controller.backendId, state.selected])}
      onKeyDown={(event) => handleChatFindKeyDown(event, controller, findInput)}
      {...stylex.props(workbench.page, styles.page)}>
      <div {...stylex.props(styles.workspace, !compact && styles.expandedWorkspace)}>
        {!compact && sidebar}
        <main aria-label="Agent workspace" {...stylex.props(styles.content)}>
          {findBar}
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
            {/* Breadcrumb: the chat's project, then the chat. Folder and model are in its title. */}
            <div title={state.selected ? contextLabel : undefined} {...stylex.props(styles.crumbs)}>
              {state.selected && selectedFolder && (
                <>
                  <span
                    aria-hidden="true"
                    data-initials={projectInitials(selectedFolder)}
                    {...stylex.props(projectTiles.tile, projectTiles.silver, styles.crumbTile)}
                  />
                  <span {...stylex.props(styles.crumbProject, controls.truncate)}>
                    {selectedFolder}
                  </span>
                  <span aria-hidden="true" {...stylex.props(styles.crumbSeparator)}>
                    /
                  </span>
                </>
              )}
              <h1
                {...stylex.props(
                  styles.title,
                  controls.truncate,
                  !state.selected && !compact && controls.hidden,
                )}>
                {conversationTitle}
              </h1>
            </div>
            <div {...stylex.props(controls.row)}>
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
          </header>
          {body}
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
  dockHeader: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    padding: '10px 12px',
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
  },
  dockHeading: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
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
  connection: {
    textTransform: 'capitalize',
    color: colors.secondary,
    fontSize: type.small,
    flex: 1,
  },
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
  crumbs: { display: 'flex', alignItems: 'center', gap: space.sm, minWidth: 0 },
  crumbTile: { width: 20, height: 20, borderRadius: 5, fontSize: 9 },
  crumbProject: { flexShrink: 1, maxWidth: 200, color: colors.secondary, fontSize: type.body },
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
  folderTile: { width: 22, height: 22, borderRadius: 6, fontSize: 10 },
  caret: { color: colors.muted },
  localDot: { width: 7, height: 7, borderRadius: '50%', backgroundColor: syntax.string },
  composeContext: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minWidth: 0,
    marginRight: 'auto',
  },
  folderChoice: {
    maxWidth: 170,
    minWidth: 0,
    height: 30,
    gap: space.sm,
    padding: '0 10px 0 4px',
    borderRadius: radius.row,
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
  modelChoice: { maxWidth: 220, minWidth: 0 },
  effortChoice: { flexShrink: 0 },
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
