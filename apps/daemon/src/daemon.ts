import { join } from 'node:path';
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Ref,
  SubscriptionRef,
  type FileSystem,
} from 'effect';
import type { ChildProcessSpawner } from 'effect/process';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import {
  LocalHostLive,
  LocalPiControl,
  LocalPiRuntimeLive,
  type LocalPiRuntimeConfiguration,
} from '@moonbase/chat-runtime';
import {
  makeCredentialStore,
  makeKeyEncryption,
  type CredentialKeySource,
} from '@moonbase/chat-runtime/credentials';
import type { CredentialKeyError } from '@moonbase/contracts/provider-errors';
import { createLocalModels } from '@moonbase/chat-runtime/local-models';
import { ProviderSetupLive } from '@moonbase/chat-runtime/providers';
import {
  hostDaemonCapabilities,
  localDaemonCapabilities,
  serveChat,
} from '@moonbase/daemon-protocol/server';
import type { ClaudeCodeSubscription } from '@moonbase/chat-runtime/claude-code';
import type { ChatCreationSettings, ChatSession } from '@moonbase/contracts/chat';
import {
  ChatService,
  LocalHostService,
  ProviderSetupService,
  type ChatServiceShape,
} from '@moonbase/contracts/services';
import type { FolderApprovals } from '@moonbase/contracts/daemon';
import { chatHostVersion, chatProtocolVersion } from '@moonbase/contracts/host';
import { FolderRefusedError } from '@moonbase/contracts/folder-errors';
import { readDaemonConfig, type DaemonConfig } from './daemon-config.ts';
import type { DaemonSettings } from './daemon-settings.ts';
import { describeFailure } from './daemon-errors.ts';
import { makeDaemonStop, type DaemonExit } from './daemon-stop.ts';
import {
  readIdentity,
  readSettings,
  readToken,
  removeEndpoint,
  writeEndpoint,
} from './data-directory.ts';
import { waitForIdle } from './idle.ts';
import { DaemonJournal, journal } from './journal.ts';
import { acquireDaemonLock } from './lock.ts';
import { openPrivateDirectory, preparePrivateFile } from './private-files.ts';
import { makeChatFolders } from './chat-folders.ts';
import { withCheckoutFolders } from './checkout-folders.ts';
import { makeFolderApprovals } from './folder-approvals.ts';
import { makeRootFolders } from './root-folders.ts';
import { noWorkspace, openWorkspace } from './workspace.ts';

export type { DaemonExit } from './daemon-stop.ts';

/** What an entry point adds to a daemon in either mode. */
export type DaemonProviders = {
  /** Makes the source of the key that encrypts the daemon's provider credentials. */
  keySource: Effect.Effect<
    CredentialKeySource,
    CredentialKeyError,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >;
  /** Adds providers to the local catalog; returns the Claude Code subscription if it added one. */
  installProviders?(models: MutableModels): ClaudeCodeSubscription | undefined;
  /** Replaces the runtime's coding tools; test entries install controlled ones. */
  registry?: LocalPiRuntimeConfiguration['registry'];
};
export type DaemonOptions = {
  providers(settings: DaemonSettings, session: ChatSession): DaemonProviders;
  /** Runs once with the JSON `ready` line. */
  ready(line: string): Effect.Effect<void>;
  /** Closes Claude Code's warm workers after the runtime closes. */
  closeClaudeCode: Effect.Effect<void>;
  /**
   * The Clock a local daemon's idle wait runs on, and nothing else; tests advance a `TestClock`
   * with it, which no process stop timer may run on.
   */
  idleClock?: Clock.Clock;
  /**
   * Absolute ripgrep for both chat file search and the workspace. Without one, each looks for `rg`
   * on PATH; chat search then falls back to Git.
   */
  ripgrepExecutable?: string;
  /**
   * Absolute native filesystem helper of the workspace file host. Without one, or off macOS, the
   * daemon composes no workspace and chats are served as before.
   */
  filesystemHelper?: string;
  /** Identifies this daemon's code in `endpoint.json`, so a client can tell an outdated one. */
  build?: string;
  /** Wraps the chat service the daemon serves; test entries count and hold requests with it. */
  wrapChat?(chat: ChatServiceShape): ChatServiceShape;
};

/**
 * Runs one daemon until it is interrupted (a signal) or, in local mode, it is idle; its config
 * (`daemon-config.ts`) names the data directory. It takes the directory's lock before opening the
 * store, serves the runtime on 127.0.0.1, writes `endpoint.json` while listening, and on the way
 * out stops admitting, closes the workspace, server and runtime, closes Claude Code's workers and
 * removes `endpoint.json`. It journals to `logs/daemon.log` while the lock is held.
 */
