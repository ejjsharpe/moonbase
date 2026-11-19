import { Console } from 'effect';
import { makeKeyFileSource, makeKeychainKeySource } from '@moonbase/chat-runtime/credentials';
import {
  closeClaudeCodeProcesses,
  createClaudeCodeSubscription,
} from '@moonbase/chat-runtime/claude-code';
import { runDaemon } from './daemon.ts';
import { argumentsConfig } from './daemon-config.ts';
import { runDaemonProcess } from './daemon-process.ts';
import { findFilesystemHelper, findRipgrep } from './executables.ts';

/** The bundle's digest, which `scripts/build.mjs` defines; undefined when run from source. */
declare const MOONBASE_DAEMON_BUILD: string | undefined;

/**
 * The daemon process root: `bun src/main.ts <absolute data directory>`. Its only argument is the
 * data directory; all other configuration comes from files inside it.
 */
const daemon = runDaemon({
  ready: (line) => Console.log(line),
  closeClaudeCode: closeClaudeCodeProcesses,
  // The app's ripgrep beside the packaged bundle, else the one on PATH, for chats and workspace.
  ...withPath('ripgrepExecutable', findRipgrep(import.meta.url)),
  // The app's native helper beside the packaged bundle; from source, the workspace package's.
  ...withPath(
    'filesystemHelper',
    findFilesystemHelper(import.meta.url, {
      fromSource: typeof MOONBASE_DAEMON_BUILD !== 'string',
    }),
  ),
  build: typeof MOONBASE_DAEMON_BUILD === 'string' ? MOONBASE_DAEMON_BUILD : 'development',
  providers: (settings, session) => ({
    // A host always names a key file: without a GUI session the login keychain is locked.
    keySource:
      settings.credentialKey?.source === 'file'
        ? makeKeyFileSource(settings.credentialKey.path)
        : makeKeychainKeySource({ storeId: session.host.storeId }),
    installProviders: (models) => {
      const claudeCode = createClaudeCodeSubscription();
      models.setProvider(claudeCode);
      return claudeCode;
    },
  }),
});

/** An optional path option, left out when absent. */
function withPath<K extends string>(key: K, path: string | undefined) {
  return (path ? { [key]: path } : {}) as Partial<Record<K, string>>;
}

runDaemonProcess(daemon, argumentsConfig(process.argv.slice(2)));
