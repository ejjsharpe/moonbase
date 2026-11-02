import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

test('effect-client bundles without privileged implementations or application services', async () => {
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
    entryPoints: ['@moonbase/application/effect-client'],
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true,
  });
  assert.deepEqual(
    Object.keys(bundle.metafile.inputs).filter((path) =>
      /application\/src\/(?:handlers|runtime-client|services|host-health)\.ts|packages\/(?:pi-runtime|ssh|workspace)\/|node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?react(?:-dom)?\/|electron|@earendil-works|node:/.test(
        path,
      ),
    ),
    [],
  );
});