export const runDaemon = (options: DaemonOptions) =>
  Effect.gen(function* () {
    const config = yield* readDaemonConfig;
    const directory = yield* openPrivateDirectory(config.directory);
    yield* acquireDaemonLock(directory);
    // An endpoint left by a daemon that crashed names a port nothing serves.
    yield* removeEndpoint(directory);
    return yield* Effect.scoped(serveDaemon(options, config, directory)).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) return journal({ event: 'stopped', reason: exit.value });
        // Interrupted, as a signal does: told to stop.
        if (Cause.hasInterruptsOnly(exit.cause))
          return journal({ event: 'stopped', reason: 'stopped' });
        return journal({ event: 'failed', ...describeFailure(Cause.squash(exit.cause)) });
      }),
      Effect.provide(DaemonJournal(directory)),
    );
  }).pipe(Effect.scoped);

/**
 * Serves until stopped. Each stage releases when the scope closes, in reverse: the stop (which
 * refuses new work at once), the workspace, the server, the idle wait, the runtime, then Claude
 * Code's workers and `endpoint.json`.
 */
const serveDaemon = (options: DaemonOptions, config: DaemonConfig, directory: string) =>
  Effect.gen(function* () {
    const settings = yield* readSettings(directory),
      session = yield* readIdentity(directory),
      token = yield* readToken(directory);
    yield* journal({
      event: 'starting',
      mode: settings.mode,
      pid: process.pid,
      version: chatHostVersion,
    });
    const databasePath = join(directory, 'chat.sqlite');
    // SQLite gives its WAL files the store's mode, so the store starts private.
    yield* preparePrivateFile(databasePath);

    yield* Effect.addFinalizer(() => removeEndpoint(directory));
    // Claude Code's warm workers close after the runtime, so a turn finishing during shutdown
    // can't leave one cached behind it.
    yield* Effect.addFinalizer(() => options.closeClaudeCode);

    const providers = options.providers(settings, session);
    const keySource = yield* providers.keySource;
    // A key file is checked before serving; the Keychain is read at the first sign-in.
    if (settings.credentialKey?.source === 'file') yield* Effect.asVoid(keySource.load);
    // A host's roots are checked once, so a root replaced later approves nothing.
    const approvedFolders =
      settings.mode === 'host'
        ? yield* makeRootFolders(settings.approvedRoots, {
            reserved: [
              directory,
              ...(settings.credentialKey?.source === 'file' ? [settings.credentialKey.path] : []),
            ],
          })
        : yield* makeFolderApprovals(join(directory, 'approved-folders.json'));
    // A local daemon's chats may also use the editor's checkouts and their worktrees, once the
    // workspace is open. A host's chats stay in its roots, which already hold every checkout.
    const workspace = yield* Ref.make(noWorkspace);
    const folders =
      settings.mode === 'host'
        ? approvedFolders
        : withCheckoutFolders(approvedFolders, {
            has: (path) => Effect.flatMap(Ref.get(workspace), (opened) => opened.hasFolder(path)),
          });

    const runtime = yield* Layer.build(
      composeRuntime(directory, providers, keySource, folders, session, databasePath, options),
    );
    const control = Context.get(runtime, LocalPiControl),
      chat = Context.get(runtime, ChatService),
      localHost = Context.get(runtime, LocalHostService),
      providerSetup = Context.get(runtime, ProviderSetupService);

    const stop = yield* makeDaemonStop;
    /** Stops the daemon once: new work is refused at once, then the wait for a stop ends. */
    const requestStop = (reason: DaemonExit, { unused = false } = {}) =>
      Effect.gen(function* () {
        if (!(yield* stop.request(reason, { unused }))) return false;
        yield* control.setAdmissionsOpen(false);
        yield* journal({ event: 'stopping', reason });
        yield* Deferred.succeed(stop.stopped, reason);
        return true;
      });
    const stopping = Effect.map(SubscriptionRef.get(stop.use), (use) => use.stopping);

    const closeWorkspace = yield* openWorkspace({
      current: workspace,
      directory,
      settings,
      hostId: session.host.hostId,
      folders: approvedFolders,
      ...(settings.mode === 'host' ? {} : { chats: makeChatFolders(chat, localHost) }),
      ...(options.filesystemHelper ? { filesystemHelper: options.filesystemHelper } : {}),
      ...(options.ripgrepExecutable ? { ripgrepExecutable: options.ripgrepExecutable } : {}),
      closeDeadline: config.workspaceClose,
    });

    // A host serves remote clients on its configured port and never idles out.
    if (settings.mode === 'local') {
      const idle = waitForIdle(
        stop.use,
        { idle: config.idle, poll: config.poll, hasActiveWork: control.hasActiveWork() },
        requestStop('idle', { unused: true }),
      );
      yield* Effect.forkScoped(
        options.idleClock ? Effect.provideService(idle, Clock.Clock, options.idleClock) : idle,
      );
    }

    const opened = yield* Ref.get(workspace);
    const server = yield* serveChat(
      { host: session.host, token, port: settings.mode === 'host' ? settings.port : 0 },
      {
        chat: options.wrapChat?.(chat) ?? chat,
        daemon: {
          localHost,
          providers: providerSetup,
          capabilities: settings.mode === 'host' ? hostDaemonCapabilities : localDaemonCapabilities,
        },
      },
      {
        // A workspace connection keeps a local daemon running; a request or watch counts as use
        // while it runs, through `admit`.
        trackWorkspaceConnection: stop.hold,
        // A mutation that outlives the workspace's close (a helper stuck past its kill) does not
        // hold the stop: the host journalled it, and the next start reports it.
        closeMs: Duration.toMillis(config.serverClose),
        onCloseTimeout: journal({ event: 'server', reason: 'close-timeout' }),
        // Once stopping, new requests are refused; each request counts as use until it is answered.
        admit: stop.admit,
        // Without a host the daemon advertises no workspace.
        ...(opened.host ? { workspace: opened.host } : {}),
      },
    );
    // Stopping closes the workspace before the server: the server waits for the file host
    // mutations it runs, which end once their helpers are stopped, not when the helpers finish by
    // themselves. Before either, a stop the daemon was not asked for (a signal interrupting it)
    // still refuses new work.
    yield* Effect.addFinalizer(() => closeWorkspace);
    yield* Effect.addFinalizer(() => Effect.asVoid(requestStop('stopped')));
    const port = Number(new URL(server.origin).port);
    if (!(yield* stopping))
      yield* writeEndpoint(directory, {
        port,
        pid: process.pid,
        version: chatHostVersion,
        protocol: chatProtocolVersion,
        build: options.build ?? 'development',
      });
    if (!(yield* stopping)) {
      yield* journal({ event: 'ready', port });
      yield* options.ready(JSON.stringify({ event: 'ready', host: session.host, port }));
    }
    return yield* Deferred.await(stop.stopped);
  });

