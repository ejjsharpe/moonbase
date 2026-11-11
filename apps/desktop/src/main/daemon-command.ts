import { join } from 'node:path';

export type DaemonCommand = { command: string; args: string[]; cwd: string };
export type DaemonLocation = {
  /** Electron's `app.isPackaged`. */
  packaged: boolean;
  /** Electron's `process.resourcesPath`: `Moonbase.app/Contents/Resources` when packaged. */
  resourcesPath: string;
  /** The folder of main's own bundle, `apps/desktop/dist` in development. */
  bundleDirectory: string;
};

/**
 * Bun otherwise loads `.env` files and `bunfig.toml` (whose `preload` runs code) from its working
 * folder. The daemon reads its configuration only from its data directory, so it runs with
 * neither, from inside that directory.
 */
const bunOptions = ['--no-env-file', '--config=/dev/null'];

/**
 * The command that runs the local daemon on its data directory. A packaged app runs its own Bun
 * runtime (`Contents/Helpers/bun`) on the daemon bundle in its resources, which keeps Claude Code's
 * helper beside it; development runs the daemon's source entry with the `bun` on PATH, so it
 * needs no packaging step.
 */
export function findDaemonCommand(location: DaemonLocation, directory: string): DaemonCommand {
  if (location.packaged)
    return {
      command: join(location.resourcesPath, '..', 'Helpers', 'bun'),
      args: [...bunOptions, join(location.resourcesPath, 'daemon', 'daemon.mjs'), directory],
      cwd: directory,
    };
  return {
    command: 'bun',
    args: [
      ...bunOptions,
      join(location.bundleDirectory, '..', '..', 'daemon', 'src', 'main.ts'),
      directory,
    ],
    cwd: directory,
  };
}
