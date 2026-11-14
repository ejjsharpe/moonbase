import { Effect, Layer } from 'effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import {
  daemonErrorReasons,
  type FolderApprovals,
  type LocalHostCommand,
  type LocalHostInput,
} from '@moonbase/contracts/daemon';
import { LocalHostService, type LocalHostHandlers } from '@moonbase/contracts/services';
import { isSameChatHost } from '@moonbase/contracts/chat-validation';
import { fail } from '@moonbase/contracts/errors';
import { checkChatFolder } from './chat-folders.ts';
import { LocalPiControl } from './local-pi-control.ts';

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
        (input: LocalHostInput<K>) =>
          Effect.flatMap(
            Effect.try({
              try: () => {
                const shape = input as { host?: ChatHostTarget; target?: { host: ChatHostTarget } };
                if (!isSameChatHost(shape.host ?? shape.target!.host, config.host))
                  fail('Unauthorized', 'Local host request names another host.');
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
