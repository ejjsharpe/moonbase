import { join } from 'node:path';
import {
  clipboard,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  net,
  protocol,
  shell,
} from 'electron';
import { Context, Effect, Layer, Option } from 'effect';
import { isWorkspaceError } from '@moonbase/contracts/workspace-errors';
import { StartupError } from './startup-errors.ts';
import { WorkspaceService } from '@moonbase/contracts/services';
import { readInstallationId, WorkspaceRecoveryLive } from '@moonbase/workspace';
import { installAppMenu } from './app-menu.ts';
import { serveAppProtocol } from './app-protocol.ts';
import { makeChatBackends } from './chat/chat-backends.ts';
import { makeChatDocuments } from './chat/chat-document.ts';
import type { ChatConfiguration } from './chat/config.ts';
import { RemoteHost, RemoteHostLive } from './chat/remote.ts';
import { findDaemonCommand } from './daemon/daemon-command.ts';
import { findDaemonDirectory } from './daemon/daemon-files.ts';
import { LocalDaemon, LocalDaemonLive } from './daemon/local-daemon.ts';
import { restartDaemon } from './daemon/restart-daemon.ts';
import { createDaemonWorkspaceHost } from './daemon/workspace-host.ts';
import { makeDocumentHandlers } from './ipc/document-handlers.ts';
import { EditorApprovals } from './ipc/editor-approvals.ts';
import { createTrustedDocumentCheck, installIpcConnect } from './ipc/ipc-connect.ts';
import { IpcServer, makeIpcServer } from './ipc/ipc-server.ts';
import { appURL, MainWindow } from './main-window.ts';
import { makeNativeActions } from './native-actions.ts';
import { createFileRequestIds } from './request-ids.ts';
import type { TestHooks } from './test-hooks.ts';
import { WindowLifecycle } from './window-lifecycle.ts';

export type DesktopServicesOptions = {
  userData: string;
  /** Where main's bundle is: its preload and renderer sit beside it. */
  bundleDirectory: string;
  packaged: boolean;
  /** The packaged daemon bundle's build identifier, or `development`. */
  daemonBuild: string;
  chatConfiguration: ChatConfiguration | null;
  hooks: TestHooks;
};

/**
 * What the window's document reaches through main, in the order Quit releases it backwards: the
 * profile's local daemon, the remote host, the recovery store, the chat targets, the IPC server and
 * its documents, then the `moonbase:` protocol, the connect handler and the menu.
 */
export const DesktopServicesLive = (options: DesktopServicesOptions) => {
  const { userData, hooks } = options;
  const openUrl = (url: string) => shell.openExternal(url);
  // Files, Git, search and local chat are served by the profile's daemon, which outlives the app;
  // main finds or starts it on demand. This process keeps only this installation's recovery store
  // (drafts and editor state), so the window opens and drafts are kept without the daemon.
  const daemonDirectory = findDaemonDirectory(userData);
  const localDaemon = LocalDaemonLive({
    directory: daemonDirectory,
    // Tests of an unpackaged app start the daemon's faux entry instead; a packaged app never does.
    command:
      hooks.daemonCommand?.(daemonDirectory) ??
      findDaemonCommand(
        {
          packaged: options.packaged,
          resourcesPath: process.resourcesPath,
          bundleDirectory: options.bundleDirectory,
          build: options.daemonBuild,
        },
        daemonDirectory,
        process.env,
      ),
    openUrl,
  });
  return Layer.effect(
    IpcServer,
    Effect.gen(function* () {
      const window = yield* MainWindow;
      const lifecycle = yield* WindowLifecycle;
      const local = yield* LocalDaemon;
      const remote = Option.getOrNull(yield* RemoteHost);
      // The recovery store keeps this installation's identity to the daemon's file host.
      const workspaceData = join(userData, 'workspace-v1');
      const installationId = yield* Effect.try({
        try: () => readInstallationId(workspaceData),
        catch: (error) =>
          isWorkspaceError(error) ? error : new StartupError({ problem: 'recovery' }),
      });
      const host = createDaemonWorkspaceHost(local);
      const workspace = Context.get(
        yield* Layer.build(
          WorkspaceRecoveryLive({ dataDirectory: workspaceData, installationId }, host),
        ),
        WorkspaceService,
      );
      const native = yield* makeNativeActions({
        window,
        dialog,
        clipboard,
        shell,
        // Picker and clipboard paths are native; a drop's paths come from the renderer (webUtils),
        // so the daemon's reserved-path check on every import is the authority.
        capture: (input) =>
          host.captureImports(input).pipe(Effect.map(({ references }) => references)),
        // Releasing never starts a daemon: references of one that is not running expire on their own.
        release: (input) =>
          Effect.flatMap(Effect.zip(local.peek, local.isRunning), ([backend, running]) =>
            backend && running ? backend.workspace.releaseImports(input) : Effect.void,
          ),
      });
      const approvals = new EditorApprovals();
      const backends = makeChatBackends({
        local,
        remote,
        installationId,
        requestIds: createFileRequestIds(join(workspaceData, 'chat-requests.json')),
        adoptCheckout: (target) => approvals.adoptCheckout(target),
        pickFolder: native.chooseFolder,
      });
      const documents = yield* makeChatDocuments(backends, { isClosing: lifecycle.isClosing });
      const ipc = yield* makeIpcServer(
        makeDocumentHandlers({
          editor: {
            workspace,
            native,
            approvals,
            // Reveal in Finder applies only to files on this Mac, which are the local daemon's.
            localHostId: local.session.pipe(
              Effect.map((session) => session.host.hostId),
              Effect.orElseSucceed(() => undefined),
            ),
            reportCleanup: lifecycle.reportCleanup,
          },
          chat: {
            backends,
            documents,
            transcript: {
              writeText: async (text) => {
                await clipboard.writeText(text);
              },
              openExternal: openUrl,
            },
          },
          lifecycle,
          ...(hooks.interception ? { intercept: hooks.interception } : {}),
        }),
      );
      // Once Quit is agreed, before it waits for a document release or the IPC server's requests,
      // which may wait for a picker to be answered: the picker must be in front of the user.
      yield* lifecycle.addQuitStep(native.surfacePickers);
      yield* serveAppProtocol({
        protocol,
        net,
        rendererRoot: join(options.bundleDirectory, 'renderer'),
        findImages: documents.findImages,
      });
      yield* installIpcConnect({
        ipcMain,
        isTrusted: createTrustedDocumentCheck(window, appURL),
        connect: ipc.connect,
        openChannel: () => new MessageChannelMain(),
      });
      yield* installAppMenu({
        Menu,
        window,
        restart: restartDaemon({ daemon: local, dialog, window }),
      });
      // The editor loads at once; local chat joins this first acquisition, or retries it on failure.
      yield* Effect.forkScoped(Effect.ignore(backends.getContext('local')));
      return ipc;
    }),
  ).pipe(
    Layer.provide(RemoteHostLive(options.chatConfiguration, openUrl)),
    // Built first, so the daemon's clients, however late they are bound, are released last: the
    // recovery store and the documents' imports still reach the daemon as Quit releases them.
    Layer.provide(localDaemon),
  );
};
