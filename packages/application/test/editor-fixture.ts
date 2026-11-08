import { acquireEditor } from './editor-model-fixture.ts';
import { ManagedRuntime } from 'effect';
import { makeEditorClient } from '@moonbase/application/runtime/clients';
import { type CheckoutTarget, type EditorClient } from '@moonbase/contracts/workspace';
import { memoryWorkspace } from '@moonbase/application/testing/memory-workspace';

export const checkout: CheckoutTarget = {
  hostId: 'local',
  checkoutId: 'first',
  projectId: 'project',
  root: '/memory/first',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
export const second: CheckoutTarget = {
  hostId: 'other-host',
  checkoutId: 'second',
  projectId: 'project',
  root: '/memory/second',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
export const target = (path: string, c: CheckoutTarget = checkout) => ({ checkout: c, path });
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
  const editor = await acquireEditor(runtime, {
    client: observe ? client : { ...client, watch: () => async () => {} },
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
      await editor.dispose();
      await runtime.dispose();
    },
  };
}

export const held = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

export async function observedFixture(clientId: string) {
  const f = await fixture(clientId, false);
  await f.editor.open(target('a.ts'), { view: 'staged' });
  await f.editor.open(target('b.ts'));
  await f.editor.openCheckout(second.root);
  await f.editor.open(target('a.ts', second));
  await f.editor.open(target('b.ts', second));
  await f.editor.selectCheckout(checkout);
  await f.editor.flush();
  await f.editor.dispose();
  const transport: { command?: EditorClient['command'] } = {};
  const client: EditorClient = {
    ...f.client,
    watch: () => async () => {},
    command(name, input, options) {
      return transport.command
        ? transport.command(name, input, options)
        : f.client.command(name, input, options);
    },
  };
  const editor = await acquireEditor(f.runtime, { client, clientId });
  await editor.load();
  return {
    ...f,
    raw: f.client,
    clientCommand: f.client.command,
    editor,
    client,
    transport,
    async dispose() {
      await editor.dispose();
      await f.dispose();
    },
  };
}
