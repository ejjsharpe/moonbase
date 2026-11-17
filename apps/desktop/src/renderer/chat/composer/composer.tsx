import { useSyncExternalStore } from 'react';
import { Effect } from 'effect';
import { useAtomValue } from '@effect/atom-react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { Icon } from '@moonbase/ui/icons';
import { colors, layout, radius, shadow, space, type } from '@moonbase/ui/tokens.stylex';
import {
  composerAtoms,
  findComposerPlace,
  findMentionClash,
  findSelectedChat,
  isMessageFor,
  readChoices,
  type ChatComposer,
  type ChatController,
  type ChatState,
} from '@moonbase/application/chat';
import type { DesktopRunner } from '../../shell/desktop-application.ts';
import { ModelPicker } from '../model-picker.tsx';
import type { ChatFolderProject } from '../folder-picker.tsx';
import { effortLabels, readModelChoice } from '../model-choice.ts';
import { focusMessage, isBusy, readOpenSettled, settleOpenChat } from '../open-chat.ts';
import type { ChatHosts } from '../chat-view.tsx';
import { MessageInput } from './message-input.tsx';
import { NewChatPlace } from './new-chat-place.tsx';
import {
  listChatCommands,
  removeCommandLine,
  resolveCommandLine,
  type ChatCommand,
  type ChatCommandOption,
} from './commands.ts';

const noSubscription = () => () => {};
const noProviders = () => null;

/**
 * The composer: the draft and its commands, a new chat's folder, model and host, Stop and Send,
 * and the one message the chat's composer shows where it applies. Its choices and messages live in
 * the chat's composer, so they outlive this view.
 */
