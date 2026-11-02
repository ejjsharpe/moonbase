import { type Cause, Deferred, Effect, Exit } from 'effect';
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { FileDocument } from '@moonbase/application/client';
import { document, ensure, fail, path } from './validation.ts';
const flags = constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000;
export const identity = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`;
export type Run = (
  args: string[],
  options: { fd: number; input?: string; extra?: number[]; signal?: AbortSignal },
) => Promise<Buffer>;
export function makeRunner(
  helper: string,
  runEffect: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>,
  reportCleanup: (cause: Cause.Cause<never>) => void,
): Run {
  return (args, { fd, input, extra = [], signal }) =>
    runEffect(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* Effect.acquireRelease(
            Effect.sync(() => {
              if (signal?.aborted) throw Error('Cancelled');
              const completion = Deferred.makeUnsafe<Buffer, unknown>();
              const child = spawn(helper, args, {
                stdio: ['pipe', 'pipe', 'pipe', fd, ...extra],
                env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' },
              });
              const state = {
                child,
                completion,
                settled: false,
                capped: false,
                stop: () => {
                  child.kill('SIGKILL');
                },
              };
              let output = Buffer.alloc(0),
                errors = '',
                spawnError: unknown;
              child.stdout!.on('data', (chunk: Buffer) => {
                if (output.length + chunk.length > 16 * 1024 * 1024) {
                  state.capped = true;
                  state.stop();
                } else output = Buffer.concat([output, chunk]);
              });
              child.stderr!.on('data', (chunk: Buffer) => {
                errors = (errors + chunk.toString()).slice(0, 4096);
              });
              child.stdin!.on('error', () => {});
              child.once('error', (error) => {
                spawnError = error;
              });
              child.once('close', (code, killed) => {
                state.settled = true;
                if (code === 0 && !state.capped && !signal?.aborted && !spawnError)
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
export class Directory {
  readonly fd: number;
  readonly root: string;
  readonly expected: string;
  readonly run: Run;
  readonly gitExecutable: string;
  constructor(root: string, expected: string, run: Run, gitExecutable: string) {
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
      closeSync(this.fd);
      throw error;
    }
  }
  private closed = false;
  close() {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
  check() {
    const fd = openSync(this.root, flags);
    try {
      if (identity(fstatSync(fd)) !== this.expected)
        fail('Unauthorized', 'Checkout directory replaced. Reopen its original directory.');
    } finally {
      closeSync(fd);
    }
  }
  io(args: string[], input?: string, signal?: AbortSignal, extra?: number[]) {
    this.check();
    return this.run(args, { fd: this.fd, input, signal, extra });
  }
  git(args: string[], input?: string, signal?: AbortSignal) {
    return this.io(
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
      input,
      signal,
    );
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
      closeSync(fd);
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
