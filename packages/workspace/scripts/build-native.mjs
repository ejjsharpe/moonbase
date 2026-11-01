import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
if (process.platform !== 'darwin') throw Error('Moonbase workspace requires macOS descriptor-scoped filesystem APIs.');
mkdirSync(new URL('dist/', root), { recursive: true });
execFileSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', fileURLToPath(new URL('native/filesystem.c', root)), '-framework', 'CoreServices', '-o', fileURLToPath(new URL('dist/filesystem', root))], { stdio: 'inherit' });
