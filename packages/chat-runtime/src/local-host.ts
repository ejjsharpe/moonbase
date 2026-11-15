import { Effect, Layer } from 'effect';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import type { FolderApprovals, LocalHostCommand, LocalHostInput } from '@moonbase/contracts/daemon';
import {
  LocalHostService,
  type LocalHostHandlers,
  type LocalHostServiceError,
} from '@moonbase/contracts/services';
import { isSameChatHost } from '@moonbase/contracts/chat-validation';
import { UnauthorizedError } from '@moonbase/contracts/errors';
import {
  FolderMissingError,
  FolderRefusedError,
  FoldersUnavailableError,
  isFolderError,
  type FolderError,
} from '@moonbase/contracts/folder-errors';
import { IncompatibleHostError } from '@moonbase/contracts/host-errors';
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
      const failure = (error: unknown): FolderError =>
        isFolderError(error) ? error : new FoldersUnavailableError();
      const handle =
        <K extends LocalHostCommand, A>(
          operation: K,
          run: (input: LocalHostInput<K>) => Effect.Effect<A, LocalHostServiceError>,
        ) =>
        (input: LocalHostInput<K>) =>
          Effect.suspend(() => {
            const shape = input as { host?: ChatHostTarget; target?: { host: ChatHostTarget } };
            return isSameChatHost(shape.host ?? shape.target!.host, config.host)
              ? run(input)
              : Effect.fail(new UnauthorizedError({ operation }));
          });
      const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
      return {
        approveFolder: handle('approveFolder', ({ requestId, path, recent }) =>
          promise(async () => {
            const approved = await config.folders
              .approve(path, { recent: recent ?? true })
              .catch((error: unknown) => {
                throw isFolderError(error) ? error : new FolderMissingError();
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
              throw new FolderRefusedError({ refusal: config.folders.refusal });
          }),
        ),
        listHostFolders: handle('listHostFolders', () => {
          const { listFolders } = config.folders;
          return listFolders
            ? promise(async () => ({ folders: await listFolders() }))
            : Effect.fail(new IncompatibleHostError({ reason: 'no-roots' }));
        }),
        getActiveWork: handle('getActiveWork', () =>
          Effect.map(control.hasActiveWork(), (active) => ({ active })),
        ),
        // A host-mode daemon's chats run only in its roots, so its own chat folders never
        // become projects.
        markFolderAsProject: handle('markFolderAsProject', ({ requestId, target }) =>
          config.folders.listFolders
            ? Effect.fail(new IncompatibleHostError({ reason: 'host-chat-projects' }))
            : Effect.as(control.markFolderAsProject(target), { requestId }),
        ),
      } satisfies LocalHostHandlers;
    }),
  );
