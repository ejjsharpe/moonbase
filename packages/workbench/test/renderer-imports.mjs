import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  bundle: true,
  write: false,
  outdir: 'dist/renderer-check',
  platform: 'browser',
  format: 'esm',
  metafile: true,
  loader: { '.ttf': 'file' },
  logLevel: 'silent',
});
const inputs = Object.keys(result.metafile.inputs);
const prohibited = inputs.filter((path) =>
  /node_modules[/\\](?:electron|@moonbase[/\\](?:workspace|chat-runtime|daemon-protocol|ssh))[/\\]|packages[/\\](?:workspace|chat-runtime|daemon-protocol|ssh)[/\\]|workbench[/\\](?:demo|test)[/\\]|apps[/\\]desktop[/\\]|contracts[/\\]src[/\\]services\.ts|application[/\\]src[/\\]testing[/\\]|@earendil-works|source-snapshot|(?:^|[/\\])host[/\\]|node:/.test(
    path,
  ),
);
assert.deepEqual(prohibited, [], 'Privileged or reference application code reached renderer entry');
assert(inputs.some((path) => path.endsWith('application/src/features/editor/editor.ts')));
assert(inputs.some((path) => path.endsWith('contracts/src/errors.ts')));
assert.deepEqual(
  inputs.filter((path) => /application[/\\]src[/\\]app[/\\](?:handlers|clients)\.ts$/.test(path)),
  [],
);
assert(inputs.some((path) => path.includes('monaco-editor')));
assert(inputs.includes('src/editor/workbench.tsx'), 'Missing project editor presentation');
assert.deepEqual(
  inputs.filter((path) =>
    /application\/src\/(?:features\/chat\/|runtime\/composition\.ts)|contracts\/src\/(?:chat|connection|host)(?:-schema)?\.ts|src\/(?:chat|shell)\//.test(
      path,
    ),
  ),
  [],
  'Application navigation or Chat reached the project workbench',
);
console.log(
  `Renderer browser bundle checked: ${inputs.length} inputs, browser-safe Effect permitted, no privileged implementations; ${result.outputFiles.reduce((size, file) => size + file.contents.length, 0)} emitted bytes.`,
);
