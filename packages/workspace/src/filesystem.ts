import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { FileDocument } from '@moonbase/application/client';
import { document, ensure, fail, path } from './validation.ts';
const flags = constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000;
export const identity = (stat: {dev: number; ino: number}) => `${stat.dev}:${stat.ino}`;
export type Run = (args: string[], options: { fd: number; input?: string; extra?: number[]; signal?: AbortSignal }) => Promise<Buffer>;
export function makeRunner(helper: string, children: Set<ChildProcess>): Run {
  return (args, {fd, input, extra = [], signal}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(Error('Cancelled')); return; }
    const child = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe', fd, ...extra], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' } });
    children.add(child);
    let output = Buffer.alloc(0), errors = '', capped = false;
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { capped = true; stop(); }, 30000);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => { if (output.length + chunk.length > 16 * 1024 * 1024) { capped = true; stop(); } else output = Buffer.concat([output, chunk]); });
    child.stderr!.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(0, 4096); });
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
    child.once('error', reject);
    child.once('close', (code, killed) => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop); children.delete(child);
      if (code === 0 && !capped && !signal?.aborted) resolve(output);
      else reject(Object.assign(Error(errors || (capped ? 'Filesystem output/time limit reached; refine request.' : signal?.aborted ? 'Cancelled' : 'Filesystem helper unavailable.')), { status: code, uncertain: !!killed || capped || signal?.aborted, output }));
    });
  });
}
export class Directory {
  readonly fd: number;
  constructor(readonly root: string, readonly expected: string, readonly run: Run, readonly gitExecutable: string) {
    this.fd = openSync(root, flags);
    try { ensure(identity(fstatSync(this.fd)) === expected && realpathSync(root) === root, 'Checkout directory changed. Restore its original identity.'); }
    catch (error) { closeSync(this.fd); throw error; }
  }
  close() { closeSync(this.fd); }
  check() {
    const fd = openSync(this.root, flags);
    try { if (identity(fstatSync(fd)) !== this.expected) fail('Unauthorized', 'Checkout directory replaced. Reopen its original directory.'); }
    finally { closeSync(fd); }
  }
  io(args: string[], input?: string, signal?: AbortSignal, extra?: number[]) {
    this.check(); return this.run(args, {fd: this.fd, input, signal, extra});
  }
  git(args: string[], input?: string, signal?: AbortSignal) {
    return this.io(['git', this.gitExecutable, '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.excludesFile=/dev/null', '--work-tree=.', ...args], input, signal);
  }
  async entry(p: string, signal?: AbortSignal) {
    path(p, true);
    if (p) ensure(relative(this.root, realpathSync(resolve(this.root, p))) === p, 'Use exact paths without case, mount or Unicode aliases.');
    const id = (await this.io(['identity', p || '.'], undefined, signal)).toString();
    return { identity: id, directory: fstatDirectory(this.root, p) };
  }
  async read(p: string, signal?: AbortSignal): Promise<FileDocument> { path(p); return document(await this.io(['read', p], undefined, signal)); }
  async destination(p: string) {
    path(p); const parent = dirname(p); const item = await this.entry(parent === '.' ? '' : parent);
    ensure(item.directory, 'Destination parent must be a directory.'); return item.identity;
  }
}
function fstatDirectory(root: string, p: string) {
  const fd = openSync(resolve(root, p), constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
  try { const info = fstatSync(fd); ensure(info.isFile() || info.isDirectory(), 'Unsupported filesystem object.'); return info.isDirectory(); }
  finally { closeSync(fd); }
}
