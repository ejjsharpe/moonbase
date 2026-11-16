import { Effect, Stream } from 'effect';
import fs, { constants, fstatSync, openSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { FileDocument } from '@moonbase/contracts/workspace';
import { document, path } from './validation.ts';
import {
  CheckoutAccessError,
  CheckoutChangedError,
  InvalidPathError,
} from '@moonbase/contracts/workspace-host-errors';
import { attempt, type WorkspaceFailure } from './attempt.ts';
import type { FilesystemHelper } from './filesystem-helper.ts';
/** macOS `O_NOFOLLOW_ANY`: refuse a symlink anywhere in the path, not only the last component. */
export const O_NOFOLLOW_ANY = 0x20000000;
const flags = constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY;
export const identity = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`;
/** Untranslated Git output, for commands whose text is read back. */
const gitLocale = { LC_ALL: 'C', LANGUAGE: undefined };
export class Directory {
  readonly fd: number;
  readonly root: string;
  readonly expected: string;
  readonly helper: FilesystemHelper;
  readonly gitExecutable: string;
  /** Refuses Git runs while the command-line tools are missing. */
  readonly gitReady: Effect.Effect<void, WorkspaceFailure>;
  constructor(
    root: string,
    expected: string,
    helper: FilesystemHelper,
    gitExecutable: string,
    gitReady: Effect.Effect<void, WorkspaceFailure> = Effect.void,
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
      this.helper.run(args, { fd: this.fd, input, extra }),
    );
  }
  /** Runs like `io` but streams stdout line by line instead of buffering it. */
  lines(args: string[]): Stream.Stream<string, WorkspaceFailure> {
    return Stream.unwrap(
      Effect.as(
        attempt(() => this.check()),
        this.helper.lines(args, { fd: this.fd }),
      ),
    );
  }
  /**
   * Runs Git in the checkout. `untranslated` runs it in the C locale, for output read back; other
   * commands keep the user's locale, which hooks and filters they run inherit.
   */
  git(args: string[], input?: string, { untranslated = false } = {}) {
    return attempt(() => this.check()).pipe(
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
