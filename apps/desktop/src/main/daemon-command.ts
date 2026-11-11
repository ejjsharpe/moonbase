import { join } from 'node:path';

/** Spawn exactly this: `command` with `args`, in `cwd`, with `env` as the whole environment. */
export type DaemonCommand = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The build identifier the started daemon writes to `endpoint.json`. */
  build: string;
};
export type DaemonLocation = {
  /** Electron's `app.isPackaged`. */
  packaged: boolean;
  /** Electron's `process.resourcesPath`: `Moonbase.app/Contents/Resources` when packaged. */
  resourcesPath: string;
  /** The folder of main's own bundle, `apps/desktop/dist` in development. */
  bundleDirectory: string;
  /** The packaged daemon bundle's build identifier, which main's own bundle embeds. */
  build: string;
};

/**
 * Bun otherwise loads `.env` files and `bunfig.toml` (whose `preload` runs code) from its working
 * folder, and auto-installs any bare import it can't resolve from the npm registry (the packaged
 * bundle has no `node_modules` above it) and runs it. The daemon reads its configuration only from
 * its data directory and runs only the code it was built with, so it runs with none of these.
 */
const bunOptions = ['--no-env-file', '--config=/dev/null', '--no-install'];

/**
 * The daemon's environment: the caller's, without what makes Bun or Node run other code or
 * options (`BUN_OPTIONS`, `NODE_OPTIONS` and every other `BUN_*` setting). `ws` would otherwise
 * try to load its optional native add-ons, which the bundle doesn't ship.
 */
function makeDaemonEnvironment(environment: Record<string, string | undefined>) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment))
    if (value !== undefined && !name.startsWith('BUN_') && name !== 'NODE_OPTIONS')
      env[name] = value;
  return { ...env, WS_NO_BUFFER_UTIL: '1', WS_NO_UTF_8_VALIDATE: '1' };
}

/**
 * The command that runs the local daemon on its data directory, with `environment` (usually
 * `process.env`) cleaned for it. A packaged app runs its own Bun runtime (`Contents/Helpers/bun`)
 * on the daemon bundle in its resources, which keeps Claude Code's helper beside it; development
 * runs the daemon's source entry with the `bun` on PATH, so it needs no packaging step.
 */
export function findDaemonCommand(
  location: DaemonLocation,
  directory: string,
  environment: Record<string, string | undefined>,
): DaemonCommand {
  const env = makeDaemonEnvironment(environment);
  if (location.packaged)
    return {
      command: join(location.resourcesPath, '..', 'Helpers', 'bun'),
      args: [...bunOptions, join(location.resourcesPath, 'daemon', 'daemon.mjs'), directory],
      cwd: directory,
      env,
      build: location.build,
    };
  return {
    command: 'bun',
    args: [
      ...bunOptions,
      join(location.bundleDirectory, '..', '..', 'daemon', 'src', 'main.ts'),
      directory,
    ],
    cwd: directory,
    env,
    // The daemon's source entry identifies itself so.
    build: 'development',
  };
}
