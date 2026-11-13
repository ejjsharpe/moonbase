import assert from 'node:assert/strict';
import { isPrivilegedDesktopInput } from '../../../scripts/boundaries.mjs';
import { readFile, readdir } from 'node:fs/promises';
const output = new URL('../dist/', import.meta.url);
const inputs = JSON.parse(await readFile(new URL('renderer/module-inputs.json', output), 'utf8'));
assert.deepEqual(
  inputs.filter(
    (p) =>
      isPrivilegedDesktopInput(p) ||
      /(?:^|\/)node_modules\/(?:electron|@moonbase\/(?:workspace|chat-runtime|daemon-protocol|ssh|connection))\/|packages\/(?:workspace|chat-runtime|daemon-protocol|ssh|connection)\/|packages\/workbench\/(?:demo|test)\/|packages\/contracts\/src\/services\.ts|packages\/application\/src\/testing\/|packages\/application\/src\/app\/(?:handlers|clients)\.ts|apps\/desktop\/src\/(?:main|session|preload|chat-preload|chat\/(?:config|session))\.ts|@earendil-works|pi-ai|pi-durable|node:sqlite|source-snapshot|node:/.test(
        p,
      ),
  ),
  [],
  'Privileged implementation reached the actual Vite renderer graph',
);
assert(inputs.some((p) => p.endsWith('application/src/app/composition.ts')));
assert(inputs.some((p) => p.endsWith('application/src/features/editor/editor.ts')));
assert(!inputs.some((p) => p.endsWith('desktop/src/renderer/cleanup.ts')));
assert(inputs.some((p) => p.endsWith('contracts/src/errors.ts')));
assert(inputs.some((p) => p.includes('monaco-editor')));
assert(
  inputs.some((p) => p.endsWith('node_modules/diff/libesm/patch/parse.js')),
  'Missing maintained recorded unified patch parser',
);
assert(
  inputs.some((p) => /node_modules\/react-markdown\//.test(p)) &&
    inputs.some((p) => /node_modules\/remark-gfm\//.test(p)),
  'Missing direct maintained Markdown parser',
);
for (const entry of [
  'packages/workbench/src/workbench.tsx',
  'apps/desktop/src/renderer/shell/workbench.tsx',
  'apps/desktop/src/renderer/chat/view.tsx',
  'apps/desktop/src/renderer/chat/transcript.tsx',
  'apps/desktop/src/renderer/chat/markdown.tsx',
])
  assert(inputs.some((p) => p.endsWith(entry)));
assert(!inputs.some((p) => /packages\/editor\//.test(p)));
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
