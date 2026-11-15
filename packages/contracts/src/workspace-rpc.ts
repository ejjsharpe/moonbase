import * as Schema from 'effect/Schema';
import { Rpc, RpcGroup } from 'effect/rpc';
import { chatReadErrors } from './chat-rpc.ts';
import { CancelledError, UncertainError } from './errors.ts';
import { folderErrors } from './folder-errors.ts';
import { hostErrors, RequestReusedError } from './host-errors.ts';
import { ChatHostTargetSchema } from './host-schema.ts';
import { RpcAdmission } from './rpc-admission.ts';
import { voidResult } from './schema.ts';
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
export const workspaceErrorSchemaOf = (operation: HostCommand | 'watchWorkspace') =>
  operation === 'turnChatIntoProject' ? ChatProjectErrorSchema : WorkspaceErrorSchema;

/** A reply's schema on the wire: no reply is `Schema.Void`, which encodes as JSON. */
const wire = <S extends Schema.Top>(schema: S) =>
  (schema === (voidResult as unknown) ? Schema.Void : schema) as S;
/** One request: the host it is for, named at the top level, and the operation's input. */
const call = <const K extends HostCommand>(operation: K) =>
  Rpc.make(operation, {
    payload: { host: ChatHostTargetSchema, input: hostInputSchemas[operation] },
    success: wire(hostOutputSchemas[operation]),
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
  call('saveFile'),
  call('listDirectory'),
  call('getIgnoredPaths'),
  call('gitStatus'),
  call('listWorktrees'),
  call('createWorktree'),
  call('initializeRepository'),
  call('readComparison'),
  call('lookupFiles'),
  call('searchText'),
  call('inspectEntries'),
  call('mutate'),
  call('operationStatus'),
  call('acknowledgeOperation'),
  call('saveStatus'),
  call('acknowledgeSave'),
  call('listOperations'),
  call('createChatWorktree'),
  call('turnChatIntoProject'),
  call('captureImports'),
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
