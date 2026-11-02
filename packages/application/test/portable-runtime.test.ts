import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

for (const entry of ['handlers', 'clients', 'effect-client'])
  test(`runtime/${entry} bundles without privileged or UI implementations`, async () => {
    const bundle = await build({
      absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
      entryPoints: [`@moonbase/application/runtime/${entry}`],
      bundle: true,
      platform: 'browser',
      write: false,
      metafile: true,
    });
    assert.deepEqual(
      Object.keys(bundle.metafile.inputs).filter((path) =>
        /application\/src\/(?:services|host-health)\.ts|packages\/(?:pi-runtime|ssh|workspace)\/|node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:react(?:-dom)?|monaco-editor)\/|electron|@earendil-works|node:/.test(
          path,
        ),
      ),
      [],
    );
  });
