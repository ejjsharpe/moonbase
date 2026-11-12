import { join } from 'node:path';
import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime } from 'effect';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import {
  LocalHostLive,
  LocalPiControl,
  LocalPiRuntimeLive,
  type LocalPiRuntimeConfiguration,
} from '@moonbase/chat-runtime';
import {
  createCredentialStore,
  createKeyEncryption,
  type CredentialKeySource,
} from '@moonbase/chat-runtime/credentials';
import { WorkspaceFolders, WorkspaceHostLive, type ChatFolders } from '@moonbase/workspace';
import { WorkspaceHostService, type WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import {
  createFolderApprovals,
  createRootFolders,
  withCheckoutFolders,
} from '@moonbase/daemon-protocol/folders';
import type { DaemonSettings } from '@moonbase/chat-runtime/host-configuration';
import { createLocalModels } from '@moonbase/chat-runtime/local-models';
import { ProviderSetupChanges, ProviderSetupLive } from '@moonbase/chat-runtime/providers';
import {
  hostDaemonCapabilities,
  localDaemonCapabilities,
  makeDaemonClient,
  makeWorkspaceClient,
  serveChat,
} from '@moonbase/daemon-protocol/server';
import type { ClaudeCodeSubscription } from '@moonbase/chat-runtime/claude-code';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import type { ChatClient, ChatCreationSettings, ChatSession } from '@moonbase/contracts/chat';
import type { FolderApprovals } from '@moonbase/contracts/daemon';
import { chatHostVersion, chatProtocolVersion } from '@moonbase/contracts/host';
import { ApplicationError } from '@moonbase/contracts/errors';
import { daemonErrorReasons } from '@moonbase/contracts/daemon';
import {
  openPrivateDirectory,
  preparePrivateFile,
  readIdentity,
  readSettings,
  readToken,
  removeEndpoint,
  writeEndpoint,
} from './data-directory.ts';
import { DaemonFailure, describeFailure } from './failure.ts';
import { createIdleMonitor, systemClock, type IdleClock, type IdleMonitor } from './idle.ts';
import { acquireDaemonLock } from './lock.ts';
import { openDaemonLog, type DaemonLog } from './log.ts';
import { closeWorkspace, createRootPolicy } from './workspace.ts';
import { createChatFolders } from './chat-folders.ts';

/** What an entry point adds to a daemon in either mode. */
export type DaemonProviders = {
  /** The key that encrypts the daemon's provider credentials. */
  keySource: CredentialKeySource;
  /** Adds providers to the local catalog; returns the Claude Code subscription if it added one. */
  installProviders?(models: MutableModels): ClaudeCodeSubscription | undefined;
  /** Replaces the runtime's coding tools; test entries install controlled ones. */
  registry?: LocalPiRuntimeConfiguration['registry'];
};
export type DaemonOptions = {
  /** The absolute data directory; everything else is read from files inside it. */
  directory: string;
  providers(settings: DaemonSettings, session: ChatSession): DaemonProviders;
  /** Aborting it shuts the daemon down cleanly. */
  signal: AbortSignal;
  /** Called once with the JSON `ready` line. */
  ready(line: string): void;
  /** Closes Claude Code's warm workers after the runtime closes. */
  closeClaudeCode(): Promise<void>;
  clock?: IdleClock;
  /** A local daemon exits after this long unused; 5 minutes. */
  idleMs?: number;
  /** How often an otherwise unused local daemon checks for active work; 30 seconds. */
  pollMs?: number;
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
  /** How long shutdown waits for the workspace to close before going on without it; 5 seconds. */
  workspaceCloseMs?: number;
  /** Identifies this daemon's code in `endpoint.json`, so a client can tell an outdated one. */
  build?: string;
  /** Wraps the chat client the daemon serves; test entries count and hold requests with it. */
  wrapChat?(client: ChatClient): ChatClient;
};
export type DaemonExit = 'stopped' | 'idle';

/**
 * Runs one daemon until `signal` aborts or, in local mode, it is idle. It takes the directory's
 * lock before opening the store, serves the runtime on 127.0.0.1, writes `endpoint.json` while
 * listening, and on the way out stops admitting, closes the server, workspace and runtime, closes
 * Claude Code's workers and removes `endpoint.json`.
 */
export async function runDaemon(options: DaemonOptions): Promise<DaemonExit> {
  const exit = await Effect.runPromiseExit(Effect.scoped(runDaemonScoped(options)));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** Runs a promise, failing with whatever it rejects with. */
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });

