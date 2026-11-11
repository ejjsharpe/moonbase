import { createRegistry, defineExtension, section } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { Context, Effect, Layer, Stream } from 'effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import {
  chatPageSize,
  maximumChatReplyBytes,
  type ChatListUpdate,
  type ChatSession,
  type ChatSummary,
  type ChatTarget,
} from '@moonbase/contracts/chat';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import {
  daemonErrorReasons,
  type FolderApprovals,
  type LocalHostCommand,
  type LocalHostInput,
} from '@moonbase/contracts/daemon';
import { decodeLocalHostInput } from '@moonbase/contracts/daemon-schema';
import {
  ChatService,
  LocalHostService,
  type ChatServiceShape,
  type LocalHostHandlers,
} from '@moonbase/contracts/services';
import { type Host, safeError } from './commands.ts';
import { readOnChange } from '@moonbase/effect/changes';
import { checkChatFolder } from './chat-folders.ts';
import * as V from './validation.ts';
import { openHost } from './resources.ts';
import type { LocalPiRuntimeConfiguration } from './runtime-types.ts';

export type { LocalPiRuntimeConfiguration } from './runtime-types.ts';

/** Privileged shutdown control; it grants no renderer capability. */
export class LocalPiControl extends Context.Service<
  LocalPiControl,
  {
    setAdmissionsOpen(open: boolean): void;
    hasActiveWork(): Effect.Effect<boolean, ApplicationError>;
    /** Clears `ownFolder` once a chat's own folder has become a project where it is. */
    markFolderAsProject(target: ChatTarget): Effect.Effect<void, ApplicationError>;
  }
>()('moonbase/LocalPiControl') {}
function makeChatService(host: Host): ChatServiceShape {
  return {
    getChatHost: (d) => host.run('getChatHost', d, (input) => host.getHost(input)),
    listChats: (d) => host.run('listChats', d, (input) => host.list(input)),
    createChat: (d) => host.run('createChat', d, (input) => host.create(input)),
    getChat: (d) => host.run('getChat', d, (input) => host.snapshot(input.target)),
    getChatHistory: (d) => host.run('getChatHistory', d, (input) => host.getHistory(input)),
    getChatTranscriptContent: (d) =>
      host.run('getChatTranscriptContent', d, (input) => host.getTranscriptContent(input)),
    findChatTranscript: (d) =>
      host.run('findChatTranscript', d, (input) => host.findTranscript(input)),
    getChatHistoryAround: (d) =>
      host.run('getChatHistoryAround', d, (input) => host.getHistoryAround(input)),
    sendChat: (d) => host.run('sendChat', d, (input) => host.send(input)),
    getChatSend: (d) => host.run('getChatSend', d, (input) => host.getSend(input)),
    stopChat: (d) => host.run('stopChat', d, (input) => host.stop(input)),
    settleChat: (d) => host.run('settleChat', d, (input) => host.settle(input)),
    findChatFiles: (d) => host.run('findChatFiles', d, (input) => host.findFiles(input)),
    watch: ({ target }) => host.watch(target),
    watchChatList: (d) =>
      Stream.unwrap(
        Effect.map(
          Effect.try({
            try: () => {
              const input = V.input('listChats', d);
              host.session(input.session);
              return input;
            },
            catch: ApplicationError.fromUnknown,
          }),
          (input) => watchChatListState(host, input.session),
        ),
      ),
  };
}
/**
 * The chat list's first page and the chats past it that changed while watching, read again after
 * each change. Changed chats beyond `chatPageSize`, or past the reply limit, go least recently
 * changed first and count as dropped.
 */
function watchChatListState(
  host: Host,
  session: ChatSession,
): Stream.Stream<ChatListUpdate, ApplicationError> {
  const touched = new Set<string>(),
    // In the order they last changed, least recent first.
    changed = new Map<string, ChatSummary>();
  let dropped = 0;
  return readOnChange(
    (listener) =>
      host.subscribeChatList((conversationIds) => {
        for (const id of conversationIds) touched.add(id);
        listener();
      }),
    async () => {
      const ids = [...touched];
      touched.clear();
      const list = await host.list({ session });
      const listed = new Set(list.conversations.map((row) => row.target.conversationId));
      for (const id of ids) {
        changed.delete(id);
        const row = listed.has(id) ? undefined : await host.listed(session, id);
        if (row) changed.set(id, row);
      }
      for (const id of listed) changed.delete(id);
      const state = () => ({ list, changed: [...changed.values()], dropped, reset: false });
      while (
        changed.size > chatPageSize ||
        (changed.size && Buffer.byteLength(JSON.stringify(state())) > maximumChatReplyBytes)
      ) {
        changed.delete(changed.keys().next().value!);
        dropped++;
      }
      return state();
    },
  );
}
/**
 * Claude Code runs in this process's working directory and tells the model so, but its library
 * offers no way to give it a chat's own; until it does, state the chat's to the model.
 */
