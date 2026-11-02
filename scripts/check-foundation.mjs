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

for (const [entry, owner] of [
  ['@moonbase/chat', 'chat'],
  ['@moonbase/editor/state', 'editor'],
]) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    assert(
      !/(?:^|\/)node_modules\/(?:react(?:-dom)?|monaco-editor|electron)\/|@earendil-works|pi-ai|pi-durable|node:/.test(
        input,
      ),
      `UI or privileged dependency reached ${entry}: ${input}`,
    );
    const module = input.match(/(?:^|\/)packages\/([^/]+)\//)?.[1];
    assert(
      module === undefined || module === owner || module === 'application',
      `Foreign package reached ${entry}: ${input}`,
    );
    assert(
      !/packages\/application\/src\/(?:services|handlers|runtime-client|host-health)\.ts$/.test(
        input,
      ),
      `Privileged application implementation reached ${entry}: ${input}`,
    );
  }
  console.log(
    `Verified headless browser ${owner}: browser-safe Effect permitted, no UI or backend.`,
  );
}
