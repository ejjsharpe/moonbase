import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, type Metafile } from 'esbuild';

const entries = {
  index: '',
  editor: '/editor',
  'chat-clients': '/chat/clients',
  'chat-promises': '/chat/promises',
};
// One build of every entry; each entry's graph is the files reachable from it.
let metafile: Metafile;
before(async () => {
  ({ metafile } = await build({
    absWorkingDir: fileURLToPath(new URL('../../../../', import.meta.url)),
    entryPoints: Object.fromEntries(
      Object.entries(entries).map(([name, entry]) => [name, `@moonbase/application${entry}`]),
    ),
    bundle: true,
    platform: 'browser',
    write: false,
    outdir: 'out',
    metafile: true,
  }));
});
function readGraph(name: string) {
  const entryPoint = metafile.outputs[`out/${name}.js`]?.entryPoint;
  assert(entryPoint);
  const graph = new Set([entryPoint]);
  for (const path of graph)
    for (const { path: next, external } of metafile.inputs[path]?.imports ?? [])
      if (!external) graph.add(next);
  return graph;
}

for (const [name, entry] of Object.entries(entries))
  test(`application${entry} bundles without privileged or UI implementations`, () => {
    const graph = readGraph(name);
    assert.deepEqual(
      [...graph].filter((path) =>
        /packages\/(?:chat-runtime|daemon-protocol|ssh|workspace)\/|node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:react(?:-dom)?|monaco-editor)\/|electron|@earendil-works|node:/.test(
          path,
        ),
      ),
      [],
    );
    if (entry === '' || entry === '/editor')
      for (const owner of [
        'recovery/recovery-outbox-service',
        'unsaved-changes/unsaved-changes-service',
        'discovery/discovery-service',
      ])
        assert(
          graph.has(`packages/application/src/editor/${owner}.ts`),
          `The actual browser graph must include the private ${owner} owner`,
        );
  });
