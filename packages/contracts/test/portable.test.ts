import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const clients = ['workspace', 'chat', 'connection', 'host', 'errors', 'common', 'lookup'];

for (const entry of clients)
  test(`${entry} has no Effect or platform runtime dependency`, async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [`@moonbase/contracts/${entry}`],
      bundle: true,
      platform: 'browser',
      write: false,
      metafile: true,
    });
    assert(
      Object.keys(result.metafile.inputs).every((path) => path.startsWith('packages/contracts/')),
    );
  });

test('type-only client imports emit no contracts or Effect runtime code', async () => {
  const result = await build({
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
  assert.deepEqual(Object.keys(result.metafile.inputs), ['<stdin>']);
  assert.equal(result.outputFiles[0].text, '');
});

for (const entry of [
  'chat-schema',
  'workspace-schema',
  'connection-schema',
  'host-schema',
  'error-schema',
  'schema',
  'services',
])
  test(`${entry} bundles with only independent contracts and portable Effect`, async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [`@moonbase/contracts/${entry}`],
      bundle: true,
      platform: 'browser',
      write: false,
      metafile: true,
    });
    for (const path of Object.keys(result.metafile.inputs))
      assert(
        /^(?:packages\/contracts\/|node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?effect\/)/.test(
          path,
        ),
        path,
      );
  });
