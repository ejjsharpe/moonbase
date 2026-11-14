import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { CommandInput, CommandOutput, WorkspaceCommand } from '@moonbase/contracts/workspace';
import { editorClientId } from '../../ipc/editor-rpcs.ts';
import type { IpcAuthorityError } from '../../ipc/ipc-errors.ts';

const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) => {
  const [x, y]: Record<string, unknown>[] = [a, b];
  const fields = Object.keys(x);
  return fields.length === Object.keys(y).length && fields.every((k) => x[k] === y[k]);
};
type Refusal = IpcAuthorityError['refusal'];

/**
 * What the editor's documents may name: checkouts main opened or adopted, and operations recovery
 * listed, for the app's lifetime; and, for one document, roots the native picker chose (each
 * opens once) and worktrees Git listed for an approved checkout. A renderer path grants nothing.
 */
export class EditorApprovals {
  private known = new Map<string, CheckoutTarget>();
  private operations = new Set<string>();
  /** One document's grants; a new document starts with none. */
  makeDocumentGrants() {
    return { roots: new Set<string>(), worktrees: new Set<string>() };
  }
  /** Approves a checkout the daemon made for a chat, so the renderer may open it. */
  adoptCheckout(target: CheckoutTarget) {
    this.known.set(target.checkoutId, target);
  }
  isApproved(target: CheckoutTarget) {
    const known = this.known.get(target.checkoutId);
    return !!known && sameCheckout(known, target);
  }
  /** Why the document may not send `operation` with `input`, if it may not. */
  findRefusal<K extends WorkspaceCommand>(
    operation: K,
    input: CommandInput<K>,
    grants: DocumentGrants,
  ): Refusal | undefined {
    const v = input as Record<string, unknown>;
    if ('checkout' in v && !this.isApproved(v.checkout as CheckoutTarget)) return 'checkout';
    if ('target' in v && !this.isApproved((v.target as { checkout: CheckoutTarget }).checkout))
      return 'checkout';
    const isOwnOperation = (clientId: unknown, id: unknown) =>
      clientId === editorClientId || this.operations.has(JSON.stringify([clientId, id]));
    if (operation === 'operationStatus') {
      if (!isOwnOperation(v.clientId, v.id)) return 'foreign-client';
    } else if ('clientId' in v && v.clientId !== editorClientId) return 'foreign-client';
    if (operation === 'acknowledgeOperation' && !isOwnOperation(v.operationClientId, v.id))
      return 'foreign-client';
    if (operation === 'persistRecovery') {
      const { state } = input as CommandInput<'persistRecovery'>;
      if (!state.checkouts.every((target) => this.isApproved(target))) return 'checkout';
    }
    if (operation === 'openCheckout') {
      const { root } = input as CommandInput<'openCheckout'>;
      // A picked root opens once; a listed worktree or a known checkout's root opens again.
      if (
        !grants.roots.delete(root) &&
        !grants.worktrees.has(root) &&
        ![...this.known.values()].some((target) => target.root === root)
      )
        return 'root';
    }
    // A renderer location would create directories anywhere; it needs a native grant first.
    if (operation === 'createWorktree') return 'worktree-location';
    return undefined;
  }
  /** Takes in what a command's reply approves. */
  record<K extends WorkspaceCommand>(
    operation: K,
    output: CommandOutput<K>,
    grants: DocumentGrants,
  ) {
    // After `git init` the folder's Git target replaces its approval under the same ID.
    if (operation === 'openCheckout' || operation === 'initializeRepository') {
      const target = output as CheckoutTarget;
      this.known.set(target.checkoutId, target);
    }
    if (operation === 'listWorktrees')
      for (const worktree of (output as CommandOutput<'listWorktrees'>).worktrees)
        grants.worktrees.add(worktree.root);
    if (operation === 'loadRecovery') {
      const load = output as CommandOutput<'loadRecovery'>;
      for (const target of load.state.checkouts) this.known.set(target.checkoutId, target);
      for (const fact of load.operations)
        this.operations.add(JSON.stringify([fact.clientId, fact.id]));
    }
  }
}
export type DocumentGrants = ReturnType<EditorApprovals['makeDocumentGrants']>;
