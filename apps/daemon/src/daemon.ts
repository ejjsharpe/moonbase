import { join } from 'node:path';
import { Effect, Layer, ManagedRuntime } from 'effect';
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
import { WorkspaceHostLive } from '@moonbase/workspace';
import { WorkspaceHostService, type WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { createFolderApprovals, createRootFolders } from '@moonbase/daemon-protocol/folders';
import type { DaemonSettings } from '@moonbase/chat-runtime/host-configuration';
import { createLocalModels } from '@moonbase/chat-runtime/local-models';
import { ProviderSetupChanges, ProviderSetupLive } from '@moonbase/chat-runtime/providers';
import {
  hostDaemonCapabilities,
  localDaemonCapabilities,
  makeDaemonClient,
  serveChat,
  type SocketSources,
} from '@moonbase/daemon-protocol/server';
import type { ClaudeCodeSubscription } from '@moonbase/chat-runtime/claude-code';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import type { ChatClient, ChatCreationSettings, ChatSession } from '@moonbase/contracts/chat';
import type { DaemonClient, FolderApprovals } from '@moonbase/contracts/daemon';
import type { ChatHostCapability } from '@moonbase/contracts/host';
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
import {
  createIdleMonitor,
  systemClock,
  trackClientUse,
  trackDaemonUse,
  type IdleClock,
  type IdleMonitor,
} from './idle.ts';
import { refuseDaemonWhileStopping, refuseWhileStopping } from './admission.ts';
import { acquireDaemonLock } from './lock.ts';
import { openDaemonLog, type DaemonLog } from './log.ts';
import { createRootPolicy, guardWorkspace } from './workspace.ts';

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
  /** Absolute ripgrep for chat file search; otherwise `rg` on PATH, then Git. */
  ripgrepExecutable?: string;
  /**
   * Absolute native filesystem helper of the workspace file host. Without one, or off macOS, the
   * daemon composes no workspace and chats are served as before.
   */
  filesystemHelper?: string;
  /**
   * Receives the running file host, guarded as the wire will serve it: calls count as use, and are
   * refused once the daemon stops. Called once, before the daemon listens; test entries drive the
   * host through it until the wire carries it.
   */
  receiveWorkspace?(host: WorkspaceHostServiceShape): void;
  /** Identifies this daemon's code in `endpoint.json`, so a client can tell an outdated one. */
  build?: string;
  /** Wraps the chat client the daemon serves; test entries count and hold requests with it. */
  wrapChat?(client: ChatClient): ChatClient;
};
export type DaemonExit = 'stopped' | 'idle';

/**
 * Runs one daemon until `signal` aborts or, in local mode, it is idle. It takes the directory's
 * lock before opening the store, serves the runtime on 127.0.0.1, writes `endpoint.json` while
 * listening, and on the way out stops admitting, closes the server and runtime, closes Claude
 * Code's workers and removes `endpoint.json`.
 */
export async function runDaemon(options: DaemonOptions): Promise<DaemonExit> {
  const directory = await openPrivateDirectory(options.directory);
  const lock = await acquireDaemonLock(directory);
  // An endpoint left by a daemon that crashed names a port nothing serves.
  await removeEndpoint(directory);
  let log: DaemonLog | undefined;
  try {
    log = await openDaemonLog(directory);
    return await serveDaemon(options, directory, log);
  } catch (error) {
    log?.write({ event: 'failed', ...describeFailure(error) });
    throw error;
  } finally {
    log?.close();
    lock.release();
  }
}

