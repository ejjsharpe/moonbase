import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let template: string | undefined;
/**
 * Makes `root` an empty Git repository on `main`, as `git init -q -b main` does: a copy of one
 * repository each test process initializes once, which is much cheaper than running Git each time.
 */
export function initRepository(root: string) {
  if (!template) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-repository-')));
    process.once('exit', () => rmSync(base, { recursive: true, force: true }));
    execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', join(base, 'repo')]);
    template = join(base, 'repo');
  }
  cpSync(template, root, { recursive: true });
}
