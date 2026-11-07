import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const mock = !!process.env.MOONBASE_DEV_MOCK;
// A persistent dev profile, apart from the packaged app's, so state survives relaunches.
// Mock chats get their own profile so they never mix with chats you make in dev.
function findAppData() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32')
    return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}
process.env.MOONBASE_USER_DATA ??= join(findAppData(), mock ? 'Moonbase Dev Mock' : 'Moonbase Dev');
console.log(`Moonbase user data: ${process.env.MOONBASE_USER_DATA}`);
// Seeds only a profile with no local chats yet; existing chats are never replaced.
if (mock && !existsSync(join(process.env.MOONBASE_USER_DATA, 'local-pi-v1')))
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('seed-mock-chats.ts', import.meta.url)),
      process.env.MOONBASE_USER_DATA,
    ],
    { stdio: 'inherit' },
  );
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
