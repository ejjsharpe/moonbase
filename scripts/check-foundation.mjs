import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkBoundaries, readRepository } from './boundaries.mjs';
import './test-boundaries.mjs';
import './check-compatibility.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const migrationEdges = JSON.parse(
  readFileSync(new URL('./migration-boundaries.json', import.meta.url), 'utf8'),
);
assert.deepEqual(checkBoundaries(readRepository(root), new Set(Object.keys(migrationEdges))), []);
console.log(
  `Verified source ownership, public exports and cycles (${Object.keys(migrationEdges).length} exact migration edges).`,
);

for (const path of [
  ...['client', 'host-client', 'connection-client', 'chat-client'].map(
    (entry) => `@moonbase/application/${entry}`,
  ),
  ...['workspace', 'host', 'connection', 'chat', 'errors', 'common'].map(
    (entry) => `@moonbase/contracts/${entry}`,
  ),
]) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true,
  });
  assert(
    Object.keys(result.metafile.inputs).every((input) =>
      /^packages\/(?:application|contracts)\//.test(input),
    ),
    'DTO/client entries must emit no Effect/platform dependency',
  );
  assert(!/node:|electron|@moonbase\/(workspace|pi-runtime|ssh)/.test(result.outputFiles[0].text));
}
console.log('Verified browser-only command contracts.');

const smoke = await build({
  absWorkingDir: root,
  entryPoints: ['scripts/fixtures/headless.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
  metafile: true,
});
assert(
  Object.keys(smoke.metafile.inputs).some((input) => input.includes('packages/application/src/')),
);
for (const input of Object.keys(smoke.metafile.inputs)) {
  assert(
    !/(?:^|\/)node_modules\/(?:react(?:-dom)?|monaco-editor|electron)\/|@earendil-works|node:|packages\/(?:workspace|pi-runtime|ssh)\//.test(
      input,
    ),
    `Forbidden dependency in public headless consumer: ${input}`,
  );
}
console.log(
  `Verified public headless browser consumer (${Object.keys(smoke.metafile.inputs).length} actual bundle inputs).`,
);

for (const [entry, owner] of [
  ['@moonbase/application/chat', 'application'],
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
      module === undefined ||
        module === owner ||
        ['application', 'contracts', 'effect'].includes(module),
      `Foreign package reached ${entry}: ${input}`,
    );
    assert(
      !/packages\/application\/src\/(?:(?:services|handlers|runtime-client|host-health)|runtime\/(?:handlers|clients))\.ts$/.test(
        input,
      ),
      `Privileged application implementation reached ${entry}: ${input}`,
    );
  }
  console.log(
    `Verified headless browser ${owner}: browser-safe Effect permitted, no UI or backend.`,
  );
}
