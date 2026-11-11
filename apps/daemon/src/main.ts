import { createKeyFileSource, createKeychainKeySource } from '@moonbase/pi-runtime/credentials';
import {
  closeClaudeCodeProcesses,
  createClaudeCodeSubscription,
} from '@moonbase/pi-runtime/claude-code';
import { runDaemon } from './daemon.ts';
import { readDirectoryArgument } from './data-directory.ts';
import { describeFailure } from './failure.ts';
import { onShutdownSignal } from './signals.ts';

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
    local: (settings, session) => ({
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
