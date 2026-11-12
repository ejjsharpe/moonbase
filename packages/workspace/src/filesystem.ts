import { type Cause, Deferred, Effect, Exit } from 'effect';
import { execFile, spawn } from 'node:child_process';
import fs, { constants, fstatSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { FileDocument } from '@moonbase/contracts/workspace';
import { document, ensure, fail, path } from './validation.ts';
const flags = constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000;
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
    signal?: AbortSignal;
    onLine?: LineReader;
    /** Overrides for the helper's environment; `undefined` removes a variable. */
    env?: Record<string, string | undefined>;
  },
) => Promise<Buffer>;
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
export function makeRunner(
  helper: string,
  runEffect: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>,
  reportCleanup: (cause: Cause.Cause<never>) => void,
): Run {
  return (args, { fd, input, extra = [], signal, onLine, env }) =>
    runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Effect.acquireRelease(
            Effect.sync(() => {
              if (signal?.aborted) throw Error('Cancelled');
              const completion = Deferred.makeUnsafe<Buffer, unknown>();
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
              child.once('close', (code, killed) => {
                state.settled = true;
                // A final line without a newline.
                if (onLine && code === 0 && length && !state.finished && !state.capped)
                  deliver(Buffer.concat(chunks));
                const output = onLine ? Buffer.alloc(0) : Buffer.concat(chunks, length);
                if (
                  (code === 0 || state.finished) &&
                  !state.capped &&
                  !signal?.aborted &&
                  !spawnError
                )
                  Deferred.doneUnsafe(completion, Effect.succeed(output));
                else {
                  let message = 'Filesystem helper unavailable.';
                  if (state.capped)
                    message = 'Filesystem output/time limit reached; refine request.';
                  else if (signal?.aborted) message = 'Cancelled';
                  Deferred.doneUnsafe(
                    completion,
                    Effect.fail(
                      spawnError ??
                        Object.assign(Error(errors || message), {
                          status: code,
                          stderr: errors,
                          uncertain: !!killed || state.capped || signal?.aborted,
                          output,
                        }),
                    ),
                  );
                }
              });
              signal?.addEventListener('abort', state.stop, { once: true });
              if (signal?.aborted) state.stop();
              child.stdin!.end(input);
              return state;
            }),
            (state) =>
              Effect.gen(function* () {
                const stopped = yield* Effect.exit(
                  Effect.sync(() => {
                    if (!state.settled) state.stop();
                  }),
                );
                // Child error/abort is not exit: descriptors remain owned until close.
                yield* Effect.exit(Deferred.await(state.completion));
                if (state.stoppedAt !== undefined && state.child.pid !== undefined)
                  yield* awaitGroupExit(state.child.pid, state.stoppedAt);
                clearTimeout(state.escalation);
                yield* Effect.sync(() => {
                  signal?.removeEventListener('abort', state.stop);
                  state.child.removeAllListeners();
                  state.child.stdin?.removeAllListeners();
                  state.child.stdout?.removeAllListeners();
                  state.child.stderr?.removeAllListeners();
                });
                if (Exit.isFailure(stopped)) return yield* Effect.failCause(stopped.cause);
              }).pipe(
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (Exit.isFailure(exit)) reportCleanup(exit.cause);
                  }),
                ),
              ),
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
      ),
    );
}
const systemGit = '/usr/bin/git';
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
  return async () => {
    if (found) return;
    if (missingAt === undefined || now() - missingAt >= retryMs) {
      probing ??= probe().finally(() => (probing = undefined));
      if (await probing) found = true;
      else missingAt = now();
    }
    if (!found)
      fail('Unavailable', 'Git is unavailable. Install the Xcode command-line tools on this Mac.');
  };
}
export class Directory {
  readonly fd: number;
  readonly root: string;
  readonly expected: string;
  readonly run: Run;
  readonly gitExecutable: string;
  readonly gitReady: () => Promise<void>;
  constructor(
    root: string,
    expected: string,
    run: Run,
    gitExecutable: string,
    gitReady: () => Promise<void> = async () => {},
  ) {
    this.gitReady = gitReady;
    this.root = root;
    this.expected = expected;
    this.run = run;
    this.gitExecutable = gitExecutable;
    this.fd = openSync(root, flags);
    try {
      ensure(
        identity(fstatSync(this.fd)) === expected && realpathSync(root) === root,
        'Checkout directory changed. Restore its original identity.',
      );
      let parent = '/';
      for (const component of root.split('/').filter(Boolean)) {
        ensure(
          readdirSync(parent).includes(component),
          'Choose the actual checkout spelling without case or Unicode aliases.',
        );
        parent = resolve(parent, component);
      }
    } catch (error) {
      fs.closeSync(this.fd);
      throw error;
    }
  }
  private closed = false;
  close() {
    if (this.closed) return;
    this.closed = true;
    fs.closeSync(this.fd);
  }
  check() {
    const fd = openSync(this.root, flags);
    try {
      if (identity(fstatSync(fd)) !== this.expected)
        fail('Unauthorized', 'Checkout directory replaced. Reopen its original directory.');
    } finally {
      fs.closeSync(fd);
    }
  }
  io(args: string[], input?: string, signal?: AbortSignal, extra?: number[]) {
    this.check();
    return this.run(args, { fd: this.fd, input, signal, extra });
  }
  /** Runs like `io` but hands stdout to `onLine` line by line instead of buffering it. */
  async lines(args: string[], onLine: LineReader, signal?: AbortSignal) {
    this.check();
    await this.run(args, { fd: this.fd, signal, onLine });
  }
  /**
   * Runs Git in the checkout. `untranslated` runs it in the C locale, for output read back; other
   * commands keep the user's locale, which hooks and filters they run inherit.
   */
  async git(args: string[], input?: string, signal?: AbortSignal, { untranslated = false } = {}) {
    this.check();
    await this.gitReady();
    return this.run(
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
      { fd: this.fd, input, signal, ...(untranslated ? { env: gitLocale } : {}) },
    );
  }
  /** Makes the root a new repository; `git` above names a work tree, which needs one already. */
  async initializeGit(signal?: AbortSignal) {
    await this.gitReady();
    return this.io(['git', this.gitExecutable, 'init', '--quiet'], undefined, signal);
  }
  async entry(p: string, signal?: AbortSignal, spellings?: Map<string, Set<string>>) {
    path(p, true);
    this.check();
    if (p) {
      ensure(
        relative(this.root, realpathSync(resolve(this.root, p))) === p,
        'Use exact paths without mount or symbolic-link aliases.',
      );
      let parent = this.root;
      for (const component of p.split('/')) {
        const names = spellings?.get(parent) ?? new Set(readdirSync(parent));
        spellings?.set(parent, names);
        ensure(
          names.has(component),
          'Use the actual on-disk spelling without case or Unicode aliases.',
        );
        parent = resolve(parent, component);
      }
    }
    const fd = openSync(
      resolve(this.root, p),
      constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000,
    );
    try {
      const info = fstatSync(fd);
      ensure(info.isFile() || info.isDirectory(), 'Unsupported filesystem object.');
      return { identity: identity(info), directory: info.isDirectory() };
    } finally {
      fs.closeSync(fd);
    }
  }

  async read(p: string, signal?: AbortSignal): Promise<FileDocument> {
    path(p);
    await this.entry(p, signal);
    return document(await this.io(['read', p], undefined, signal));
  }
  async destination(p: string) {
    path(p);
    const parent = dirname(p);
    const item = await this.entry(parent === '.' ? '' : parent);
    ensure(item.directory, 'Destination parent must be a directory.');
    return item.identity;
  }
}
