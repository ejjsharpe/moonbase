import { Cause, Console, Effect, Exit, Layer } from 'effect';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import type { DaemonExit } from './daemon-stop.ts';
import { describeFailure } from './daemon-errors.ts';

/**
 * Runs a daemon as its process's one program, on Bun's services and `config` (its
 * `ConfigProvider`). SIGTERM or SIGINT interrupts it, which shuts it down cleanly. A failure is
 * reported on stderr as one JSON line that names no path or secret. The process exits once the
 * daemon has, 0 unless it failed, so nothing left behind (a helper that never exited, say) keeps
 * it, and launchd's job, alive.
 */
export const runDaemonProcess = (
  daemon: Effect.Effect<DaemonExit, unknown, BunServices.BunServices>,
  config: Layer.Layer<never>,
) =>
  BunRuntime.runMain(
    daemon.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Console.error(
              JSON.stringify({ event: 'failed', error: describeFailure(Cause.squash(cause)) }),
            ),
      ),
      Effect.provide(Layer.merge(BunServices.layer, config)),
    ),
    {
      disableErrorReporting: true,
      teardown: (exit, onExit) => {
        const code = Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause) ? 0 : 1;
        onExit(code);
        process.exit(code);
      },
    },
  );
