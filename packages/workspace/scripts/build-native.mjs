import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
if (process.platform !== 'darwin')
  throw Error('Moonbase workspace requires macOS descriptor-scoped filesystem APIs.');
const source = fileURLToPath(new URL('native/filesystem.c', root));
const output = fileURLToPath(new URL('dist/filesystem', root));
const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};
mkdirSync(new URL('dist/', root), { recursive: true });
// Suites in other packages run the helper while this one builds it, so it is replaced whole.
if (mtime(output) <= Math.max(mtime(source), mtime(fileURLToPath(import.meta.url)))) {
  const staged = `${output}.${process.pid}.tmp`;
  try {
    execFileSync(
      '/usr/bin/clang',
      [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-O2',
        source,
        '-framework',
        'CoreServices',
        '-o',
        staged,
      ],
      { stdio: 'inherit' },
    );
    renameSync(staged, output);
  } finally {
    rmSync(staged, { force: true });
  }
}
