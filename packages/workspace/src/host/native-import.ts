import { NativeSourceError } from '@moonbase/contracts/workspace-host-errors';
import { O_NOFOLLOW_ANY } from '../filesystem.ts';
import fs, { openSync, fstatSync, constants } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';

const flags = constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY;
const identity = (s: { dev: number; ino: number }) => `${s.dev}:${s.ino}`;
// Gone (ENOENT/ENOTDIR) or replaced by a symlink, which the no-follow open refuses with ELOOP.
const isReplaced = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
};
/** Runs a reopen of a captured path, refusing with `problem` when the path is gone or replaced. */
const reopen = <T>(open: () => T, problem: 'parent-changed' | 'changed') => {
  try {
    return open();
  } catch (error) {
    if (isReplaced(error)) throw new NativeSourceError({ problem });
    throw error;
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
    this.parents = this.parentIdentities();
    this.fd = openSync(path, flags);
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
    if (reopen(() => this.parentIdentities(), 'parent-changed') !== this.parents)
      throw new NativeSourceError({ problem: 'parent-changed' });
    const fd = reopen(() => openSync(this.path, flags), 'changed');
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