export function Composer({
  controller,
  composer,
  runner,
  state,
  dockProject,
  dockCwd,
  hosts,
  folderProjects = [],
  recentFolders,
  chooseFolder,
  createWorktree,
  setUpProviders,
}: {
  controller: ChatController;
  composer: ChatComposer;
  runner: DesktopRunner;
  state: ChatState;
  /** The project whose dock this is, if it is one, and its root. */
  dockProject?: string;
  dockCwd?: string;
  hosts?: ChatHosts;
  folderProjects?: readonly ChatFolderProject[];
  recentFolders?: () => Promise<readonly string[]>;
  chooseFolder?: () => Promise<string | null>;
  createWorktree?: (root: string, branch: string, requestId: string) => Promise<string>;
  setUpProviders?: () => void;
}) {
  const composerState = useAtomValue(composerAtoms.state(composer));
  const providerState = useSyncExternalStore(
    controller.providers?.subscribe ?? noSubscription,
    controller.providers?.getSnapshot ?? noProviders,
  );
  // A remote host's chats use its folders, never this Mac's: no picker, editor projects,
  // worktrees or dock folder apply to them.
  const remote = state.remote,
    connected = state.ready,
    busy = (id: string) => isBusy(state, id);
  const place = findComposerPlace(dockCwd, remote);
  const { cwd, newWorktree } = readChoices(composerState, place),
    creatingWorktree = composerState.creatingWorktree;
  const openChat = state.selected?.conversationId ?? '';
  // The one message the composer shows, where it applies: this chat, this view, this draft.
  const message = isMessageFor(composerState.message, {
    chat: openChat,
    place: place.key,
    draft: state.draft,
  })
    ? composerState.message
    : null;
  const choice = readModelChoice(providerState, state.modelPreference);
  const { models, entry, effort, effortUnavailable, selection } = choice;
  const run = state.snapshot?.run;
  const choose = (change: Parameters<ChatComposer['choose']>[1]) =>
    runner.runSync(composer.choose(place, change));
  const setFolderError = (text: string | null) =>
    runner.runSync(
      text
        ? composer.report({ chat: '', place: place.key, text })
        : composer.dismiss({ chat: '', place: place.key }),
    );
  const chooseModel = (value: string) => {
    const model = models.find((item) => item.value === value);
    if (model)
      controller.setModelPreference({
        model: model.model,
        ...(model.defaultReasoningEffort ? { reasoningEffort: model.defaultReasoningEffort } : {}),
      });
  };
  const chooseEffort = (value: string) => {
    const chosen = entry?.reasoningEfforts?.find((item) => item === value);
    if (entry && chosen)
      controller.setModelPreference({ model: entry.model, reasoningEffort: chosen });
  };
  const tools = remote ? 'Tools on the host' : 'Local tools';
  let toolNotice =
    state.selected || cwd
      ? `${tools} can access files outside the working folder.`
      : `Runs in a new empty folder. ${tools} are not sandboxed.`;
  if (!state.selected && !models.length)
    toolNotice = `Set up a provider to send. ${tools} are not sandboxed.`;
  const choosing = !state.selected && !busy('send') && !creatingWorktree;
  // A new worktree is made only when the first message is sent, so an unsent chat leaves no trace.
  // A project without Git has no worktrees to make.
  const worktreeChoice =
    !state.selected &&
    !remote &&
    !!createWorktree &&
    !!cwd &&
    !folderProjects.some((project) => project.root === cwd && project.branch === undefined);
  const settled = readOpenSettled(state);
  const commands = listChatCommands({
    selected: !!state.selected,
    running: !!run && connected && !busy('stop') && !state.storageError,
    settled,
    models: choosing
      ? models.map((model) => ({
          value: model.value,
          label: model.label,
          current: model.value === (entry?.value ?? ''),
        }))
      : [],
    efforts: choosing
      ? (entry?.reasoningEfforts ?? []).map((value) => ({
          value,
          label: effortLabels[value],
          current: !effortUnavailable && value === effort,
        }))
      : [],
    // The lines after `/new` start the new chat's draft; the open chat's is left empty.
    newChat: () =>
      void runner
        .run(
          composer.startNewChat(
            removeCommandLine(state.draft),
            state.mentions,
            findSelectedChat(state)?.cwd,
          ),
        )
        .then((started) => started && focusMessage()),
    stop: () => void controller.stop(),
    settle: () => settleOpenChat(controller, state, true),
    unsettle: () => settleOpenChat(controller, state, false),
    clearDraft: () => controller.setDraft(''),
    chooseModel,
    chooseEffort,
  });
  // A command consumes its line before it runs, so `/clear` starts from the rest; `/new` takes the
  // rest to the new chat itself.
  const runCommand = (command: ChatCommand, option?: ChatCommandOption) => {
    runner.runSync(composer.dismiss({ chat: openChat, place: place.key }));
    if (command.name !== 'new') controller.setDraft(removeCommandLine(state.draft), state.mentions);
    command.run(option);
  };
  const typedCommand = resolveCommandLine(state.draft, commands);
  const browse = !remote ? chooseFolder : undefined;
  const sendDisabled = typedCommand
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
      );
  return (
    <div {...stylex.props(styles.area, !state.selected && styles.starter)}>
      {!state.selected && (
        <h2 {...stylex.props(styles.starterHeading)}>
          {dockProject ? `What should we work on in ${dockProject}?` : 'What should we work on?'}
        </h2>
      )}
      {message && (
        <p role="alert" {...stylex.props(styles.warning)}>
          {message.text}
        </p>
      )}
      {!state.selected &&
        state.modelPreference &&
        providerState?.status &&
        (!entry || effortUnavailable) && (
          <p role="status" {...stylex.props(styles.warning)}>
            {!entry
              ? `Your saved model (${state.modelPreference.model.modelId}) is unavailable. Choose another model to send.`
              : 'Your saved reasoning effort is unavailable for this model. Choose another effort to send.'}
          </p>
        )}
      <form
        {...stylex.props(styles.composer, !state.selected && styles.starterComposer)}
        onSubmit={(event) => {
          event.preventDefault();
          if (typedCommand) {
            if ('error' in typedCommand)
              runner.runSync(
                composer.report({ chat: openChat, draft: state.draft, text: typedCommand.error }),
              );
            else runCommand(typedCommand.command, typedCommand.option);
            return;
          }
          runner.runSync(
            composer.send(place, {
              ...(selection ? { selection } : {}),
              ...(worktreeChoice
                ? {
                    createWorktree: (root: string, branch: string, requestId: string) =>
                      Effect.tryPromise({
                        try: () => createWorktree!(root, branch, requestId),
                        catch: (error) => error,
                      }),
                  }
                : {}),
            }),
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
            searchable={connected && (!!state.selected || (!!cwd && !creatingWorktree))}
            cwd={!state.selected && cwd ? cwd : undefined}
            onMention={
              !state.selected && cwd
                ? (path) => runner.runSync(composer.noteMentions([path], cwd))
                : undefined
            }
            refuseMention={
              !state.selected && cwd
                ? (path) => findMentionClash(composerState.folders, state, path, cwd)
                : undefined
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
        <div {...stylex.props(controls.row, styles.actions)}>
          {!state.selected && (
            <NewChatPlace
              state={state}
              cwd={cwd}
              newWorktree={newWorktree}
              worktreeChoice={worktreeChoice}
              disabled={busy('send') || creatingWorktree}
              folderProjects={folderProjects}
              recentFolders={recentFolders}
              hosts={hosts}
              inDock={dockProject !== undefined}
              chooseFolder={(folder) => {
                setFolderError(null);
                if (folder !== cwd) choose({ cwd: folder, newWorktree: false });
              }}
              chooseNoProject={() => {
                choose({ cwd: '', newWorktree: false });
                setFolderError(null);
              }}
              chooseWorktree={(value) => choose({ newWorktree: value })}
              browse={
                browse &&
                (() => {
                  setFolderError(null);
                  void browse()
                    .then((folder) => {
                      if (folder) choose({ cwd: folder, newWorktree: false });
                    })
                    .catch(() =>
                      setFolderError(
                        'The folder could not be approved. Choose an existing working folder again.',
                      ),
                    );
                })
              }
            />
          )}
          <div {...stylex.props(controls.row, styles.modelActions)}>
            {!state.selected ? (
              <div {...stylex.props(styles.modelChoice)}>
                <ModelPicker
                  providers={
                    providerState?.status?.providers.filter((provider) => provider.configured) ?? []
                  }
                  model={entry?.model ?? choice.preference?.model}
                  effort={effort}
                  effortAvailable={!effortUnavailable}
                  effortLabels={effortLabels}
                  chooseModel={(model) => chooseModel(JSON.stringify(model))}
                  chooseEffort={chooseEffort}
                  setUpProviders={setUpProviders}
                  disabled={(!models.length && !setUpProviders) || busy('send')}
                />
              </div>
            ) : (
              <span {...stylex.props(styles.small, controls.truncate)}>
                {state.snapshot?.conversation.model}
                {state.snapshot?.conversation.reasoningEffort
                  ? ` · ${effortLabels[state.snapshot.conversation.reasoningEffort]}`
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
              disabled={sendDisabled}>
              <Icon name="send" />
            </Button>
          </div>
        </div>
      </form>
      <div {...stylex.props(styles.help)}>
        <span>{toolNotice}</span>
        <span
          title={`${new TextEncoder().encode(state.draft).length.toLocaleString()} / 32,768 bytes`}>
          ⇧ Enter for a new line
        </span>
      </div>
    </div>
  );
}

const styles = stylex.create({
  area: {
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
  small: {
    color: colors.secondary,
    fontSize: type.small,
    lineHeight: 1.6,
    margin: '4px 0',
    overflowWrap: 'anywhere',
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
  starterComposer: { boxShadow: shadow.raised, padding: '16px 10px 10px 16px' },
  actions: { minHeight: 32, justifyContent: 'flex-end', flexWrap: 'wrap', gap: space.sm },
  modelActions: { marginLeft: 'auto', minWidth: 0, maxWidth: '100%', flexWrap: 'nowrap' },
  modelChoice: { minWidth: 0 },
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
  help: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: space.sm,
    padding: '10px 8px',
    color: colors.muted,
    fontSize: type.caption,
  },
});