const runDaemonScoped = (options: DaemonOptions) =>
  Effect.gen(function* () {
    const directory = yield* attempt(() => openPrivateDirectory(options.directory));
    yield* Effect.acquireRelease(
      attempt(() => acquireDaemonLock(directory)),
      (lock) => Effect.sync(() => lock.release()),
    );
    // An endpoint left by a daemon that crashed names a port nothing serves.
    yield* attempt(() => removeEndpoint(directory));
    const log = yield* Effect.acquireRelease(
      attempt(() => openDaemonLog(directory)),
      (log) => Effect.sync(() => log.close()),
    );
    const exit = yield* Effect.scoped(serveDaemon(options, directory, log)).pipe(
      Effect.tapCause((cause) =>
        Effect.sync(() => log.write({ event: 'failed', ...describeFailure(Cause.squash(cause)) })),
      ),
    );
    log.write({ event: 'stopped', reason: exit });
    return exit;
  });

/**
 * Serves until stopped. Each stage releases when the scope closes, in reverse: the server, the
 * idle monitor, the workspace, the runtime, then Claude Code's workers and `endpoint.json`.
 */
const serveDaemon = (options: DaemonOptions, directory: string, log: DaemonLog) =>
  Effect.gen(function* () {
    const settings = yield* attempt(() => readSettings(directory)),
      session = yield* attempt(() => readIdentity(directory)),
      token = yield* attempt(() => readToken(directory));
    log.write({
      event: 'starting',
      mode: settings.mode,
      pid: process.pid,
      version: chatHostVersion,
    });
    const databasePath = join(directory, 'chat.sqlite');
    // SQLite gives its WAL files the store's mode, so the store starts private.
    yield* attempt(() => preparePrivateFile(databasePath));

    yield* Effect.addFinalizer(() => attempt(() => removeEndpoint(directory)).pipe(Effect.orDie));
    // Claude Code's warm workers close after the runtime, so a turn finishing during shutdown
    // can't leave one cached behind it.
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => options.closeClaudeCode().catch(() => {})),
    );

    const stop = createStop();
    const onAbort = () => stop.request('stopped');
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }),
      () => Effect.sync(() => options.signal.removeEventListener('abort', onAbort)),
    );

    const ripgrep = options.ripgrepExecutable
      ? { ripgrepExecutable: options.ripgrepExecutable }
      : {};
    // Swapped for the open workspace while it is open, so chats never ask a closed one.
    let workspace: Workspace = noWorkspace;
    const providers = options.providers(settings, session);
    // A key file is checked before serving; the Keychain is read at the first sign-in.
    if (settings.credentialKey?.source === 'file')
      yield* attempt(() => checkKeyFile(providers.keySource));
    // A host's roots are checked once, so a root replaced later approves nothing.
    const approvedFolders =
      settings.mode === 'host'
        ? yield* attempt(() =>
            createRootFolders(settings.approvedRoots, {
              reserved: [
                directory,
                ...(settings.credentialKey?.source === 'file' ? [settings.credentialKey.path] : []),
              ],
            }).catch((error: unknown) => {
              throw ApplicationError.is(error)
                ? new DaemonFailure(error.code, error.message)
                : error;
            }),
          )
        : createFolderApprovals(join(directory, 'approved-folders.json'));
    // A local daemon's chats may also use the editor's checkouts and their worktrees, once the
    // workspace is open. A host's chats stay in its roots, which already hold every checkout.
    const folders =
      settings.mode === 'host'
        ? approvedFolders
        : withCheckoutFolders(approvedFolders, { has: (path) => workspace.hasFolder(path) });

    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        ManagedRuntime.make(
          composeRuntime(directory, providers, folders, session, databasePath, ripgrep),
        ),
      ),
      (runtime) => attempt(() => runtime.dispose()).pipe(Effect.orDie),
    );
    const { control, providerChanges } = yield* attempt(() =>
      runtime.runPromise(
        Effect.gen(function* () {
          return { control: yield* LocalPiControl, providerChanges: yield* ProviderSetupChanges };
        }),
      ),
    );
    // Stopping refuses new work at once; the server, workspace and runtime then close in order.
    stop.onRequest(() => control.setAdmissionsOpen(false));

    const opened = yield* Effect.acquireRelease(
      attempt(() =>
        openWorkspace(
          approvedFolders,
          settings.mode === 'host'
            ? undefined
            : createChatFolders(makeChatClient(runtime), makeDaemonClient(runtime)),
        ),
      ),
      (opened) =>
        Effect.promise(() => {
          workspace = noWorkspace;
          return closeWorkspace(opened.dispose, {
            deadlineMs: options.workspaceCloseMs ?? 5_000,
            log,
          });
        }),
    );
    workspace = opened;

    // A host serves remote clients on its configured port and never idles out.
    const idle =
      settings.mode === 'host'
        ? undefined
        : yield* Effect.acquireRelease(
            Effect.sync(() =>
              createIdleMonitor({
                idleMs: options.idleMs ?? 5 * 60_000,
                pollMs: options.pollMs ?? 30_000,
                clock: options.clock ?? systemClock,
                hasActiveWork: () => runtime.runPromise(control.hasActiveWork()),
                onIdle: () => stop.request('idle'),
              }),
            ),
            (idle) => Effect.sync(() => idle.stop()),
          );
    if (idle) stop.onRequest(() => idle.stop());

    // A daemon told to stop while starting never listens or announces itself.
    if (stop.reason) return stop.reason;
    const server = yield* serveChat(
      { host: session.host, token, port: settings.mode === 'host' ? settings.port : 0 },
      (options.wrapChat ?? ((client: ChatClient) => client))(makeChatClient(runtime)),
      makeDaemonClient(runtime),
      settings.mode === 'host' ? hostDaemonCapabilities : localDaemonCapabilities,
      {
        // The WebSocket pushes provider setup changes beside chat and chat list watches. A
        // connected client keeps a local daemon running, and so do its watches, which close
        // with it.
        sources: {
          subscribeProviderSetup: (listener) => providerChanges.subscribe(listener),
          ...(idle ? { trackConnection: () => countUse(idle) } : {}),
        },
        // Once stopping, new requests are refused; a local daemon counts each request as use
        // until it is answered.
        admit: () => {
          if (stop.reason)
            throw new ApplicationError({ code: 'Unavailable', message: 'The daemon is stopping.' });
          return idle ? countUse(idle) : () => {};
        },
        // Without a host the daemon advertises no workspace.
        ...(opened.host ? { workspace: makeWorkspaceClient(opened.host) } : {}),
      },
    );
    const port = Number(new URL(server.origin).port);
    if (!stop.reason)
      yield* attempt(() =>
        writeEndpoint(directory, {
          port,
          pid: process.pid,
          version: chatHostVersion,
          protocol: chatProtocolVersion,
          build: options.build ?? 'development',
        }),
      );
    if (!stop.reason) {
      log.write({ event: 'ready', port });
      options.ready(JSON.stringify({ event: 'ready', host: session.host, port }));
    }
    const reason = yield* Deferred.await(stop.requested);
    log.write({ event: 'stopping', reason });
    return reason;

    /**
     * Composes the workspace file host on macOS, with the data in `workspace/`, this daemon's host
     * ID and the root policy of its mode. A host that can't be composed (no helper, an unqualified
     * runtime, an unusable store) is logged by code and left out: chats are unaffected. Disposing
     * cancels its helper process groups and waits for them.
     */
    async function openWorkspace(
      folders: FolderApprovals,
      chats: ChatFolders | undefined,
    ): Promise<Workspace> {
      if (process.platform !== 'darwin' || stop.reason) return noWorkspace;
      if (!options.filesystemHelper) {
        log.write({ event: 'workspace', reason: 'no-helper' });
        return noWorkspace;
      }
      let runtime:
        | ManagedRuntime.ManagedRuntime<WorkspaceHostService | WorkspaceFolders, ApplicationError>
        | undefined;
      try {
        const workspaceDirectory = await openPrivateDirectory(join(directory, 'workspace'));
        const policy = await createRootPolicy(directory, settings, folders);
        runtime = ManagedRuntime.make(
          WorkspaceHostLive({
            dataDirectory: workspaceDirectory,
            hostId: session.host.hostId,
            filesystemHelper: options.filesystemHelper,
            gitExecutable: '/usr/bin/git',
            ...ripgrep,
            // A native source is held to no root policy, so only a local daemon takes imports.
            nativeImports: settings.mode !== 'host',
            ...(chats ? { chats } : {}),
            ...policy,
          }),
        );
        const host = await runtime.runPromise(WorkspaceHostService);
        const checkouts = await runtime.runPromise(WorkspaceFolders);
        log.write({ event: 'workspace', reason: 'ready' });
        const opened = runtime;
        return {
          host,
          hasFolder: (path) => opened.runPromise(checkouts.has(path)),
          dispose: () => opened.dispose(),
        };
      } catch (error) {
        await runtime?.dispose().catch(() => {});
        log.write({ event: 'workspace', reason: 'unavailable', code: describeFailure(error).code });
        return noWorkspace;
      }
    }
  });

