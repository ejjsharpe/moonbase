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
import { DaemonFailure, describeFailure } from './failure.ts';
import {
  createIdleMonitor,
  systemClock,
  trackClientUse,
  type IdleClock,
  type IdleMonitor,
} from './idle.ts';
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
      const providers = options.local(settings, session);
      if (settings.credentialKey?.source === 'file') await checkKeyFile(providers.keySource);
      const runtime = ManagedRuntime.make(
        composeLocal(options.directory, providers, session, databasePath),
      );
      try {
        const control = await runtime.runPromise(
          Effect.gen(function* () {
            return yield* LocalPiControl;
          }),
        );
        closeAdmissions = () => control.setAdmissionsOpen(false);
        if (stopping) closeAdmissions();
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
        await serve(runtime, trackClientUse(makeChatClient(runtime), idle), 0);
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

  /** Serves until stopped, then closes the server; the caller closes the runtime. */
  async function serve<R>(
    runtime: ManagedRuntime.ManagedRuntime<R, ApplicationError>,
    client: ChatClient,
    port: number,
  ) {
    // A daemon told to stop while starting never listens or announces itself.
    if (stopping) return;
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* serveChat({ host: session.host, token, port }, client);
          const listening = Number(new URL(server.origin).port);
          if (!stopping)
            yield* Effect.promise(() =>
              writeEndpoint(directory, {
                port: listening,
                pid: process.pid,
                version: chatHostVersion,
                protocol: chatProtocolVersion,
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

function composeLocal(
  directory: string,
  providers: LocalProviders,
  session: ChatSession,
  databasePath: string,
) {
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
