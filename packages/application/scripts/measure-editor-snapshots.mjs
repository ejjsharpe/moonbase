import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ManagedRuntime } from 'effect';
import { createMoonbaseApplication } from '@moonbase/application';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { memoryWorkspace } from '@moonbase/application/testing/memory-workspace';

// Fail rather than measure a different checkout through stale workspace links.
const applicationRoot = fileURLToPath(new URL('../', import.meta.url));
for (const entry of [
  '@moonbase/application',
  '@moonbase/application/runtime/clients',
  '@moonbase/application/testing/memory-workspace',
])
  assert(realpathSync(fileURLToPath(import.meta.resolve(entry))).startsWith(applicationRoot));

const checkout = {
  hostId: 'local',
  checkoutId: 'measurement',
  projectId: 'measurement',
  root: '/memory/snapshot-measurement',
  branch: 'main',
  worktree: 'main',
};
const target = { checkout, path: 'file0.ts' };
const describe = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: Number(sorted[Math.floor(sorted.length / 2)].toFixed(4)),
    max: Number(sorted.at(-1).toFixed(4)),
  };
};

async function measure(count, activeBytes, restored = false) {
  const files = Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const size = index === 0 ? activeBytes : 512 * 1024;
      return [`file${index}.ts`, 'x'.repeat(size - 8) + String(index).padStart(8, '0')];
    }),
  );
  const memory = memoryWorkspace([{ checkout, files }]);
  const runtime = ManagedRuntime.make(memory.layer);
  const client = { ...makeEditorClient(runtime), watch: () => async () => {} };
  const options = { editors: [{ client, clientId: 'snapshot-measurement' }] };
  let app;
  try {
    app = await createMoonbaseApplication(options);
    let editor = app.editors[0];
    await editor.openCheckout(checkout.root);
    for (const path of Object.keys(files))
      await editor.open({ checkout, path }, { intent: 'keep' });
    await editor.open(target, { intent: 'keep' });
    await editor.flush();
    if (restored) {
      for (const [path, text] of Object.entries(files))
        editor.edit({ checkout, path }, text.slice(0, -1) + 'z');
      await editor.flush();
      await app.dispose();
      app = await createMoonbaseApplication(options);
      editor = app.editors[0];
      assert.equal(editor.getSnapshot().recovery.drafts.length, count);
    }
    assert.equal(editor.getSnapshot().recovery.views[checkout.checkoutId].active, target.path);
    const held = editor.getSnapshot();
    const expectedHeld = structuredClone(held);
    const texts = Array.from(
      { length: 25 },
      (_, index) => files[target.path].slice(0, -8) + String(index).padStart(8, '0'),
    );
    const editMs = [],
      positionMs = [];
    let notifications = 0;
    const off = editor.subscribe(() => notifications++);
    for (let index = 0; index < texts.length; index++) {
      await new Promise((resolve) => setImmediate(resolve));
      const publications = memory.stats.publications;
      const editStart = performance.now();
      editor.edit(target, texts[index]);
      const editElapsed = performance.now() - editStart;
      const positionStart = performance.now();
      editor.position(target, 'file', { line: 1, column: index + 1, top: 0, left: 0 });
      const positionElapsed = performance.now() - positionStart;
      if (index >= 5) {
        editMs.push(editElapsed);
        positionMs.push(positionElapsed);
      }
      assert.equal(memory.stats.publications, publications);
      assert.equal(editor.getSnapshot(), editor.getSnapshot());
    }
    off();
    assert.equal(notifications, 50);
    assert.equal(editor.buffer(target).text, texts.at(-1));
    assert.equal(editor.getSnapshot().buffers.length, count);
    assert.deepEqual(held, expectedHeld);
    await editor.flush();
    assert.equal(editor.getSnapshot().recoveryReady, true);
    return {
      count,
      activeBytes,
      unrelatedBytes: 512 * 1024,
      restored,
      editMs: describe(editMs),
      positionMs: describe(positionMs),
    };
  } finally {
    await app?.dispose();
    await runtime.dispose();
  }
}

console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    samples: 20,
    warmups: 5,
  }),
);
for (let sweep = 1; sweep <= 2; sweep++)
  for (const [count, activeBytes, restored] of [
    [1, 512 * 1024, false],
    [10, 512 * 1024, false],
    [20, 512 * 1024, false],
    [1, 4096, false],
    [20, 4096, false],
    [20, 512 * 1024, true],
  ])
    console.log(JSON.stringify({ sweep, ...(await measure(count, activeBytes, restored)) }));
