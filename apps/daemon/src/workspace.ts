import { accessSync, constants, statSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect, Stream } from 'effect';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { FolderApprovals } from '@moonbase/contracts/daemon';
import type { RootPredicate } from '@moonbase/workspace';
import type { DaemonSettings } from '@moonbase/chat-runtime/host-configuration';
import type { IdleMonitor } from './idle.ts';

const executable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The workspace's native helper: `workspace/filesystem` beside the `daemon/` folder of the bundle
 * that `entry` names, else `packages/workspace/dist/filesystem` of a source checkout. Absent when
 * neither holds an executable file, in which case the daemon composes no workspace.
 */
export function findFilesystemHelper(entry: string | URL): string | undefined {
  return [
    fileURLToPath(new URL('../workspace/filesystem', entry)),
    fileURLToPath(new URL('../../../packages/workspace/dist/filesystem', import.meta.url)),
  ].find(executable);
}

const isInside = (outer: string, path: string) => {
  const [a, b] = [outer.normalize('NFC').toLowerCase(), path.normalize('NFC').toLowerCase()];
  return b === a || b.startsWith(a === '/' ? '/' : `${a}/`);
};

/**
 * Where the workspace may not go, and which roots it may open. Paths reserved in both modes are
 * the daemon's secrets and state; local mode also refuses any root inside the data directory except
 * under `chats/`, and host mode opens only what `folders` (the approved roots) allows, by real
 * path: one named through a link is refused, as is a root replaced since startup.
 */
export async function createRootPolicy(
  directory: string,
  settings: DaemonSettings,
  folders: FolderApprovals,
): Promise<{ reserved: string[]; allowRoot: RootPredicate }> {
  const data = await realpath(directory),
    chats = join(data, 'chats');
  // A root holding any of these, or inside one, is refused. That includes holding the data
  // directory, which holds `token`; roots inside the data directory are refused below.
  const reserved = [
    join(data, 'token'),
    join(data, 'credentials'),
    join(data, 'workspace'),
    ...(settings.credentialKey?.source === 'file' ? [settings.credentialKey.path] : []),
  ];
  const withinData = (real: string) => isInside(data, real) && !isInside(chats, real);
  return {
    reserved,
    allowRoot:
      settings.mode === 'host'
        ? async (real, requested) =>
            real === requested && !withinData(real) && (await folders.has(real))
        : (real) => !withinData(real),
  };
}

/**
 * Counts each workspace call as a client using the daemon and refuses new calls and watches once
 * `isStopping()` is true; calls already running carry on until the workspace closes.
 */
export function guardWorkspace(
  host: WorkspaceHostServiceShape,
  { isStopping, idle }: { isStopping(): boolean; idle?: IdleMonitor },
): WorkspaceHostServiceShape {
  const stopping = () =>
    Effect.fail(
      new ApplicationError({
        code: 'Unavailable',
        message: 'The daemon is stopping.',
      }),
    );
  const counted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      if (!idle) return effect;
      idle.begin();
      return effect.pipe(Effect.ensuring(Effect.sync(() => idle.end())));
    });
  const guarded = Object.fromEntries(
    Object.entries(host).map(([name, call]) => [
      name,
      name === 'watch'
        ? (input: never) =>
            Stream.unwrap(
              Effect.suspend(() => {
                if (isStopping()) return stopping();
                idle?.begin();
                return Effect.succeed(
                  (call as WorkspaceHostServiceShape['watch'])(input).pipe(
                    Stream.ensuring(Effect.sync(() => idle?.end())),
                  ),
                );
              }),
            )
        : (input: never) =>
            Effect.suspend(() =>
              isStopping()
                ? stopping()
                : counted((call as unknown as (input: never) => Effect.Effect<unknown>)(input)),
            ),
    ]),
  );
  return guarded as WorkspaceHostServiceShape;
}
