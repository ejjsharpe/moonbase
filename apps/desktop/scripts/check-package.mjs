import assert from 'node:assert/strict';
import { isPrivilegedDesktopInput } from '../../../scripts/boundaries.mjs';
import { bunComponents, bunExecutableSha256, bunVersion } from '../../../scripts/prepare-bun.mjs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)),
  repository = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url),
  builder = createRequire(require.resolve('electron-builder')),
  library = createRequire(builder.resolve('app-builder-lib'));
const asar = library('@electron/asar');
const contents = join(
    root,
    `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Moonbase.app/Contents`,
  ),
  resources = join(contents, 'Resources'),
  archive = join(resources, 'app.asar');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = asar.listPackage(archive).map((name) => name.replace(/^\//, ''));
assert(
  !files.some((name) =>
    /(?:^|\/)(?:test|tests|evidence|node_modules)\/|main-inputs|module-inputs|test-fixture|(?:^|\/)host\.mjs$/.test(
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

assert.deepEqual(
  renderer.filter(isPrivilegedDesktopInput),
  [],
  'Privileged desktop owner reached packaged renderer',
);
assert(main.includes('src/chat/transcript-native.ts'), 'Missing native transcript authority owner');
for (const entry of ['native-actions', 'ipc', 'window-lifecycle', 'chat-backends'])
  assert(main.includes(`src/main/${entry}.ts`), `Missing packaged main owner: ${entry}`);

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
    /(?:^|\/)(?:test|tests)\/|(?:packages\/workbench|apps\/desktop)\/demo\/|test-fixture|(?:^|\/)host\.mjs$/.test(
      p,
    ),
  ),
  [],
);
assert.deepEqual(
  renderer.filter((p) =>
    /@earendil-works|(?:chat-runtime|daemon-protocol)\/src\/|node:sqlite/.test(p),
  ),
  [],
);
// Local chat runs in the bundled daemon; packaged main holds only the protocol's client side.
assert.deepEqual(
  main.filter((path) =>
    /@earendil-works|chat-runtime\/src\/|daemon-protocol\/src\/server\//.test(path),
  ),
  [],
  'The local chat runtime reached packaged main',
);
for (const entry of [
  'daemon-protocol/src/client/remote.ts',
  'daemon-protocol/src/client/loopback.ts',
])
  assert(
    main.some((path) => path.endsWith(entry)),
    `Missing packaged daemon client input: ${entry}`,
  );
assert(
  !/\bsafeStorage\b/.test(asar.extractFile(archive, 'main.mjs').toString()),
  'Packaged main uses safeStorage',
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
// The daemon: Bun as a helper executable, and its bundle with Claude Code's helper script beside
// it in the resources. Nothing else ships with them: no test entries and no standalone host.
assert.deepEqual(await readdir(join(contents, 'Helpers')), ['bun'], 'Unexpected helper files');
assert.deepEqual(
  (await readdir(join(resources, 'daemon'))).sort(),
  ['daemon.mjs', 'inert-mcp.mjs'],
  'Unexpected daemon files',
);
const daemonFiles = [
  ['Helpers/bun', 'helpers/bun'],
  ['Resources/daemon/daemon.mjs', 'daemon/daemon.mjs'],
  ['Resources/daemon/inert-mcp.mjs', 'daemon/inert-mcp.mjs'],
];
for (const [name, built] of daemonFiles) {
  const file = join(contents, name),
    bytes = await readFile(file),
    mode = (await stat(file)).mode & 0o777;
  assert(
    bytes.equals(await readFile(join(root, 'dist', built))),
    `Packaged ${name} differs from dist`,
  );
  if (name === 'Helpers/bun') assert(mode & 0o111, `${name} is not executable`);
  records.push({ name, bytes: bytes.length, mode, sha256: hash(bytes) });
}
// The pinned runtime, checked by its bytes before it runs.
assert.equal(
  hash(await readFile(join(contents, 'Helpers/bun'))),
  bunExecutableSha256,
  'Packaged Bun executable checksum mismatch',
);
assert.equal(
  execFileSync(join(contents, 'Helpers/bun'), ['--version'], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  }).trim(),
  bunVersion,
  'Unexpected packaged Bun runtime',
);
// The daemon finds the app's ripgrep relative to its own bundle (`apps/daemon/src/ripgrep.ts`).
const daemonRipgrep = fileURLToPath(
  new URL('../workspace/ripgrep/rg', pathToFileURL(join(resources, 'daemon/daemon.mjs'))),
);
assert.equal(daemonRipgrep, join(resources, 'workspace/ripgrep/rg'));
assert((await stat(daemonRipgrep)).mode & 0o111, 'The daemon finds no executable ripgrep');
// Likewise the workspace's native helper (`apps/daemon/src/workspace.ts`): without it the daemon
// composes no file host.
const daemonHelper = fileURLToPath(
  new URL('../workspace/filesystem', pathToFileURL(join(resources, 'daemon/daemon.mjs'))),
);
assert.equal(daemonHelper, join(resources, 'workspace/filesystem'));
assert((await stat(daemonHelper)).mode & 0o111, 'The daemon finds no executable workspace helper');
const daemonInputs = JSON.parse(await readFile(join(root, 'dist/daemon-inputs.json'), 'utf8'));
// Main expects the build of the daemon bundle it ships, which writes that build to its endpoint.
const daemonBuild = JSON.parse(await readFile(join(root, 'dist/daemon-build.json'), 'utf8'));
assert.match(daemonBuild, /^[0-9a-f]{64}$/, 'The daemon bundle has no build identifier');
for (const [file, text] of [
  [
    join(resources, 'daemon/daemon.mjs'),
    await readFile(join(resources, 'daemon/daemon.mjs'), 'utf8'),
  ],
  [`${archive}/main.mjs`, asar.extractFile(archive, 'main.mjs').toString()],
])
  assert(text.includes(JSON.stringify(daemonBuild)), `${file} lacks the daemon build identifier`);
assert(!daemonInputs.some((path) => path.startsWith('/')), 'Daemon inputs record absolute paths');
assert(daemonInputs.includes('apps/daemon/src/main.ts'), 'The daemon bundle lost its entry');
assert.deepEqual(
  daemonInputs.filter((path) =>
    /(?:^|\/)(?:test|tests)\/|test-fixture|chat-runtime\/src\/host\.ts$|(?:^|\/)host\.mjs$/.test(
      path,
    ),
  ),
  [],
  'Test or standalone host input reached the daemon bundle',
);
// No credentials, tokens or development paths: nothing of this checkout, this home folder or any
// secret in this environment, and nothing shaped like a provider or GitHub key.
const secrets = Object.entries(process.env)
  .filter(
    ([name, value]) =>
      /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) && value && value.length >= 12,
  )
  .map(([, value]) => value);
for (const [name] of daemonFiles.slice(1)) {
  const text = await readFile(join(contents, name), 'utf8');
  for (const [label, found] of [
    ['this checkout', text.includes(repository.replace(/\/$/, ''))],
    ['this home folder', text.includes(homedir())],
    ['an environment secret', secrets.some((secret) => text.includes(secret))],
    [
      'a key',
      /sk-(?:ant|proj)-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{22,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(
        text,
      ),
    ],
  ])
    assert(!found, `${name} embeds ${label}`);
}
// The notices cover the runtime, the WebKit and libraries it links, the packages in its lockfiles
// and every package in the daemon bundle.
const shippedNotices = asar.extractFile(archive, 'dependency-notices.txt').toString();
for (const { label, license, notices } of bunComponents) {
  assert(shippedNotices.includes(`${label} (${JSON.stringify(license)})`), `Notices omit ${label}`);
  for (const { file } of notices)
    assert(shippedNotices.includes(`\n${file}\n`), `Notices omit ${file}`);
}
for (const text of [
  'Bun itself is MIT-licensed.',
  'GNU LIBRARY GENERAL PUBLIC LICENSE',
  'GNU LESSER GENERAL PUBLIC LICENSE',
])
  assert(shippedNotices.includes(text), `Notices omit ${text}`);
for (const path of daemonInputs.filter((path) => path.includes('node_modules/'))) {
  const parts = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length).split('/');
  const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (name.startsWith('@moonbase/')) continue;
  assert(
    shippedNotices.includes('\n' + name + '@') || shippedNotices.startsWith(name + '@'),
    `Notices omit daemon package ${name}`,
  );
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