/**
 * Composes the runtime both modes serve: local-mode chats with their own folders and models,
 * provider setup and encrypted credentials. Only which folders chats may use differs: those a
 * local client approved, or a host's approved roots.
 */
function composeRuntime(
  directory: string,
  providers: DaemonProviders,
  keySource: CredentialKeySource,
  folders: FolderApprovals,
  session: ChatSession,
  databasePath: string,
  { ripgrepExecutable }: Pick<DaemonOptions, 'ripgrepExecutable'>,
) {
  return Layer.unwrap(
    Effect.gen(function* () {
      // Pi's credential store serves in the composed runtime's scope, which closes after the
      // layers built over it.
      const credentials = yield* makeCredentialStore(
        join(directory, 'credentials'),
        yield* makeKeyEncryption(keySource),
      );
      const models = createLocalModels(credentials);
      const claudeCode = providers.installProviders?.(models);
      const chatFolders = join(directory, 'chats');
      // A folder chats may use, still the same directory, may be searched and chatted in.
      const requireApprovedFolder = (path: string, use: FolderRefusedError['use']) =>
        Effect.flatMap(folders.has(path), (approved) =>
          approved
            ? Effect.void
            : Effect.fail(
                new FolderRefusedError(
                  folders.refusal === 'outside-roots'
                    ? { refusal: 'outside-roots' }
                    : { refusal: 'not-approved', use },
                ),
              ),
        );
      const runtime = LocalPiRuntimeLive({
        ...session,
        databasePath,
        chatFolders,
        models,
        ...(providers.registry ? { registry: providers.registry } : {}),
        approveCreation: (creation: ChatCreationSettings) =>
          creation.cwd === undefined
            ? Effect.void
            : Effect.andThen(
                requireApprovedFolder(creation.cwd, 'chat'),
                folders.touch(creation.cwd),
              ),
        approveFolder: (cwd: string) => requireApprovedFolder(cwd, 'search'),
        ...(ripgrepExecutable ? { ripgrepExecutable } : {}),
      });
      return Layer.mergeAll(
        LocalHostLive({ host: session.host, folders, chatFolders }).pipe(
          Layer.provideMerge(runtime),
        ),
        // The daemon never opens a browser: without `openUrl`, clients read sign-in links to open.
        ProviderSetupLive({
          models,
          deviceId: session.host.hostId,
          getCheckProblem: (id, signal) =>
            claudeCode && id === claudeCode.id ? claudeCode.getCheckProblem(signal) : undefined,
        }),
      );
    }),
  );
}
