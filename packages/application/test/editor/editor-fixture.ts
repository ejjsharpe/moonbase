import { acquireEditor } from './editor-model-fixture.ts';
import { ManagedRuntime } from 'effect';
import {
  toWorkspaceClient,
  type WorkspaceClient,
} from '@moonbase/application/testing/editor-fixture';
import { type CheckoutTarget, type WorkspaceCommand } from '@moonbase/contracts/workspace';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';

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
  const memory = fauxWorkspace(
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
    client = toWorkspaceClient(runtime);
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
  const transport: { command?: WorkspaceClient['command'] } = {};
  const client: WorkspaceClient = {
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

/** The recovery edits a client sends the store. */
export const recoveryEdits: ReadonlySet<string> = new Set([
  'openTab',
  'closeTab',
  'updateDraft',
  'updateLayout',
]);

/** A client's durable recovery: its drafts, and each checkout's tab paths. */
export async function storedRecovery(client: WorkspaceClient, clientId: string) {
  const { state } = await client.command('loadRecovery', { clientId });
  const drafts = state.buffers.flatMap((b) =>
    b.draft ? [{ target: b.target, text: b.draft.text, disk: b.draft.disk }] : [],
  );
  const tabs = (checkoutId = checkout.checkoutId) =>
    (state.views[checkoutId]?.tabs ?? []).map(
      (id) => state.buffers.find((b) => b.id === id)!.target.path,
    );
  return { state, drafts, tabs };
}

/**
 * Wraps a client so a test can hold its next command of a name, or its next recovery edit
 * (`'edit'`), until released; `sent` lists each recovery edit as it reaches the store.
 */
export function holding(raw: WorkspaceClient) {
  const holds = new Map<string, { entered: () => void; promise: Promise<void> }>();
  const sent: { name: string; input: unknown }[] = [];
  const client: WorkspaceClient = {
    ...raw,
    command(name, input, options) {
      const edit = recoveryEdits.has(name);
      if (edit) sent.push({ name, input: structuredClone(input) });
      let key: string | undefined = name;
      if (!holds.has(key)) key = edit && holds.has('edit') ? 'edit' : undefined;
      if (!key) return raw.command(name, input, options);
      const hold = holds.get(key)!;
      holds.delete(key);
      hold.entered();
      return hold.promise.then(() => raw.command(name, input, options));
    },
  };
  return {
    client,
    sent,
    hold(name: WorkspaceCommand | 'edit') {
      const entered = held(),
        release = held();
      holds.set(name, { entered: entered.release, promise: release.promise });
      return { entered: entered.promise, release: release.release };
    },
  };
}