/**
 * A stop request: the first one sets `reason`, runs each `onRequest` callback at once (so
 * admissions close before anything else happens) and completes `requested`. A callback added after
 * the request runs immediately.
 */
function createStop() {
  const callbacks: (() => void)[] = [];
  const requested = Deferred.makeUnsafe<DaemonExit>();
  const stop = {
    reason: undefined as DaemonExit | undefined,
    requested,
    request(reason: DaemonExit) {
      if (stop.reason) return;
      stop.reason = reason;
      for (const callback of callbacks) callback();
      Deferred.doneUnsafe(requested, Exit.succeed(reason));
    },
    onRequest(callback: () => void) {
      if (stop.reason) callback();
      else callbacks.push(callback);
    },
  };
  return stop;
}

/** The workspace file host while it is open; a daemon without one has none of these. */
type Workspace = {
  host?: WorkspaceHostServiceShape;
  /** Whether `path` is an approved checkout root, which a local daemon's chats may use. */
  hasFolder(path: string): Promise<boolean>;
  dispose(): Promise<void>;
};
const noWorkspace: Workspace = {
  hasFolder: async () => false,
  dispose: async () => {},
};

/** Counts one use of a local daemon; the function it returns ends it, once. */
function countUse(idle: IdleMonitor) {
  idle.begin();
  let open = true;
  return () => {
    if (open) idle.end();
    open = false;
  };
}

