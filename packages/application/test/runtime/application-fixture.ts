import { ManagedRuntime } from 'effect';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import { makeEditorClient } from '@moonbase/application/runtime/clients';

export const checkout = {
  hostId: 'local',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/memory/application',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
export const target = { checkout, path: 'a.ts' };
export function editorCapabilities() {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'original', 'b.ts': 'second' } }]);
  const runtime = ManagedRuntime.make(memory.layer);
  return { memory, runtime, client: makeEditorClient(runtime) };
}

export { fauxChat } from '@moonbase/application/testing/faux-chat';
