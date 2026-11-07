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
  models.setProvider(
    createClaudeCodeSubscription({
      // Claude Code starts the tool-inventory helper with this executable.
      helperEnv: { ELECTRON_RUN_AS_NODE: '1' },
    }),
  );
  const approvals = new Map<string, { dev: number; ino: number }>();
  const approveFolder = async (path: string) => {
    const cwd = await realpath(path),
      info = await stat(cwd);
    if (!info.isDirectory())
      throw new ApplicationError({ code: 'InvalidInput', message: 'Choose an existing folder.' });
    approvals.set(cwd, { dev: info.dev, ino: info.ino });
    return cwd;
  };
  // A folder chosen in the native picker, still the same directory, may be searched and chatted in,
  // as may a checkout the editor approved, such as a project's root in its docked chat.
  const requireApprovedFolder = async (path: string, purpose: string) => {
    const approved = approvals.get(path);
    const cwd = await realpath(path),
      info = await stat(cwd);
    if (cwd === path && info.isDirectory() && !approved && isEditorFolder(cwd)) return;
    if (
      !approved ||
      cwd !== path ||
      !info.isDirectory() ||
      info.dev !== approved.dev ||
      info.ino !== approved.ino
    )
      throw new ApplicationError({
        code: 'Unauthorized',
        message: `Choose this working folder with the native picker before ${purpose}.`,
      });
  };
  const approveSettings = (settings: ChatCreationSettings) =>
    requireApprovedFolder(settings.cwd, 'creating or retrying a local chat');
  const approveSearch = (cwd: string) => requireApprovedFolder(cwd, 'searching its files');
  const scope = Scope.forkUnsafe(runtime.scope, 'parallel');
  try {
    const services = await runApplicationEffect(
      runtime,
      Layer.buildWithScope(
        Layer.mergeAll(
          LocalPiRuntimeLive({
            ...session,
            databasePath: join(directory, 'chat.sqlite'),
            models,
            approveCreation: approveSettings,
            approveFolder: approveSearch,
            ...(ripgrepExecutable ? { ripgrepExecutable } : {}),
          }),
          ProviderSetupLive({ models, openUrl, deviceId: session.host.hostId }),
          Layer.effectDiscard(Effect.addFinalizer(() => Effect.promise(closeClaudeCodeProcesses))),
        ),
        scope,
      ),
    );
    return {
      session,
      approveFolder,
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
