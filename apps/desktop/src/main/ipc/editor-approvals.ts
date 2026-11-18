import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { CommandInput, CommandOutput, WorkspaceCommand } from '@moonbase/contracts/workspace';
import { editorClientId } from '../../ipc/editor-rpcs.ts';
import type { IpcAuthorityError } from '@moonbase/contracts/ipc-errors';

const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) => {
  const [x, y]: Record<string, unknown>[] = [a, b];
  const fields = Object.keys(x);
  return fields.length === Object.keys(y).length && fields.every((k) => x[k] === y[k]);
};
type Refusal = IpcAuthorityError['refusal'];
type CommandCheck<K extends WorkspaceCommand> = (
  input: CommandInput<K>,
  grants: DocumentGrants,
) => Refusal | undefined;
type ReplyRecord<K extends WorkspaceCommand> = (
  output: CommandOutput<K>,
  grants: DocumentGrants,
) => void;
/** Commands whose client ID may name another client, whose operation their own check approves. */
const foreignClientCommands = new Set<WorkspaceCommand>(['operationStatus']);

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
    if (!foreignClientCommands.has(operation) && 'clientId' in v && v.clientId !== editorClientId)
      return 'foreign-client';
    const check = this.checks[operation] as CommandCheck<K> | undefined;
    return check?.(input, grants);
  }
  /** Takes in what a command's reply approves. */
  record<K extends WorkspaceCommand>(
    operation: K,
    output: CommandOutput<K>,
    grants: DocumentGrants,
  ) {
    const record = this.records[operation] as ReplyRecord<K> | undefined;
    record?.(output, grants);
  }
  private isOwnOperation(clientId: string, id: string) {
    return clientId === editorClientId || this.operations.has(JSON.stringify([clientId, id]));
  }
  /** The further checks of a command, after its checkouts and client ID. */
  private readonly checks: { [K in WorkspaceCommand]?: CommandCheck<K> } = {
    operationStatus: ({ clientId, id }) =>
      this.isOwnOperation(clientId, id) ? undefined : 'foreign-client',
    acknowledgeOperation: ({ operationClientId, id }) =>
      this.isOwnOperation(operationClientId, id) ? undefined : 'foreign-client',
    updateLayout: ({ layout }) =>
      layout.checkouts.every((target) => this.isApproved(target)) ? undefined : 'checkout',
    // A picked root opens once; a listed worktree or a known checkout's root opens again.
    openCheckout: ({ root }, grants) =>
      grants.roots.delete(root) ||
      grants.worktrees.has(root) ||
      [...this.known.values()].some((target) => target.root === root)
        ? undefined
        : 'root',
    // A renderer location would create directories anywhere; it needs a native grant first.
    createWorktree: () => 'worktree-location',
  };
  /** What a command's reply approves. */
  private readonly records: { [K in WorkspaceCommand]?: ReplyRecord<K> } = {
    openCheckout: (target) => this.known.set(target.checkoutId, target),
    // After `git init` the folder's Git target replaces its approval under the same ID.
    initializeRepository: (target) => this.known.set(target.checkoutId, target),
    listWorktrees: ({ worktrees }, grants) => {
      for (const worktree of worktrees) grants.worktrees.add(worktree.root);
    },
    loadRecovery: ({ state, operations }) => {
      for (const target of state.checkouts) this.known.set(target.checkoutId, target);
      for (const fact of operations) this.operations.add(JSON.stringify([fact.clientId, fact.id]));
    },
  };
}
export type DocumentGrants = ReturnType<EditorApprovals['makeDocumentGrants']>;
