import { NativeSourceError } from '@moonbase/contracts/workspace-host-errors';
import { O_NOFOLLOW_ANY } from '../filesystem.ts';
import fs, { openSync, fstatSync, lstatSync, constants, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';

const flags = constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY;
const identity = (s: { dev: number; ino: number }) => `${s.dev}:${s.ino}`;
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
/** Runs a no-follow open, refusing with `problem` when it fails with one of `codes`. */
const refuseOn = <T>(open: () => T, codes: string[], problem: NativeSourceError['problem']) => {
  try {
    return open();
  } catch (error) {
    if (codes.includes(errorCode(error) ?? '')) throw new NativeSourceError({ problem });
    throw error;
  }
};
// Gone (ENOENT/ENOTDIR) or replaced by a symlink, which the no-follow open refuses with ELOOP.
const replacedCodes = ['ENOENT', 'ENOTDIR', 'ELOOP'];
/** The path's own metadata, never following a final symlink, or undefined when it can't be read. */
const linkStat = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};
// Paths come from the daemon's host import capture (dropped or pasted Finder files).
// Retain the source descriptor, never a parent-directory descriptor or Project approval.
export class NativeImport {
  readonly source: string;
  readonly identity: string;
  readonly directory: boolean;
  readonly parents: string;
  readonly fd: number;
  readonly path: string;
  constructor(path: string, protectedPath: (path: string) => void) {
    this.path = path;
    if (
      !isAbsolute(path) ||
      path.includes('\0') ||
      path.split('/').some((p) => p === '.' || p === '..' || p.toLowerCase() === '.git')
    )
      throw new NativeSourceError({ problem: 'invalid-reference' });
    this.source = basename(path);
    if (!this.source) throw new NativeSourceError({ problem: 'filesystem-root' });
    protectedPath(path);
    // Finder names a source by its own path: one reached through a symlinked folder is not a
    // reference the host accepts, so the no-follow ancestor open's ELOOP is an invalid reference.
    this.parents = refuseOn(() => this.parentIdentities(), ['ELOOP'], 'invalid-reference');
    // A symlink (ELOOP) or socket (EOPNOTSUPP) fails the open before its type can be checked.
    this.fd = this.openSource('unsupported', (stat) => !stat.isFile() && !stat.isDirectory());
    try {
      const stat = fstatSync(this.fd);
      if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1))
        throw new NativeSourceError({ problem: 'unsupported' });
      this.identity = identity(stat);
      this.directory = stat.isDirectory();
      this.validate();
    } catch (error) {
      fs.closeSync(this.fd);
      throw error;
    }
  }
  /**
   * Opens the source without following links. When the open fails and the path's metadata shows
   * `refused`, refuses with `problem`; otherwise the open's own failure stands.
   */
  private openSource(problem: NativeSourceError['problem'], refused: (stat: Stats) => boolean) {
    try {
      return openSync(this.path, flags);
    } catch (error) {
      const stat = linkStat(this.path);
      if (stat && refused(stat)) throw new NativeSourceError({ problem });
      throw error;
    }
  }
  private parentIdentities(directory = dirname(this.path)) {
    const paths = ['/'];
    let current = '';
    for (const part of directory.split('/').filter(Boolean)) {
      current += '/' + part;
      paths.push(current);
    }
    return paths
      .map((path) => {
        const fd = openSync(path, flags | constants.O_DIRECTORY);
        try {
          return identity(fstatSync(fd));
        } finally {
          fs.closeSync(fd);
        }
      })
      .join(',');
  }
  containsDirectory(directory: string) {
    // Compare actual ancestor objects after no-follow opens, not path spelling or case folding.
    // Descriptors are closed immediately; this grants no ongoing parent authority.
    return this.directory && this.parentIdentities(directory).split(',').includes(this.identity);
  }
  validate() {
    // A captured path moved away or replaced since capture is a change, not a system failure.
    if (refuseOn(() => this.parentIdentities(), replacedCodes, 'parent-changed') !== this.parents)
      throw new NativeSourceError({ problem: 'parent-changed' });
    // Some replacements fail the open itself (a socket gives EOPNOTSUPP): its metadata confirms one.
    const fd = refuseOn(
      () =>
        this.openSource(
          'changed',
          (stat) => identity(stat) !== this.identity || stat.isDirectory() !== this.directory,
        ),
      replacedCodes,
      'changed',
    );
    try {
      const stat = fstatSync(fd);
      if (
        identity(stat) !== this.identity ||
        stat.isDirectory() !== this.directory ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw new NativeSourceError({ problem: 'changed' });
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Closes the source's descriptor; whoever holds the reference closes it once. */
  close() {
    fs.closeSync(this.fd);
  }
}
