import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
const output = new URL('../dist/', import.meta.url);
const inputs = JSON.parse(await readFile(new URL('renderer/module-inputs.json', output), 'utf8'));
assert.deepEqual(
  inputs.filter((p) =>
    /(?:^|\/)node_modules\/(?:electron|@moonbase\/(?:workspace|pi-runtime|ssh|connection))\/|packages\/(?:workspace|pi-runtime|ssh|connection)\/|packages\/application\/src\/(?:(?:services|handlers|runtime-client|host-health)|runtime\/(?:handlers|clients))\.ts|apps\/desktop\/src\/(?:main|session|preload|chat-preload|chat\/(?:config|session))\.ts|@earendil-works|pi-ai|pi-durable|node:sqlite|source-snapshot|node:/.test(
      p,
    ),
  ),
  [],
  'Privileged implementation reached the actual Vite renderer graph',
);
assert(inputs.some((p) => p.endsWith('application/src/features/editor/editor.ts')));
assert(inputs.some((p) => p.endsWith('contracts/src/errors.ts')));
assert(inputs.some((p) => p.includes('monaco-editor')));
assert(inputs.some((p) => p.endsWith('desktop/src/chat/view.tsx')));
assert(inputs.some((p) => p.endsWith('application/src/features/chat/controller.ts')));
const assets = await readdir(new URL('renderer/assets/', output));
assert.equal(
  assets.filter((name) => /^(editor|json|css|html|ts)\.worker.*\.js$/.test(name)).length,
  5,
);
assert(assets.some((name) => name.endsWith('.ttf')));
console.log(
  `Actual Vite desktop renderer: ${inputs.length} inputs, five workers/font, browser-safe Effect permitted, no privileged modules.`,
);
