import { join } from 'node:path';
import { Effect, Layer, ManagedRuntime } from 'effect';
import type { MutableModels } from '@earendil-works/pi-ai/models';
import { LocalPiControl, LocalPiRuntimeLive, PiRuntimeLive } from '@moonbase/pi-runtime';
import {
  createCredentialStore,
  createKeyEncryption,
  type CredentialKeySource,
} from '@moonbase/pi-runtime/credentials';
import { createFolderApprovals } from '@moonbase/pi-runtime/folders';
import {
  prepareFixedSettingsHost,
  type DaemonSettings,
} from '@moonbase/pi-runtime/host-configuration';
import { createLocalModels } from '@moonbase/pi-runtime/local-models';
import { ProviderSetupLive } from '@moonbase/pi-runtime/providers';
import { serveChat } from '@moonbase/pi-runtime/server';
import type { ClaudeCodeSubscription } from '@moonbase/pi-runtime/claude-code';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import type { ChatClient, ChatCreationSettings, ChatSession } from '@moonbase/contracts/chat';
import { chatHostVersion, chatProtocolVersion } from '@moonbase/contracts/host';
import { ApplicationError } from '@moonbase/contracts/errors';
import {
  openPrivateDirectory,
  preparePrivateFile,
  readIdentity,
  readSettings,
  readToken,
  removeEndpoint,
  writeEndpoint,
} from './data-directory.ts';
import { describeFailure } from './failure.ts';
import { createIdleMonitor, systemClock, type IdleClock, type IdleMonitor } from './idle.ts';
import { acquireDaemonLock } from './lock.ts';
import { openDaemonLog, type DaemonLog } from './log.ts';

export type LocalSettings = Extract<DaemonSettings, { mode: 'local' }>;
/** What an entry point adds to a local-mode daemon. */
export type LocalProviders = {
  /** The key that encrypts the daemon's provider credentials. */
  keySource: CredentialKeySource;
  /** Adds providers to the local catalog; returns the Claude Code subscription if it added one. */
  installProviders?(models: MutableModels): ClaudeCodeSubscription | undefined;
};
export type DaemonOptions = {
  /** The absolute data directory; everything else is read from files inside it. */
  directory: string;
  local(settings: LocalSettings, session: ChatSession): LocalProviders;
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
  let exit: DaemonExit = 'stopped';
  let finish!: () => void, idle: IdleMonitor | undefined;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const stop = () => {
    idle?.stop();
    finish();
  };
  if (options.signal.aborted) stop();
  else options.signal.addEventListener('abort', stop, { once: true });
  try {
    if (settings.mode === 'host') {
      const { models, registry } = await prepareFixedSettingsHost(settings);
      const runtime = ManagedRuntime.make(
        PiRuntimeLive({
          ...session,
          cwd: settings.cwd,
          model: settings.model,
          databasePath,
          models,
          registry,
        }),
      );
      try {
        await serve(runtime, makeChatClient(runtime), settings.port);
      } finally {
        await runtime.dispose();
      }
    } else {
      const runtime = ManagedRuntime.make(composeLocal(options, session, settings, databasePath));
      try {
        const control = await runtime.runPromise(
          Effect.gen(function* () {
            return yield* LocalPiControl;
          }),
        );
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
        if (options.signal.aborted) idle.stop();
        await serve(runtime, trackClient(makeChatClient(runtime), idle), 0, () =>
          control.setAdmissionsOpen(false),
        );
      } finally {
        await runtime.dispose();
      }
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

  /** Serves until stopped, then closes admissions before the server; the caller closes the runtime. */
  async function serve<R>(
    runtime: ManagedRuntime.ManagedRuntime<R, ApplicationError>,
    client: ChatClient,
    port: number,
    closeAdmissions?: () => void,
  ) {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveChat({ host: session.host, token, port }, client);
          // Finalizers run in reverse, so admissions close before the server does.
          if (closeAdmissions) yield* Effect.addFinalizer(() => Effect.sync(closeAdmissions));
          const listening = Number(new URL(server.origin).port);
          yield* Effect.promise(() =>
            writeEndpoint(directory, {
              port: listening,
              pid: process.pid,
              version: chatHostVersion,
              protocol: chatProtocolVersion,
            }),
          );
          log.write({ event: 'ready', port: listening });
          options.ready(JSON.stringify({ event: 'ready', host: session.host, port: listening }));
          yield* Effect.promise(() => finished);
          log.write({ event: 'stopping', reason: exit });
        }),
      ),
    );
  }
}

function composeLocal(
  options: DaemonOptions,
  session: ChatSession,
  settings: LocalSettings,
  databasePath: string,
) {
  const directory = options.directory;
  const providers = options.local(settings, session);
  const credentials = createCredentialStore(
    join(directory, 'credentials'),
    createKeyEncryption(providers.keySource),
  );
  const models = createLocalModels(credentials);
  const claudeCode = providers.installProviders?.(models);
  const folders = createFolderApprovals(join(directory, 'approved-folders.json'));
  // A folder a client approved, still the same directory, may be searched and chatted in.
  const requireApprovedFolder = async (path: string, purpose: string) => {
    if (await folders.has(path)) return;
    throw new ApplicationError({
      code: 'Unauthorized',
      message: `Approve this working folder before ${purpose}.`,
    });
  };
  return Layer.mergeAll(
    LocalPiRuntimeLive({
      ...session,
      databasePath,
      chatFolders: join(directory, 'chats'),
      models,
      approveCreation: async (creation: ChatCreationSettings) => {
        if (creation.cwd === undefined) return;
        await requireApprovedFolder(creation.cwd, 'creating or retrying a local chat');
        await folders.touch(creation.cwd);
      },
      approveFolder: (cwd: string) => requireApprovedFolder(cwd, 'searching its files'),
    }),
    ProviderSetupLive({
      models,
      // The daemon never opens a browser; a client opens sign-in links.
      openUrl: async () => {
        throw new ApplicationError({
          code: 'Unavailable',
          message: 'Open provider sign-in links from a Moonbase client.',
        });
      },
      deviceId: session.host.hostId,
      getCheckProblem: (id, signal) =>
        claudeCode && id === claudeCode.id ? claudeCode.getCheckProblem(signal) : undefined,
    }),
  );
}

/** Counts each request and open watch as a client using the daemon. */
function trackClient(client: ChatClient, idle: IdleMonitor): ChatClient {
  return {
    command: async (operation, input, options) => {
      idle.begin();
      try {
        return await client.command(operation, input, options);
      } finally {
        idle.end();
      }
    },
    watch: (input, receive, onError) => {
      idle.begin();
      let open = true;
      let close: ReturnType<ChatClient['watch']>;
      try {
        close = client.watch(input, receive, onError);
      } catch (error) {
        idle.end();
        throw error;
      }
      return async () => {
        if (open) {
          open = false;
          idle.end();
        }
        await close();
      };
    },
  };
}
