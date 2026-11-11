import { createKeyFileSource, createKeychainKeySource } from '@moonbase/pi-runtime/credentials';
import {
  closeClaudeCodeProcesses,
  createClaudeCodeSubscription,
} from '@moonbase/pi-runtime/claude-code';
import { runDaemon } from './daemon.ts';
import { readDirectoryArgument } from './data-directory.ts';
import { describeFailure } from './failure.ts';
import { findBundledRipgrep } from './ripgrep.ts';
import { onShutdownSignal } from './signals.ts';

/** The bundle's digest, which `scripts/build.mjs` defines; undefined when run from source. */
declare const MOONBASE_DAEMON_BUILD: string | undefined;

/**
 * The daemon process root: `bun src/main.ts <absolute data directory>`. Its only argument is the
 * data directory; all other configuration comes from files inside it.
 */
async function main() {
  await runDaemon({
    directory: readDirectoryArgument(process.argv.slice(2)),
    signal: onShutdownSignal(),
    ready: (line) => console.log(line),
    closeClaudeCode: closeClaudeCodeProcesses,
    // The app's ripgrep beside the packaged bundle; from source, the one on PATH.
    ripgrepExecutable: findBundledRipgrep(import.meta.url),
    build: typeof MOONBASE_DAEMON_BUILD === 'string' ? MOONBASE_DAEMON_BUILD : 'development',
    providers: (settings, session) => ({
      // A host always names a key file: without a GUI session the login keychain is locked.
      keySource:
        settings.credentialKey?.source === 'file'
          ? createKeyFileSource(settings.credentialKey.path)
          : createKeychainKeySource({ storeId: session.host.storeId }),
      installProviders: (models) => {
        const claudeCode = createClaudeCodeSubscription();
        models.setProvider(claudeCode);
        return claudeCode;
      },
    }),
  });
}
await main().catch((error) => {
  console.error(JSON.stringify({ event: 'failed', error: describeFailure(error) }));
  process.exitCode = 1;
});
