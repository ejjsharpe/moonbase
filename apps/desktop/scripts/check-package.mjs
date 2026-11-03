import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url),
  builder = createRequire(require.resolve('electron-builder')),
  library = createRequire(builder.resolve('app-builder-lib'));
const asar = library('@electron/asar');
const resources = join(
    root,
    `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Moonbase.app/Contents/Resources`,
  ),
  archive = join(resources, 'app.asar');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = asar.listPackage(archive).map((name) => name.replace(/^\//, ''));
assert(
  !files.some((name) =>
    /(?:^|\/)(?:test|tests|evidence|node_modules)\/|main-inputs|module-inputs|test-fixture|host\.mjs/.test(
      name,
    ),
  ),
  'Private graph/test metadata shipped in archive',
);
const records = [];
for (const name of [
  'main.mjs',
  'preload.cjs',
  'renderer/index.html',
  'dependency-notices.txt',
  ...files.filter((name) => /^renderer\/assets\/.+\.(?:js|css|ttf)$/.test(name)),
]) {
  const bytes = asar.extractFile(archive, name),
    source = await readFile(join(root, 'dist', name));
  assert(bytes.equals(source), `Packaged ${name} differs from built output`);
  records.push({ name, bytes: bytes.length, sha256: hash(bytes) });
}
const main = Object.keys(JSON.parse(await readFile(join(root, 'dist/main-inputs.json'), 'utf8'))),
  renderer = JSON.parse(await readFile(join(root, 'dist/renderer/module-inputs.json'), 'utf8'));

for (const entry of [
  'packages/workbench/src/editor/workbench.tsx',
  'apps/desktop/src/renderer/shell/workbench.tsx',
  'apps/desktop/src/renderer/chat/view.tsx',
])
  assert(
    renderer.some((p) => p.endsWith(entry)),
    `Shared frontend missing: ${entry}`,
  );
assert(!renderer.some((p) => /packages\/editor\/|desktop\/src\/chat\/view\.tsx$/.test(p)));
assert.deepEqual(
  [...main, ...renderer].filter((p) =>
    /(?:^|\/)(?:test|tests)\/|(?:packages\/workbench|apps\/desktop)\/demo\/|test-fixture|host\.mjs/.test(
      p,
    ),
  ),
  [],
);
assert.deepEqual(
  renderer.filter((p) => /@earendil-works|pi-runtime\/src\/|node:sqlite/.test(p)),
  [],
);
for (const entry of [
  'pi-runtime/src/index.ts',
  'pi-runtime/src/local-models.ts',
  'pi-runtime/src/credentials.ts',
  'pi-ai/dist/bun-oauth.js',
])
  assert(
    main.some((path) => path.endsWith(entry)),
    `Missing packaged local runtime input: ${entry}`,
  );
assert(
  !/@earendil-works|node:sqlite|safeStorage/.test(
    asar.extractFile(archive, 'preload.cjs').toString(),
  ),
);
assert.equal(
  files.filter((name) => /^renderer\/assets\/(editor|json|css|html|ts)\.worker.*\.js$/.test(name))
    .length,
  5,
);
for (const name of [
  'workspace/filesystem',
  'workspace/ripgrep/rg',
  'workspace/ripgrep/COPYING',
  'workspace/ripgrep/LICENSE-MIT',
  'workspace/ripgrep/UNLICENSE',
  'LICENSE.electron.txt',
  'LICENSES.chromium.html',
]) {
  const file = join(resources, name),
    bytes = await readFile(file),
    mode = (await stat(file)).mode & 0o777;
  if (['workspace/filesystem', 'workspace/ripgrep/rg'].includes(name))
    assert(mode & 0o111, `${name} is not executable`);
  records.push({ name, bytes: bytes.length, mode, sha256: hash(bytes) });
}
console.log(
  JSON.stringify(
    {
      archive: { path: archive, sha256: hash(await readFile(archive)) },
      inventory: files,
      mainInputs: main.length,
      rendererInputs: renderer.length,
      records,
    },
    null,
    2,
  ),
);
