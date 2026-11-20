import * as Schema from 'effect/Schema';
import { Rpc, RpcGroup } from 'effect/rpc';
import { chatReadErrors } from './chat-rpc.ts';
import { CancelledError, UncertainError } from './errors.ts';
import { folderErrors } from './folder-errors.ts';
import { hostErrors, RequestReusedError } from './host-errors.ts';
import { ChatHostTargetSchema } from './host-schema.ts';
import { RpcAdmission } from './rpc-admission.ts';
import {
  findMarkedProcedures,
  isMutationRpc,
  isStatusRpc,
  Mutation,
  StatusCall,
} from './rpc-annotations.ts';
import { toWireReply } from './schema.ts';
import { fileHostErrors } from './workspace-host-errors.ts';
import {
  hostInputSchemas,
  hostOutputSchemas,
  WorkspaceWatchValueSchema,
} from './workspace-host-schema.ts';
import type { HostCommand } from './workspace-host.ts';
import { CheckoutTargetSchema } from './workspace-schema.ts';

// What each workspace procedure fails with on the wire: the host's errors every procedure can get,
// the file host's own, and the shared outcomes. Turn into project also passes on what the daemon's
// chats and folder approvals refused.
const unique = <A>(errors: readonly A[]) => [...new Set(errors)];
/** Any file host operation or the watch. */
export const workspaceErrors = unique([
  ...hostErrors,
  ...fileHostErrors,
  UncertainError,
  CancelledError,
]);
/** Turn into project: also the chat's and its folder's refusals and failures. */
export const chatProjectErrors = unique([
  ...workspaceErrors,
  ...chatReadErrors,
  ...folderErrors,
  RequestReusedError,
]);
const WorkspaceErrorSchema = Schema.Union(workspaceErrors),
  ChatProjectErrorSchema = Schema.Union(chatProjectErrors);
/** The error union a workspace operation or the watch declares; its `members` are the error classes. */
const workspaceErrorSchemaOf = (operation: HostCommand | 'watchWorkspace') =>
  operation === 'turnChatIntoProject' ? ChatProjectErrorSchema : WorkspaceErrorSchema;

/** One request: the host it is for, named at the top level, and the operation's input. */
const call = <const K extends HostCommand>(operation: K) =>
  Rpc.make(operation, {
    payload: { host: ChatHostTargetSchema, input: hostInputSchemas[operation] },
    success: toWireReply(hostOutputSchemas[operation]),
    error: workspaceErrorSchemaOf(operation),
  });

/**
 * The file host's operations and its watch, served on the workspace's own socket so a large file
 * never delays chat. The watch sends `{ready, revision, error?}` whole after each change.
 */
export class WorkspaceRpcs extends RpcGroup.make(
  call('openCheckout'),
  call('verifyCheckout'),
  call('readFile'),
  call('saveFile').annotate(Mutation, true),
  call('listDirectory'),
  call('getIgnoredPaths'),
  call('gitStatus'),
  call('listWorktrees'),
  call('createWorktree').annotate(Mutation, true),
  call('initializeRepository').annotate(Mutation, true),
  call('readComparison'),
  call('lookupFiles'),
  call('searchText'),
  call('inspectEntries'),
  call('mutate').annotate(Mutation, true),
  call('operationStatus').annotate(StatusCall, true),
  call('acknowledgeOperation').annotate(Mutation, true),
  call('saveStatus').annotate(StatusCall, true),
  call('acknowledgeSave').annotate(Mutation, true),
  call('listOperations'),
  call('createChatWorktree').annotate(Mutation, true),
  call('turnChatIntoProject').annotate(Mutation, true),
  call('captureImports').annotate(Mutation, true),
  call('releaseImports'),
  Rpc.make('watchWorkspace', {
    payload: { host: ChatHostTargetSchema, checkout: CheckoutTargetSchema },
    success: WorkspaceWatchValueSchema,
    error: WorkspaceErrorSchema,
    stream: true,
  }),
).middleware(RpcAdmission) {}
/** Every file host operation has its procedure. */
export const coversEveryOperation: [
  Exclude<HostCommand, Rpc.Tag<RpcGroup.Rpcs<typeof WorkspaceRpcs>>>,
] extends [never]
  ? true
  : never = true;

const hostMutations = findMarkedProcedures(WorkspaceRpcs, isMutationRpc);
const hostStatusCalls = findMarkedProcedures(WorkspaceRpcs, isStatusRpc);
/** Operations that change the host: a lost reply is `Uncertain` and is never sent again. */
export const isHostMutation = (operation: string) => hostMutations.has(operation);
/** The calls that resolve an `Uncertain` result, which keep places of their own. */
export const isHostStatusCall = (operation: string) => hostStatusCalls.has(operation);
/**
 * How long a client waits for a reply before it is lost: reads, lookup and search, mutations
 * (the helper's 30 s limit and a margin), and the Git steps of a worktree or `git init`. Past
 * it a mutation is `Uncertain`; `saveStatus` and `operationStatus` resolve it.
 */
export const hostDeadlinesMs = {
  read: 20_000,
  search: 30_000,
  mutation: 60_000,
  git: 120_000,
} as const;
export function hostDeadlineMs(operation: HostCommand): number {
  if (operation === 'lookupFiles' || operation === 'searchText') return hostDeadlinesMs.search;
  if (
    operation === 'createWorktree' ||
    operation === 'initializeRepository' ||
    operation === 'createChatWorktree'
  )
    return hostDeadlinesMs.git;
  return isHostMutation(operation) ? hostDeadlinesMs.mutation : hostDeadlinesMs.read;
}