const ClaudeCodeWorkingDirectory = defineExtension({
  name: 'moonbase-claude-code-cwd',
  sections: [
    section('working-directory', ({ agent }) =>
      agent.model?.provider === 'claude-code' && agent.cwd
        ? `The working directory is ${agent.cwd}, and tools resolve relative paths against it. Use it instead of any other working directory you are told.`
        : undefined,
    ),
  ],
});

export const LocalPiRuntimeLive = (
  config: LocalPiRuntimeConfiguration,
): Layer.Layer<ChatService | LocalPiControl, ApplicationError> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const registry = config.registry ?? createRegistry();
      if (!config.registry) {
        registry.install(CodingTools);
        registry.install(ClaudeCodeWorkingDirectory);
      }
      const host = yield* openHost({ ...config, registry, mode: 'local' });
      return Context.make(ChatService, makeChatService(host)).pipe(
        Context.add(LocalPiControl, {
          setAdmissionsOpen: (open) => {
            host.admissionsOpen = open;
          },
          hasActiveWork: () =>
            Effect.tryPromise({ try: () => host.hasActiveWork(), catch: safeError }),
          markFolderAsProject: (target) =>
            Effect.tryPromise({
              try: () => host.markFolderAsProject(target),
              catch: (error) => safeError(error, true),
            }),
        }),
      );
    }),
  );

export type LocalHostConfiguration = {
  host: ChatHostTarget;
  folders: FolderApprovals;
  /** Where the runtime makes folders for chats without a project (its `chatFolders`). */
  chatFolders: string;
};
/**
 * A local-mode host's folder approvals and control, over its `LocalPiControl`: folders a local
 * client approved, or a host-mode daemon's approved roots.
 */
export const LocalHostLive = (
  config: LocalHostConfiguration,
): Layer.Layer<LocalHostService, never, LocalPiControl> =>
  Layer.effect(
    LocalHostService,
    Effect.gen(function* () {
      const control = yield* LocalPiControl;
      const failure = (error: unknown) =>
        ApplicationError.is(error)
          ? error
          : new ApplicationError(daemonErrorReasons['folders-unavailable']);
      const handle =
        <K extends LocalHostCommand, A>(
          operation: K,
          run: (input: LocalHostInput<K>) => Effect.Effect<A, ApplicationError>,
        ) =>
        (unknown: LocalHostInput<K>) =>
          Effect.flatMap(
            Effect.try({
              try: () => {
                const input = decodeLocalHostInput(operation, unknown);
                const shape = input as { host?: ChatHostTarget; target?: { host: ChatHostTarget } };
                if (!V.sameHost(shape.host ?? shape.target!.host, config.host))
                  V.fail('Unauthorized', 'Local host request names another host.');
                return input;
              },
              catch: failure,
            }),
            run,
          );
      const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
      return {
        approveFolder: handle('approveFolder', ({ requestId, path, recent }) =>
          promise(async () => {
            const approved = await config.folders
              .approve(path, { recent: recent ?? true })
              .catch((error: unknown) => {
                throw ApplicationError.is(error)
                  ? error
                  : new ApplicationError(daemonErrorReasons['folder-missing']);
              });
            return { requestId, path: approved };
          }),
        ),
        listRecentFolders: handle('listRecentFolders', () =>
          promise(async () => ({ folders: await config.folders.listRecent() })),
        ),
        checkChatFolder: handle('checkChatFolder', ({ path }) =>
          promise(() => checkChatFolder(config.chatFolders, path)),
        ),
        checkApprovedFolder: handle('checkApprovedFolder', ({ path }) =>
          promise(async () => {
            if (!(await config.folders.has(path)))
              throw new ApplicationError(daemonErrorReasons[config.folders.refusal]);
          }),
        ),
        listHostFolders: handle('listHostFolders', () =>
          promise(async () => {
            if (!config.folders.listFolders)
              throw new ApplicationError({
                code: 'Incompatible',
                message: 'This host has no approved roots to list.',
              });
            return { folders: await config.folders.listFolders() };
          }),
        ),
        getActiveWork: handle('getActiveWork', () =>
          Effect.map(control.hasActiveWork(), (active) => ({ active })),
        ),
        // A host-mode daemon's chats run only in its roots, so its own chat folders never
        // become projects.
        markFolderAsProject: handle('markFolderAsProject', ({ requestId, target }) =>
          config.folders.listFolders
            ? Effect.fail(
                new ApplicationError({
                  code: 'Incompatible',
                  message: 'A host’s chats can’t become projects.',
                }),
              )
            : Effect.as(control.markFolderAsProject(target), { requestId }),
        ),
      } satisfies LocalHostHandlers;
    }),
  );
