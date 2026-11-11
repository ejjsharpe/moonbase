import assert from 'node:assert/strict';
import { isPrivilegedDesktopInput } from '../../../scripts/boundaries.mjs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { cp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { notices } from '../../../scripts/notices.mjs';
import { bunComponents, verifyBunRuntime } from '../../../scripts/prepare-bun.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  repository = fileURLToPath(new URL('../../../', import.meta.url)),
  require = createRequire(import.meta.url);
// Packaging also stages the Bun runtime the bundled daemon runs on; development runs the daemon
// from source with the `bun` on PATH, so a plain build needs no runtime download.
const packaged = process.argv.includes('--package');
// The packaged daemon's runtime and its notices from `scripts/prepare-bun.mjs`, or another folder
// it prepared; either way they must be the pinned bytes, checked before anything is built.
const bun = process.env.MOONBASE_BUN_RUNTIME
  ? resolve(process.env.MOONBASE_BUN_RUNTIME)
  : join(repository, 'dist/tools/bun');
if (packaged) await verifyBunRuntime(bun);
await rm(join(root, 'dist'), { recursive: true, force: true });
// The daemon ships as a bundle for the Bun runtime, with Claude Code's helper beside it. Main
// embeds the bundle's build identifier, so a packaged app replaces a daemon of another build.
execFileSync(
  process.execPath,
  [
    join(repository, 'apps/daemon/scripts/build.mjs'),
    join(root, 'dist/daemon'),
    join(root, 'dist/daemon-inputs.json'),
    join(root, 'dist/daemon-build.json'),
  ],
  { stdio: 'inherit' },
);
const daemonInputs = JSON.parse(await readFile(join(root, 'dist/daemon-inputs.json'), 'utf8'));
const daemonBuild = JSON.parse(await readFile(join(root, 'dist/daemon-build.json'), 'utf8'));
assert.match(daemonBuild, /^[0-9a-f]{64}$/, 'The daemon bundle has no build identifier');
const main = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  define: { MOONBASE_DAEMON_BUILD: JSON.stringify(daemonBuild) },
  banner: {
    js: "import { createRequire as moonbaseCreateRequire } from 'node:module'; const require = moonbaseCreateRequire(import.meta.url);",
  },
  metafile: true,
  legalComments: 'external',
  logLevel: 'warning',
});
const preload = await build({
  absWorkingDir: root,
  entryPoints: ['src/preload.ts'],
  outfile: 'dist/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  metafile: true,
  legalComments: 'external',
  logLevel: 'warning',
});
execFileSync('vp', ['build', '--config', join(root, 'vite.config.ts')], {
  cwd: root,
  stdio: 'inherit',
});
const rendererInputs = JSON.parse(
  await readFile(join(root, 'dist/renderer/module-inputs.json'), 'utf8'),
);

for (const entry of [
  'packages/workbench/src/editor/workbench.tsx',
  'apps/desktop/src/renderer/shell/workbench.tsx',
  'apps/desktop/src/renderer/chat/view.tsx',
])
  assert(
    rendererInputs.some((p) => p.endsWith(entry)),
    `Shared frontend missing: ${entry}`,
  );
assert(!rendererInputs.some((p) => /packages\/editor\/|desktop\/src\/chat\/view\.tsx$/.test(p)));
const mainInputs = Object.keys(main.metafile.inputs),
  preloadInputs = Object.keys(preload.metafile.inputs);
