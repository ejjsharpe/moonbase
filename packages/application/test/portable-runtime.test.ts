import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

for (const entry of [
  '',
  '/editor',
  '/runtime/handlers',
  '/runtime/clients',
  '/runtime/effect-client',
])
  test(`application${entry} bundles without privileged or UI implementations`, async () => {
    const bundle = await build({
      absWorkingDir: fileURLToPath(new URL('../../../', import.meta.url)),
      entryPoints: [`@moonbase/application${entry}`],
      bundle: true,
      platform: 'browser',
      write: false,
      metafile: true,
    });
    assert.deepEqual(
      Object.keys(bundle.metafile.inputs).filter((path) =>
        /packages\/(?:pi-runtime|ssh|workspace)\/|node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:react(?:-dom)?|monaco-editor)\/|electron|@earendil-works|node:/.test(
          path,
        ),
      ),
      [],
    );
    if (entry === '' || entry === '/editor')
      for (const owner of ['recovery-publications', 'preservation', 'discovery'])
        assert(
          `packages/application/src/features/editor/${owner}.ts` in bundle.metafile.inputs,
          `The actual browser graph must include the private ${owner} owner`,
        );
  });
