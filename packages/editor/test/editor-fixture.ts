import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime-client';
import { type CheckoutTarget } from '@moonbase/application/client';
import { createEditor } from '../src/editor.ts';
import { memoryWorkspace } from '../src/memory.ts';

export const checkout: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'first',
  projectId: 'project',
  root: '/memory/first',
  branch: 'main',
};
export const second: CheckoutTarget = {
  hostId: 'other-host',
  checkoutId: 'second',
  projectId: 'project',
  root: '/memory/second',
  branch: 'main',
};
export const target = (path: string, c = checkout) => ({ checkout: c, path });
export async function fixture(clientId = 'editor-one', observe = true) {
  const memory = memoryWorkspace(
    [checkout, second].map((checkout) => ({
      checkout,
      files: {
        'a.ts': 'const a = 1;',
        'b.ts': 'second',
        'c.ts': 'third',
        'folder/nested.ts': 'nested',
      },
      head: { 'a.ts': 'const a = 0;' },
      index: { 'a.ts': 'const a = 0.5;' },
      ignored: ['c.ts'],
    })),
  );
  const runtime = ManagedRuntime.make(memory.layer),
    client = makeEditorClient(runtime);
  const editor = createEditor({
    client: observe ? client : { ...client, watch: () => () => {} },
    clientId,
  });
  await editor.load();
  await editor.openCheckout(checkout.root);
  return {
    memory,
    runtime,
    client,
    editor,
    async dispose() {
      editor.dispose();
      await runtime.dispose();
    },
  };
}
