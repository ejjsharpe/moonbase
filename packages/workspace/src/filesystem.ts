import { Effect, Stream } from 'effect';
import fs, { constants, fstatSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { decodeDocument, requirePath } from './validation.ts';
import {
  CheckoutAccessError,
  CheckoutChangedError,
  InvalidPathError,
  type WorkspaceUnavailableError,
} from '@moonbase/contracts/workspace-host-errors';
import type { FilesystemHelper } from './filesystem-helper.ts';
import { systemCall, type HelperFailure, type SystemFailure } from './system-failures.ts';
/** macOS `O_NOFOLLOW_ANY`: refuse a symlink anywhere in the path, not only the last component. */
export const O_NOFOLLOW_ANY = 0x20000000;
const flags = constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY;
export const identity = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`;
/** Runs `read` on an open descriptor, then closes it. Throws what the calls throw. */
export function withDescriptor<A>(fd: number, read: (fd: number) => A): A {
  try {
    return read(fd);
  } finally {
    fs.closeSync(fd);
  }
}
/** The metadata of the object an open of `path` with `openFlags` reaches. */
export const statDescriptor = (path: string, openFlags: number) =>
  withDescriptor(openSync(path, openFlags), (fd) => fstatSync(fd));
/** An entry of a checkout: its identity and whether it is a folder. */
export type Entry = { identity: string; directory: boolean };
/** Untranslated Git output, for commands whose text is read back. */
const gitLocale = { LC_ALL: 'C', LANGUAGE: undefined };
export class Directory {
  readonly fd: number;
  readonly root: string;
  readonly expected: string;
  readonly helper: FilesystemHelper;
  readonly gitExecutable: string;
  /** Refuses Git runs while the command-line tools are missing. */
  readonly gitReady: Effect.Effect<void, WorkspaceUnavailableError>;
  /**
   * Opens `root` and checks, in one synchronous step, that it is the object `expected` names at
   * its exact spelling. Throws what refuses it.
   */
  constructor(
    root: string,
    expected: string,
    helper: FilesystemHelper,
    gitExecutable: string,
    gitReady: Effect.Effect<void, WorkspaceUnavailableError> = Effect.void,
  ) {
    this.gitReady = gitReady;
    this.root = root;
    this.expected = expected;
    this.helper = helper;
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
  /** Refuses a root that is no longer the object it opened as. */
  check(): Effect.Effect<void, CheckoutAccessError | SystemFailure> {
    return systemCall(() => identity(statDescriptor(this.root, flags))).pipe(
      Effect.flatMap((found) =>
        found === this.expected
          ? Effect.void
          : Effect.fail(new CheckoutAccessError({ refusal: 'replaced' })),
      ),
    );
  }
  io(args: string[], input?: string, extra?: number[]) {
    return Effect.andThen(this.check(), this.helper.run(args, { fd: this.fd, input, extra }));
  }
  /** Runs like `io` but streams stdout line by line instead of buffering it. */
  lines(
    args: string[],
  ): Stream.Stream<string, CheckoutAccessError | SystemFailure | HelperFailure> {
    return Stream.unwrap(Effect.as(this.check(), this.helper.lines(args, { fd: this.fd })));
  }
  /**
   * Runs Git in the checkout. `untranslated` runs it in the C locale, for output read back; other
   * commands keep the user's locale, which hooks and filters they run inherit.
   */
  git(args: string[], input?: string, { untranslated = false } = {}) {
    return this.check().pipe(
      Effect.andThen(this.gitReady),
      Effect.andThen(
        this.helper.run(
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
    return Effect.andThen(this.gitReady, this.io(['git', this.gitExecutable, 'init', '--quiet']));
  }
  /** The object at `p`, refused unless `p` is its exact spelling with no link on the way. */
  entry(
    p: string,
    spellings?: Map<string, Set<string>>,
  ): Effect.Effect<Entry, InvalidPathError | CheckoutAccessError | SystemFailure> {
    return requirePath(p, true).pipe(
      Effect.andThen(this.check()),
      Effect.andThen(systemCall(() => this.locate(p, spellings))),
      Effect.flatMap((found) =>
        typeof found === 'string'
          ? Effect.fail(new InvalidPathError({ problem: found }))
          : Effect.succeed(found),
      ),
    );
  }
  /**
   * The no-follow lookup of `p` in one synchronous step, so the spelling checked is the object
   * opened: the entry, or why its path is refused.
   */
  private locate(
    p: string,
    spellings?: Map<string, Set<string>>,
  ): Entry | 'alias' | 'spelling' | 'unsupported' {
    if (p) {
      if (!(relative(this.root, realpathSync(resolve(this.root, p))) === p)) return 'alias';
      let parent = this.root;
      for (const component of p.split('/')) {
        const names = spellings?.get(parent) ?? new Set(readdirSync(parent));
        spellings?.set(parent, names);
        if (!names.has(component)) return 'spelling';
        parent = resolve(parent, component);
      }
    }
    const info = statDescriptor(
      resolve(this.root, p),
      constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY,
    );
    if (!(info.isFile() || info.isDirectory())) return 'unsupported';
    return { identity: identity(info), directory: info.isDirectory() };
  }
  read(p: string) {
    return requirePath(p).pipe(
      Effect.andThen(this.entry(p)),
      Effect.andThen(this.io(['read', p])),
      Effect.flatMap(decodeDocument),
    );
  }
  /** The identity of `p`'s parent folder, which a new object at `p` goes in. */
  destination(p: string) {
    return requirePath(p).pipe(
      Effect.andThen(() => {
        const parent = dirname(p);
        return this.entry(parent === '.' ? '' : parent);
      }),
      Effect.flatMap((item) =>
        item.directory
          ? Effect.succeed(item.identity)
          : Effect.fail(new InvalidPathError({ problem: 'destination-parent' })),
      ),
    );
  }
}
