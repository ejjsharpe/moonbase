import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkBoundaries, readRepository } from './boundaries.mjs';
import './test-boundaries.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Effect may resolve outside the checkout, as it does from the foundation test's copy.
const portableInput =
  /^packages\/contracts\/|(?:^|\/)node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?effect\//;
assert.deepEqual(checkBoundaries(readRepository(root)), []);
console.log('Verified final source ownership, public exports and cycles; no migration exceptions.');

for (const entry of [
  'workspace',
  'host',
  'connection',
  'chat',
  'providers',
  'daemon',
  'errors',
  'common',
  'lookup',
]) {
  const path = `@moonbase/contracts/${entry}`;
  const result = await build({
    entryPoints: [path],
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true,
  });
  // `ApplicationError` is an Effect Schema class, so DTO entries carry portable Effect too.
  for (const input of Object.keys(result.metafile.inputs))
    assert(
      portableInput.test(input),
      `${entry} must bundle only contracts and portable Effect: ${input}`,
    );
  // Every input is bundled, so no Node, Electron or implementation import is left external.
  assert.deepEqual(
    Object.values(result.metafile.outputs).flatMap((output) => output.imports),
    [],
    `${entry} must import nothing outside its bundle`,
  );
}
console.log('Verified browser-only command contracts (contracts and portable Effect only).');

for (const entry of [
  'chat-schema',
  'chat-validation',
  'workspace-schema',
  'workspace-host-schema',
  'connection-schema',
  'host-schema',
  'daemon-schema',
  'providers-schema',
  'error-schema',
  'schema',
  'services',
]) {
  const result = await build({
    entryPoints: [`@moonbase/contracts/${entry}`],
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs))
    assert(
      portableInput.test(input),
      `${entry} must bundle only contracts and portable Effect: ${input}`,
    );
}
const typeOnly = await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import type { EditorClient } from '@moonbase/contracts/workspace';
      import type { ChatClient } from '@moonbase/contracts/chat';
      import type { ConnectionClient } from '@moonbase/contracts/connection';
      export type Clients = [EditorClient, ChatClient, ConnectionClient];
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  write: false,
  metafile: true,
});
assert.deepEqual(Object.keys(typeOnly.metafile.inputs), ['<stdin>']);
assert.equal(
  typeOnly.outputFiles[0].text,
  '',
  'type-only client imports must emit no runtime code',
);
console.log('Verified schema entries bundle only contracts and portable Effect.');

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
    !/(?:^|\/)node_modules\/(?:react(?:-dom)?|monaco-editor|electron)\/|@earendil-works|node:|packages\/(?:workspace|chat-runtime|daemon-protocol|ssh)\//.test(
      input,
    ),
    `Forbidden dependency in public headless consumer: ${input}`,
  );
}
console.log(
  `Verified public headless browser consumer (${Object.keys(smoke.metafile.inputs).length} actual bundle inputs).`,
);
const consumer = new URL('../test-results/headless/consumer.mjs', import.meta.url);
mkdirSync(new URL('./', consumer), { recursive: true });
writeFileSync(consumer, smoke.outputFiles[0].text);
assert.deepEqual(await (await import(consumer.href)).checkHeadlessApplication(), [
  'editor',
  'chat',
  'combined',
]);
console.log(
  `Executed emitted headless JavaScript: editor-only, chat-only and combined; ${smoke.outputFiles[0].contents.length} emitted bytes.`,
);

for (const [entry, owner] of [
  ['@moonbase/application/chat', 'application'],
  ['@moonbase/application/editor', 'application'],
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
      !/packages\/application\/src\/runtime\/(?:handlers|clients)\.ts$/.test(input),
      `Privileged application implementation reached ${entry}: ${input}`,
    );
  }
  console.log(
    `Verified headless browser ${owner}: browser-safe Effect permitted, no UI or backend.`,
  );
}
