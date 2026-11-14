import { Deferred, Effect } from 'effect';
import { execFile, spawn } from 'node:child_process';
import fs, { constants, fstatSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { FileDocument } from '@moonbase/contracts/workspace';
import { document, path } from './validation.ts';
import {
  CheckoutAccessError,
  CheckoutChangedError,
  InvalidPathError,
  WorkspaceUnavailableError,
} from '@moonbase/contracts/workspace-host-errors';
import { asWorkspaceFailure, attempt, type WorkspaceFailure } from './attempt.ts';
import { HelperFailure } from './system-failures.ts';
/** macOS `O_NOFOLLOW_ANY`: refuse a symlink anywhere in the path, not only the last component. */
export const O_NOFOLLOW_ANY = 0x20000000;
const flags = constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY;
export const identity = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`;
/**
 * Reads one stdout line (without its newline) as it arrives; `'stop'` ends the process early and
 * the run then succeeds. A run that reads lines resolves with no buffered output.
 */
export type LineReader = (line: Buffer) => 'stop' | void;
export type Run = (
  args: string[],
  options: {
    fd: number;
    input?: string;
    extra?: number[];
    onLine?: LineReader;
    /** Overrides for the helper's environment; `undefined` removes a variable. */
    env?: Record<string, string | undefined>;
  },
) => Effect.Effect<Buffer, HelperFailure>;
/** Untranslated Git output, for commands whose text is read back. */
const gitLocale = { LC_ALL: 'C', LANGUAGE: undefined };
const helperEnvironment = (overrides: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  return env;
};
const outputLimit = 16 * 1024 * 1024;
/** How long output a helper wrote before it exited has to be read when something holds its pipes. */
const outputDrainMs = 100;
/** How long a stopped process group has to clean up after SIGTERM before SIGKILL. */
export const stopGrace = 2000;
const groupAlive = (group: number) => {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const signalGroup = (group: number | undefined, signal: NodeJS.Signals) => {
  if (group === undefined) return;
  try {
    process.kill(-group, signal);
  } catch {
    // The group already exited.
  }
};
/**
 * Waits until every process in a stopped group has exited, so callers clean up only after
 * children such as a checkout's `git reset` stop writing. SIGKILL follows the grace period.
 */
const awaitGroupExit = (group: number, stoppedAt: number) =>
  Effect.promise(async () => {
    let killed = false;
    for (;;) {
      if (!groupAlive(group)) return;
      const elapsed = Date.now() - stoppedAt;
      if (!killed && elapsed >= stopGrace) {
        killed = true;
        signalGroup(group, 'SIGKILL');
      }
      if (elapsed >= stopGrace * 2) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
/**
 * Runs the filesystem helper. Interrupting a run (where its caller lets it be interrupted) stops
 * the helper's process group (SIGTERM, then SIGKILL after `stopGrace`) and waits for it to exit
 * before the run ends, so its descriptors and the checkout stay owned until then.
 */
export function makeRunner(helper: string): Run {
  return (args, { fd, input, extra = [], onLine, env }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const completion = Deferred.makeUnsafe<Buffer, HelperFailure>();
            // Its own process group, so stopping reaches Git's children (checkout, hooks,
            // filters) as Ctrl-C would, and Git can remove what it half-created.
            const child = spawn(helper, args, {
              stdio: ['pipe', 'pipe', 'pipe', fd, ...extra],
              env: helperEnvironment(env),
              detached: true,
            });
            const state = {
              child,
              completion,
              settled: false,
              capped: false,
              // The reader asked for no more output: a clean early end, not a failure.
              finished: false,
              stoppedAt: undefined as number | undefined,
              escalation: undefined as NodeJS.Timeout | undefined,
              stop: () => {
                if (state.stoppedAt !== undefined) return;
                state.stoppedAt = Date.now();
                signalGroup(child.pid, 'SIGTERM');
                state.escalation = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), stopGrace);
              },
            };
            const chunks: Buffer[] = [];
            let length = 0,
              errors = '',
              spawnError: unknown;
            const deliver = (line: Buffer) => {
              try {
                if (onLine!(line) !== 'stop') return false;
                state.finished = true;
              } catch (error) {
                spawnError ??= error;
              }
              state.stop();
              return true;
            };
            const take = (chunk: Buffer) => {
              if (state.finished || state.capped) return;
              if (length + chunk.length > outputLimit) {
                state.capped = true;
                return state.stop();
              }
              chunks.push(chunk);
              length += chunk.length;
            };
            const read = (chunk: Buffer) => {
              if (state.stoppedAt !== undefined) return;
              let start = 0;
              for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
                const piece = chunk.subarray(start, end);
                const line = chunks.length ? Buffer.concat([...chunks, piece]) : piece;
                chunks.length = length = 0;
                start = end + 1;
                if (deliver(line)) return;
              }
              if (start < chunk.length) take(chunk.subarray(start));
            };
            child.stdout!.on('data', onLine ? read : take);
            child.stderr!.on('data', (chunk: Buffer) => {
              errors = (errors + chunk.toString()).slice(0, 4096);
            });
            child.stdin!.on('error', () => {});
            child.once('error', (error) => {
              spawnError = error;
            });
            // A process the helper started outside its group (a hook's daemon, say) can hold
            // stdout open long after the helper exits, so the run settles once the helper exits
            // and its last output has had a moment to arrive, not when every holder of the pipes
            // has let go.
            let draining: NodeJS.Timeout | undefined;
            const settle = (code: number | null, killed: NodeJS.Signals | null) => {
              if (state.settled) return;
              state.settled = true;
              clearTimeout(draining);
              child.stdout!.destroy();
              child.stderr!.destroy();
              // A final line without a newline.
              if (onLine && code === 0 && length && !state.finished && !state.capped)
                deliver(Buffer.concat(chunks));
              const output = onLine ? Buffer.alloc(0) : Buffer.concat(chunks, length);
              if ((code === 0 || state.finished) && !state.capped && !spawnError)
                Deferred.doneUnsafe(completion, Effect.succeed(output));
              else
                Deferred.doneUnsafe(
                  completion,
                  Effect.fail(
                    new HelperFailure({
                      message:
                        errors ||
                        (state.capped
                          ? 'Filesystem output/time limit reached; refine request.'
                          : 'Filesystem helper unavailable.'),
                      status: spawnError ? null : code,
                      stderr: errors,
                      uncertain: !spawnError && (!!killed || state.capped),
                      output,
                    }),
                  ),
                );
            };
            child.once('exit', (code, killed) => {
              draining = setTimeout(() => settle(code, killed), outputDrainMs);
            });
            child.once('close', settle);
            child.stdin!.end(input);
            return state;
          }),
          (state) =>
            Effect.gen(function* () {
              if (!state.settled) state.stop();
              // Child error or interruption is not exit: descriptors stay owned until it exits.
              yield* Effect.exit(Deferred.await(state.completion));
              if (state.stoppedAt !== undefined && state.child.pid !== undefined)
                yield* awaitGroupExit(state.child.pid, state.stoppedAt);
              clearTimeout(state.escalation);
              state.child.removeAllListeners();
              state.child.stdin?.removeAllListeners();
              state.child.stdout?.removeAllListeners();
              state.child.stderr?.removeAllListeners();
            }),
        );
        yield* Effect.sleep('30 seconds').pipe(
          Effect.andThen(
            Effect.sync(() => {
              state.capped = true;
              state.stop();
            }),
          ),
          Effect.forkScoped,
        );
        return yield* Deferred.await(state.completion);
      }),
    );
}
export const systemGit = '/usr/bin/git';
/** Whether the Xcode command-line tools (or Xcode) are selected; asking never opens an installer. */
const developerToolsInstalled = () =>
  new Promise<boolean>((resolve) => {
    execFile('/usr/bin/xcode-select', ['-p'], { timeout: 5000 }, (error) => resolve(!error));
  });
/**
 * Guards a Git run. macOS's `/usr/bin/git` is a stub that offers to install the command-line tools
 * when they are missing, which a daemon must never trigger, so a missing install is `Unavailable`
 * and the stub is never run. A found install is remembered; a missing one is looked for again, at
 * most once per `retryMs`, so calls made while it is missing don't each wait on the probe.
 */
export function createGitGate(
  gitExecutable: string,
  probe: () => Promise<boolean> = developerToolsInstalled,
  { retryMs = 3000, now = Date.now }: { retryMs?: number; now?: () => number } = {},
) {
  let found = gitExecutable !== systemGit,
    probing: Promise<boolean> | undefined,
    missingAt: number | undefined;
  const check = async () => {
    if (found) return;
    if (missingAt === undefined || now() - missingAt >= retryMs) {
      probing ??= probe().finally(() => (probing = undefined));
      if (await probing) found = true;
      else missingAt = now();
    }
    if (!found) throw new WorkspaceUnavailableError({ cause: 'git-tools' });
  };
  return (): Effect.Effect<void, WorkspaceFailure> =>
    Effect.tryPromise({ try: check, catch: asWorkspaceFailure });
}
export class Directory {
  readonly fd: number;
  readonly root: string;
  readonly expected: string;
  readonly run: Run;
  readonly gitExecutable: string;
  readonly gitReady: () => Effect.Effect<void, WorkspaceFailure>;
  constructor(
    root: string,
    expected: string,
    run: Run,
    gitExecutable: string,
    gitReady: () => Effect.Effect<void, WorkspaceFailure> = () => Effect.void,
  ) {
    this.gitReady = gitReady;
    this.root = root;
    this.expected = expected;
    this.run = run;
    this.gitExecutable = gitExecutable;
    this.fd = openSync(root, flags);
    try {
      if (!(identity(fstatSync(this.fd)) === expected && realpathSync(root) === root))
        throw new CheckoutChangedError({ change: 'directory' });
      let parent = '/';
      for (const component of root.split('/').filter(Boolean)) {
        if (!readdirSync(parent).includes(component))
          throw new InvalidPathError({ problem: 'root-spelling' });
        parent = resolve(parent, component);
      }
    } catch (error) {
      fs.closeSync(this.fd);
      throw error;
    }
  }
  /** Closes the root descriptor; the registry that opened the directory calls it once. */
  close() {
    fs.closeSync(this.fd);
  }
  check() {
    const fd = openSync(this.root, flags);
    try {
      if (identity(fstatSync(fd)) !== this.expected)
        throw new CheckoutAccessError({ refusal: 'replaced' });
    } finally {
      fs.closeSync(fd);
    }
  }
  io(args: string[], input?: string, extra?: number[]) {
    return Effect.andThen(
      attempt(() => this.check()),
      this.run(args, { fd: this.fd, input, extra }),
    );
  }
  /** Runs like `io` but hands stdout to `onLine` line by line instead of buffering it. */
  lines(args: string[], onLine: LineReader) {
    return Effect.andThen(
      attempt(() => this.check()),
      Effect.asVoid(this.run(args, { fd: this.fd, onLine })),
    );
  }
  /**
   * Runs Git in the checkout. `untranslated` runs it in the C locale, for output read back; other
   * commands keep the user's locale, which hooks and filters they run inherit.
   */
  git(args: string[], input?: string, { untranslated = false } = {}) {
    return attempt(() => this.check()).pipe(
      Effect.andThen(this.gitReady()),
      Effect.andThen(
        this.run(
          [
            'git',
            this.gitExecutable,
            '--literal-pathspecs',
            '-c',
            'core.fsmonitor=false',
            '-c',
            'core.excludesFile=/dev/null',
            '--work-tree=.',
            ...args,
          ],
          { fd: this.fd, input, ...(untranslated ? { env: gitLocale } : {}) },
        ),
      ),
    );
  }
  /** Makes the root a new repository; `git` above names a work tree, which needs one already. */
  initializeGit() {
    return Effect.andThen(this.gitReady(), this.io(['git', this.gitExecutable, 'init', '--quiet']));
  }
  /** The object at `p`, refused unless `p` is its exact spelling with no link on the way. */
  entry(p: string, spellings?: Map<string, Set<string>>) {
    return attempt(() => this.entryNow(p, spellings));
  }
  private entryNow(p: string, spellings?: Map<string, Set<string>>) {
    path(p, true);
    this.check();
    if (p) {
      if (!(relative(this.root, realpathSync(resolve(this.root, p))) === p))
        throw new InvalidPathError({ problem: 'alias' });
      let parent = this.root;
      for (const component of p.split('/')) {
        const names = spellings?.get(parent) ?? new Set(readdirSync(parent));
        spellings?.set(parent, names);
        if (!names.has(component)) throw new InvalidPathError({ problem: 'spelling' });
        parent = resolve(parent, component);
      }
    }
    const fd = openSync(
      resolve(this.root, p),
      constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY,
    );
    try {
      const info = fstatSync(fd);
      if (!(info.isFile() || info.isDirectory()))
        throw new InvalidPathError({ problem: 'unsupported' });
      return { identity: identity(info), directory: info.isDirectory() };
    } finally {
      fs.closeSync(fd);
    }
  }
  read(p: string): Effect.Effect<FileDocument, WorkspaceFailure> {
    return attempt(() => path(p)).pipe(
      Effect.andThen(this.entry(p)),
      Effect.andThen(this.io(['read', p])),
      Effect.flatMap((bytes) => attempt(() => document(bytes))),
    );
  }
  /** The identity of `p`'s parent folder, which a new object at `p` goes in. */
  destination(p: string) {
    return attempt(() => {
      path(p);
      const parent = dirname(p);
      const item = this.entryNow(parent === '.' ? '' : parent);
      if (!item.directory) throw new InvalidPathError({ problem: 'destination-parent' });
      return item.identity;
    });
  }
}