for (const inputs of [mainInputs, preloadInputs, rendererInputs, daemonInputs]) {
  assert.deepEqual(
    inputs.filter((p) =>
      /(?:^|\/)(?:test|tests)\/|(?:packages\/workbench|apps\/desktop)\/demo\/|test-fixture|(?:^|\/)host\.mjs$/.test(
        p,
      ),
    ),
    [],
    'Test fixture reached shipped application inputs',
  );
}
for (const inputs of [preloadInputs, rendererInputs]) {
  assert.deepEqual(
    inputs.filter((path) =>
      isPrivilegedDesktopInput(path.startsWith('src/') ? `apps/desktop/${path}` : path),
    ),
    [],
    'Privileged desktop owner reached a browser boundary',
  );
  assert.deepEqual(
    inputs.filter((p) =>
      /@earendil-works|pi-runtime\/src\/(?:index|providers|credentials|local-models)\.ts|node:sqlite/.test(
        p,
      ),
    ),
    [],
    'Local runtime reached a browser boundary',
  );
}
// Local chat runs in the daemon: main holds only the daemon protocol's client side, never the chat
// runtime, provider setup, credentials, Claude Code or the protocol's server side.
assert.deepEqual(
  mainInputs.filter((path) =>
    /@earendil-works|pi-runtime\/src\/|daemon-protocol\/src\/(?!remote|loopback|protocol|validation|socket-client|socket-protocol)[^/]+\.ts$/.test(
      path,
    ),
  ),
  [],
  'The local chat runtime reached Electron main',
);
assert(
  !/\bsafeStorage\b/.test(await readFile(join(root, 'dist/main.mjs'), 'utf8')),
  'Electron main uses safeStorage',
);
for (const entry of [
  'daemon-protocol/src/remote.ts',
  'daemon-protocol/src/loopback.ts',
  'src/main/local-daemon.ts',
  'src/main/daemon-command.ts',
  'src/chat/daemon.ts',
])
  assert(
    mainInputs.some((path) => path.endsWith(entry)),
    `Missing local daemon client input: ${entry}`,
  );
assert(
  mainInputs.includes('src/chat/transcript-native.ts'),
  'Missing native transcript authority owner',
);
for (const entry of ['native-actions', 'ipc', 'window-lifecycle', 'chat-backends'])
  assert(mainInputs.includes(`src/main/${entry}.ts`), `Missing main owner: ${entry}`);
for (const entry of [
  'apps/daemon/src/main.ts',
  'pi-runtime/src/index.ts',
  'pi-runtime/src/claude-code.ts',
  'daemon-protocol/src/server.ts',
])
  assert(
    daemonInputs.some((path) => path.endsWith(entry)),
    `Missing daemon input: ${entry}`,
  );
assert(
  !daemonInputs.some((path) => /pi-runtime\/src\/host\.ts$|apps\/daemon\/test\//.test(path)),
  'The standalone host or a daemon test entry reached the daemon bundle',
);
if (packaged) {
  await mkdir(join(root, 'dist/helpers'), { recursive: true });
  await cp(join(bun, 'bun'), join(root, 'dist/helpers/bun'));
}
const packages = await notices(
  [...Object.keys(main.metafile.inputs), ...Object.keys(preload.metafile.inputs)]
    .map((p) => resolve(root, p))
    .concat(
      rendererInputs,
      daemonInputs.map((path) => resolve(repository, path)),
      require.resolve('electron/package.json'),
    ),
  join(root, 'dist/dependency-notices.txt'),
  packaged
    ? bunComponents.map(({ label, license, notices }) => ({
        label,
        license,
        directory: bun,
        files: notices.map((notice) => notice.file),
      }))
    : [],
);
await writeFile(join(root, 'dist/main-inputs.json'), JSON.stringify(main.metafile.inputs));
const resources = join(root, 'dist/workspace');
await mkdir(resources, { recursive: true });
await cp(require.resolve('@moonbase/workspace/filesystem'), join(resources, 'filesystem'));
const rg = process.env.MOONBASE_RIPGREP_ASSETS
  ? resolve(process.env.MOONBASE_RIPGREP_ASSETS)
  : fileURLToPath(new URL('../../../dist/tools/ripgrep', import.meta.url));
for (const file of ['rg', 'COPYING', 'LICENSE-MIT', 'UNLICENSE']) await stat(join(rg, file));
await cp(rg, join(resources, 'ripgrep'), { recursive: true });
await writeFile(
  join(root, 'dist/package.json'),
  JSON.stringify({
    name: 'moonbase',
    version: '0.1.0',
    private: true,
    main: 'main.mjs',
    description: 'Moonbase editor and local/remote agent workbench',
    author: 'Elliot Sharpe',
  }),
);
console.log(`Collected upstream notices for ${packages.length} bundled packages.`);
