import assert from 'node:assert/strict';
import { build } from 'esbuild';

for (const entry of ['client', 'host-client', 'connection-client', 'chat-client']) {
  const path = `packages/application/src/${entry}.ts`;
  const result = await build({
    entryPoints: [path],
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true,
  });
  assert.deepEqual(Object.keys(result.metafile.inputs), [path]);
  assert(!/node:|electron|@moonbase\/(workspace|pi-runtime|ssh)/.test(result.outputFiles[0].text));
}
console.log('Verified browser-only command contracts.');

const chat = await build({
  entryPoints: ['@moonbase/chat'],
  bundle: true,
  platform: 'browser',
  write: false,
  metafile: true,
});
assert.deepEqual(Object.keys(chat.metafile.inputs).sort(), [
  'packages/application/src/client.ts',
  'packages/chat/src/controller.ts',
  'packages/chat/src/index.ts',
]);
console.log('Verified headless browser chat: controller and application contracts only.');
