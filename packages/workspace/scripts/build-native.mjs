import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const root = new URL('../', import.meta.url);
if (process.platform !== 'darwin')
  throw Error('Moonbase workspace requires macOS descriptor-scoped filesystem APIs.');
const source = fileURLToPath(new URL('native/filesystem.c', root));
const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};
// The shipped helper, and the race tests' builds that pause for the test at one step each.
const binaries = [
  { output: 'dist/filesystem', defines: [] },
  { output: 'dist/test/filesystem-preflight', defines: ['-DESCODE_TEST_PREFLIGHT'] },
  { output: 'dist/test/filesystem-copy-stage', defines: ['-DESCODE_TEST_COPY_STAGE'] },
];
const inputs = Math.max(mtime(source), mtime(fileURLToPath(import.meta.url)));
const stale = binaries
  .map(({ output, defines }) => ({ output: fileURLToPath(new URL(output, root)), defines }))
  .filter(({ output }) => mtime(output) <= inputs);
await Promise.all(
  stale.map(async ({ output, defines }) => {
    mkdirSync(dirname(output), { recursive: true });
    // Suites in other packages run the helper while this one builds it, so it is replaced whole.
    const staged = `${output}.${process.pid}.tmp`;
    try {
      const { stderr } = await promisify(execFile)('/usr/bin/clang', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-O2',
        ...defines,
        source,
        '-framework',
        'CoreServices',
        '-o',
        staged,
      ]);
      process.stderr.write(stderr);
      renameSync(staged, output);
    } finally {
      rmSync(staged, { force: true });
    }
  }),
);