async function serveDaemon(
  options: DaemonOptions,
  directory: string,
  log: DaemonLog,
): Promise<DaemonExit> {
  const settings = await readSettings(directory),
    session = await readIdentity(directory),
    token = await readToken(directory);
  log.write({ event: 'starting', mode: settings.mode, pid: process.pid, version: chatHostVersion });
  const databasePath = join(directory, 'chat.sqlite');
  // SQLite gives its WAL files the store's mode, so the store starts private.
  await preparePrivateFile(databasePath);
  let exit: DaemonExit = 'stopped',
    stopping = false;
  let finish!: () => void, idle: IdleMonitor | undefined, closeAdmissions: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  // Stopping refuses new requests and runs at once; the server and runtime then close in order.
  const stop = () => {
    if (stopping) return;
    stopping = true;
    idle?.stop();
    closeAdmissions?.();
    finish();
  };
  if (options.signal.aborted) stop();
  else options.signal.addEventListener('abort', stop, { once: true });
  const ripgrep = options.ripgrepExecutable ? { ripgrepExecutable: options.ripgrepExecutable } : {};
  try {
    const providers = options.providers(settings, session);
    // A key file is checked before serving; the Keychain is read at the first sign-in.
    if (settings.credentialKey?.source === 'file') await checkKeyFile(providers.keySource);
    // A host's roots are checked once, so a root replaced later approves nothing.
    const folders =
      settings.mode === 'host'
        ? await createRootFolders(settings.approvedRoots, {
            reserved: [
              directory,
              ...(settings.credentialKey?.source === 'file' ? [settings.credentialKey.path] : []),
            ],
          }).catch((error: unknown) => {
            throw ApplicationError.is(error) ? new DaemonFailure(error.code, error.message) : error;
          })
        : createFolderApprovals(join(directory, 'approved-folders.json'));
    const runtime = ManagedRuntime.make(
      composeRuntime(directory, providers, folders, session, databasePath, ripgrep),
    );
    try {
      const { control, providerChanges } = await runtime.runPromise(
        Effect.gen(function* () {
          return { control: yield* LocalPiControl, providerChanges: yield* ProviderSetupChanges };
        }),
      );
      // The WebSocket pushes provider setup changes beside chat and chat list watches.
      const sources: SocketSources = {
        subscribeProviderSetup: (listener) => providerChanges.subscribe(listener),
      };
      closeAdmissions = () => control.setAdmissionsOpen(false);
      if (stopping) closeAdmissions();
      const serveModes = async (host: WorkspaceHostServiceShape | undefined) => {
        const wrap = options.wrapChat ?? ((client: ChatClient) => client);
        const exposeWorkspace = (monitor?: IdleMonitor) => {
          if (host)
            options.receiveWorkspace?.(
              guardWorkspace(host, { isStopping: () => stopping, idle: monitor }),
            );
        };
        if (settings.mode === 'host') {
          exposeWorkspace();
          // A host serves remote clients on its configured port and never idles out.
          await serve(
            runtime,
            wrap(makeChatClient(runtime)),
            settings.port,
            makeDaemonClient(runtime),
            hostDaemonCapabilities,
            sources,
          );
        } else {
          idle = createIdleMonitor({
            idleMs: options.idleMs ?? 5 * 60_000,
            pollMs: options.pollMs ?? 30_000,
            clock: options.clock ?? systemClock,
            hasActiveWork: () => runtime.runPromise(control.hasActiveWork()),
            onIdle: () => {
              exit = 'idle';
              stop();
            },
          });
          if (stopping) idle.stop();
          exposeWorkspace(idle);
          await serve(
            runtime,
            trackClientUse(wrap(makeChatClient(runtime)), idle),
            0,
            trackDaemonUse(makeDaemonClient(runtime), idle),
            localDaemonCapabilities,
            {
              ...sources,
              // A connected client keeps a local daemon running, as an open watch does.
              trackConnection: () => {
                idle!.begin();
                let open = true;
                return () => {
                  if (open) idle!.end();
                  open = false;
                };
              },
            },
          );
        }
      };
      // The file host closes after the server and before the runtime.
      const workspace = await openWorkspace(folders);
      try {
        await serveModes(workspace.host);
      } finally {
        // A failed close (a stale lock, say) must not stop the shutdown below or the exit code.
        await workspace.dispose().catch((error: unknown) => {
          log.write({
            event: 'workspace',
            reason: 'close-failed',
            code: describeFailure(error).code,
          });
        });
      }
    } finally {
      await runtime.dispose();
    }
  } finally {
    idle?.stop();
    options.signal.removeEventListener('abort', stop);
    // Claude Code's warm workers close after the runtime, so a turn finishing during shutdown
    // can't leave one cached behind it.
    await options.closeClaudeCode().catch(() => {});
    await removeEndpoint(directory);
  }
  log.write({ event: 'stopped', reason: exit });
  return exit;

  /**
   * Composes the workspace file host on macOS, with the data in `workspace/`, this daemon's host ID
   * and the root policy of its mode. A host that can't be composed (no helper, an unqualified
   * runtime, an unusable store) is logged by code and left out: chats are unaffected. Disposing
   * cancels its helper process groups and waits for them.
   */
  async function openWorkspace(folders: FolderApprovals) {
    const none = { host: undefined, dispose: async () => {} };
    if (process.platform !== 'darwin' || stopping) return none;
    if (!options.filesystemHelper) {
      log.write({ event: 'workspace', reason: 'no-helper' });
      return none;
    }
    let runtime: ManagedRuntime.ManagedRuntime<WorkspaceHostService, ApplicationError> | undefined;
    try {
      const workspaceDirectory = await openPrivateDirectory(join(directory, 'workspace'));
      const policy = await createRootPolicy(directory, settings, folders);
      runtime = ManagedRuntime.make(
        WorkspaceHostLive({
          dataDirectory: workspaceDirectory,
          hostId: session.host.hostId,
          filesystemHelper: options.filesystemHelper,
          gitExecutable: '/usr/bin/git',
          ...(options.ripgrepExecutable ? { ripgrepExecutable: options.ripgrepExecutable } : {}),
          ...policy,
        }),
      );
      const host = await runtime.runPromise(WorkspaceHostService);
      log.write({ event: 'workspace', reason: 'ready' });
      const opened = runtime;
      return { host, dispose: () => opened.dispose() };
    } catch (error) {
      await runtime?.dispose().catch(() => {});
      log.write({ event: 'workspace', reason: 'unavailable', code: describeFailure(error).code });
      return none;
    }
  }

  /** Serves until stopped, then closes the server; the caller closes the runtime. */
  async function serve<R>(
    runtime: ManagedRuntime.ManagedRuntime<R, ApplicationError>,
    client: ChatClient,
    port: number,
    daemon: DaemonClient,
    capabilities: readonly ChatHostCapability[],
    sources: SocketSources,
  ) {
    // A daemon told to stop while starting never listens or announces itself.
    if (stopping) return;
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // The server's own startup read is let through; once it listens, stopping refuses.
          let listening = 0;
          const refusing = () => stopping && listening > 0;
          const server = yield* serveChat(
            { host: session.host, token, port },
            refuseWhileStopping(client, refusing),
            refuseDaemonWhileStopping(daemon, refusing),
            capabilities,
            { sources },
          );
          listening = Number(new URL(server.origin).port);
          if (!stopping)
            yield* Effect.promise(() =>
              writeEndpoint(directory, {
                port: listening,
                pid: process.pid,
                version: chatHostVersion,
                protocol: chatProtocolVersion,
                build: options.build ?? 'development',
              }),
            );
          if (!stopping) {
            log.write({ event: 'ready', port: listening });
            options.ready(JSON.stringify({ event: 'ready', host: session.host, port: listening }));
          }
          yield* Effect.promise(() => finished);
          log.write({ event: 'stopping', reason: exit });
        }),
      ),
    );
  }
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
