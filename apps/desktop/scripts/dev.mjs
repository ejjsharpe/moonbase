import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
if (!process.env.MOONBASE_USER_DATA)
  process.env.MOONBASE_USER_DATA = mkdtempSync(join(tmpdir(), 'moonbase-dev-'));
console.log(`Moonbase user data: ${process.env.MOONBASE_USER_DATA}`);
const require = createRequire(import.meta.url);
execFileSync(
  process.execPath,
  [require.resolve('nx/bin/nx.js'), 'run', '@moonbase/desktop:build'],
  {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    stdio: 'inherit',
  },
);
const child = spawn(
  require('electron'),
  [fileURLToPath(new URL('../dist/main.mjs', import.meta.url))],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } },
);
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
