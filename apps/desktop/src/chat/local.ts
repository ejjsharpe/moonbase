import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { Context, Effect, Exit, Layer, Scope, type ManagedRuntime } from 'effect';
import { LocalPiRuntimeLive, LocalPiControl } from '@moonbase/pi-runtime';
import { createCredentialStore } from '@moonbase/pi-runtime/credentials';
import { ProviderSetupLive } from '@moonbase/pi-runtime/providers';
import { createLocalModels } from '@moonbase/pi-runtime/local-models';
import {
  closeClaudeCodeProcesses,
  createClaudeCodeSubscription,
} from '@moonbase/pi-runtime/claude-code';
import { ChatService, ProviderSetupService } from '@moonbase/contracts/services';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatCreationSettings, ChatSession } from '@moonbase/contracts/chat';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import { createFolderApprovals } from './folders.ts';

async function readLocalIdentity(directory: string): Promise<ChatSession> {
  const path = join(directory, 'identity.json');
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const session = {
      host: { hostId: randomUUID(), storeId: randomUUID() },
      actorId: randomUUID(),
    };
    const created = await open(path, 'wx', 0o600);
    try {
      await created.writeFile(JSON.stringify(session));
      await created.sync();
    } finally {
      await created.close();
    }
    return session;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || info.uid !== process.getuid?.() || info.mode & 0o077)
      throw Error();
    return decodeChatInput('listChats', { session: JSON.parse(await file.readFile('utf8')) })
      .session;
  } finally {
    await file.close();
  }
}

/** Acquired in the privileged root's existing runtime and removable scope. */
export async function acquireLocalChat(
  runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
  userData: string,
  openUrl: (url: string) => Promise<void>,
  {
    ripgrepExecutable,
    isEditorFolder = () => false,
  }: {
    ripgrepExecutable?: string;
    /** Whether a folder is a checkout or worktree the editor approved natively. */
    isEditorFolder?: (path: string) => boolean;
  } = {},
) {
  const directory = join(userData, 'local-pi-v1');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw new ApplicationError({
      code: 'Persistence',
      message:
        'The private local chat directory is unavailable. Preserve its files and check permissions.',
    });
  const session = await readLocalIdentity(directory);
  const credentials = createCredentialStore(join(directory, 'credentials'), {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptStringAsync(plain),
    decrypt: async (encrypted) =>
      (await safeStorage.decryptStringAsync(Buffer.from(encrypted))).result,
  });
  const models = createLocalModels(credentials);
  const claudeCode = createClaudeCodeSubscription({
    // Claude Code starts the tool-inventory helper with this executable. The library fixes that
    // helper's own env, so this reaches it only because Claude Code passes its env to MCP servers.
    helperEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });
  models.setProvider(claudeCode);
  const folders = createFolderApprovals(join(directory, 'approved-folders.json'));
  // A folder chosen in the native picker, still the same directory, may be searched and chatted in,
  // as may a checkout the editor approved, such as a project's root in its docked chat.
  const requireApprovedFolder = async (path: string, purpose: string) => {
    if (await folders.has(path)) return;
    const cwd = await realpath(path).catch(() => ''),
      info = cwd ? await stat(cwd) : null;
    if (cwd === path && info?.isDirectory() && isEditorFolder(cwd)) return;
    throw new ApplicationError({
      code: 'Unauthorized',
      message: `Choose this working folder with the native picker before ${purpose}.`,
    });
  };
  const approveSettings = async (settings: ChatCreationSettings) => {
    await requireApprovedFolder(settings.cwd, 'creating or retrying a local chat');
    await folders.touch(settings.cwd);
  };
  const approveSearch = (cwd: string) => requireApprovedFolder(cwd, 'searching its files');
  // A sequential scope closes in reverse: the chat services (in parallel) first, then Claude Code's
  // warm workers, so a turn finishing during shutdown can't leave a worker cached behind them.
  const scope = Scope.forkUnsafe(runtime.scope, 'sequential');
  try {
    const services = await runApplicationEffect(
      runtime,
      Effect.gen(function* () {
        yield* Scope.addFinalizer(scope, Effect.promise(closeClaudeCodeProcesses));
        return yield* Layer.buildWithScope(
          Layer.mergeAll(
            LocalPiRuntimeLive({
              ...session,
              databasePath: join(directory, 'chat.sqlite'),
              models,
              approveCreation: approveSettings,
              approveFolder: approveSearch,
              ...(ripgrepExecutable ? { ripgrepExecutable } : {}),
            }),
            ProviderSetupLive({
              models,
              openUrl,
              deviceId: session.host.hostId,
              getCheckProblem: (id, signal) =>
                id === claudeCode.id ? claudeCode.getCheckProblem(signal) : undefined,
            }),
          ),
          Scope.forkUnsafe(scope, 'parallel'),
        );
      }),
    );
    return {
      session,
      approveFolder: folders.approve,
      listRecentFolders: folders.listRecent,
      requireApprovedFolder: (path: string) =>
        requireApprovedFolder(path, 'starting a worktree from it'),
      chat: Context.get(services, ChatService),
      providers: Context.get(services, ProviderSetupService),
      control: Context.get(services, LocalPiControl),
    };
  } catch (error) {
    await runApplicationEffect(runtime, Scope.close(scope, Exit.void));
    throw error;
  }
}