/**
 * Refuses an unsafe key file, or one that holds no key, before the daemon serves. Loading creates
 * nothing; a missing key file is created at the first sign-in.
 */
async function checkKeyFile(keySource: CredentialKeySource) {
  try {
    await keySource.load();
  } catch (error) {
    // The key file's own messages name no path or contents.
    throw ApplicationError.is(error) ? new DaemonFailure(error.code, error.message) : error;
  }
}

/**
 * Composes the runtime both modes serve: local-mode chats with their own folders and models,
 * provider setup and encrypted credentials. Only which folders chats may use differs: those a
 * local client approved, or a host's approved roots.
 */
function composeRuntime(
  directory: string,
  providers: DaemonProviders,
  folders: FolderApprovals,
  session: ChatSession,
  databasePath: string,
  ripgrep: { ripgrepExecutable?: string },
) {
  const credentials = createCredentialStore(
    join(directory, 'credentials'),
    createKeyEncryption(providers.keySource),
  );
  const models = createLocalModels(credentials);
  const claudeCode = providers.installProviders?.(models);
  const chatFolders = join(directory, 'chats');
  // A folder chats may use, still the same directory, may be searched and chatted in.
  const requireApprovedFolder = async (path: string, purpose: string) => {
    if (await folders.has(path)) return;
    if (folders.refusal === 'folder-outside-roots')
      throw new ApplicationError(daemonErrorReasons['folder-outside-roots']);
    throw new ApplicationError({
      code: 'Unauthorized',
      message: `Approve this working folder before ${purpose}.`,
    });
  };
  const runtime = LocalPiRuntimeLive({
    ...session,
    databasePath,
    chatFolders,
    models,
    ...(providers.registry ? { registry: providers.registry } : {}),
    approveCreation: async (creation: ChatCreationSettings) => {
      if (creation.cwd === undefined) return;
      await requireApprovedFolder(creation.cwd, 'creating or retrying a local chat');
      await folders.touch(creation.cwd);
    },
    approveFolder: (cwd: string) => requireApprovedFolder(cwd, 'searching its files'),
    ...ripgrep,
  });
  return Layer.mergeAll(
    LocalHostLive({ host: session.host, folders, chatFolders }).pipe(Layer.provideMerge(runtime)),
    // The daemon never opens a browser: without `openUrl`, clients read sign-in links to open.
    ProviderSetupLive({
      models,
      deviceId: session.host.hostId,
      getCheckProblem: (id, signal) =>
        claudeCode && id === claudeCode.id ? claudeCode.getCheckProblem(signal) : undefined,
    }),
  );
}
