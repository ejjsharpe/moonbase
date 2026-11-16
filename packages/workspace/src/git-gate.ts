import { Duration, Effect, Exit } from 'effect';
import { execFileSync } from 'node:child_process';
import { WorkspaceUnavailableError } from '@moonbase/contracts/workspace-host-errors';

export const systemGit = '/usr/bin/git';
/** How long a missing command-line tools install is remembered before it is looked for again. */
const missingRetry = Duration.seconds(3);

/**
 * Whether the Xcode command-line tools (or Xcode) are selected; asking never opens an installer.
 * Runs synchronously: under load Bun can miss an asynchronous child's exit, leaving the probe and
 * its kill without a callback forever. It takes a few milliseconds, once per host.
 */
const developerToolsInstalled = Effect.sync(() => {
  try {
    execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
});

/**
 * Guards Git runs. macOS's `/usr/bin/git` is a stub that offers to install the command-line tools
 * when they are missing, which a daemon must never trigger, so a missing install is `Unavailable`
 * and the stub is never run. A found install is remembered; a missing one is looked for again
 * after a few seconds, so calls made while it is missing share one probe.
 */
export const makeGitGate = (
  gitExecutable: string,
  probe: Effect.Effect<boolean> = developerToolsInstalled,
): Effect.Effect<Effect.Effect<void, WorkspaceUnavailableError>> =>
  gitExecutable !== systemGit
    ? Effect.succeed(Effect.void)
    : Effect.map(
        Effect.cachedWithTTL(probe, (exit) =>
          Exit.isSuccess(exit) && exit.value ? Duration.infinity : missingRetry,
        ),
        (installed) =>
          Effect.flatMap(installed, (found) =>
            found
              ? Effect.void
              : Effect.fail(new WorkspaceUnavailableError({ cause: 'git-tools' })),
          ),
      );
