import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { cp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { notices } from '../../../scripts/notices.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  require = createRequire(import.meta.url);
await rm(join(root, 'dist'), { recursive: true, force: true });
const main = await build({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
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
for (const inputs of [mainInputs, preloadInputs, rendererInputs]) {
  assert.deepEqual(
    inputs.filter((p) =>
      /(?:^|\/)(?:test|tests)\/|(?:packages\/workbench|apps\/desktop)\/demo\/|test-fixture|host\.mjs/.test(
        p,
      ),
    ),
    [],
    'Test fixture reached shipped application inputs',
  );
}
for (const inputs of [preloadInputs, rendererInputs]) {
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
for (const entry of [
  'pi-runtime/src/index.ts',
  'pi-runtime/src/local-models.ts',
  'pi-runtime/src/credentials.ts',
  'pi-ai/dist/bun-oauth.js',
])
  assert(
    mainInputs.some((path) => path.endsWith(entry)),
    `Missing privileged local runtime input: ${entry}`,
  );
const packages = await notices(
  [...Object.keys(main.metafile.inputs), ...Object.keys(preload.metafile.inputs)]
    .map((p) => resolve(root, p))
    .concat(rendererInputs, require.resolve('electron/package.json')),
  join(root, 'dist/dependency-notices.txt'),
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
