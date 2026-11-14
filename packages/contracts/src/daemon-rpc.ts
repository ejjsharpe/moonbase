import * as Schema from 'effect/Schema';
import { voidResult } from './schema.ts';
import { Rpc, RpcGroup } from 'effect/rpc';
import { ApplicationError } from './errors.ts';
import { ChatHostTargetSchema, ChatIdentifierSchema } from './host-schema.ts';
import {
  hostProviderInputSchemas,
  hostProviderOutputSchemas,
  localHostInputSchemas,
  localHostOutputSchemas,
} from './daemon-schema.ts';
import { ProviderStateSchema } from './providers-schema.ts';
import { ProviderSetupDeltaSchema } from './socket-schema.ts';
import { RpcAdmission } from './rpc-admission.ts';

/** What every daemon procedure fails with on the wire. */
export const DaemonRpcErrorSchema = ApplicationError;
const request = <S extends Schema.Top>(input: S) => ({ host: ChatHostTargetSchema, input });
/** A reply's schema on the wire: no reply is `Schema.Void`, which encodes as JSON. */
const wire = <S extends Schema.Top>(schema: S) =>
  (schema === (voidResult as unknown) ? Schema.Void : schema) as S;
const localHost = <const K extends keyof typeof localHostInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: request(localHostInputSchemas[operation]),
    success: wire(localHostOutputSchemas[operation]),
    error: DaemonRpcErrorSchema,
  });
const providers = <const K extends keyof typeof hostProviderInputSchemas>(operation: K) =>
  Rpc.make(operation, {
    payload: request(hostProviderInputSchemas[operation]),
    success: wire(hostProviderOutputSchemas[operation]),
    error: DaemonRpcErrorSchema,
  });
export const ProviderSetupUpdateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('snapshot'), value: ProviderStateSchema }),
  Schema.Struct({ kind: Schema.Literal('delta'), delta: ProviderSetupDeltaSchema }),
]);

/** A local-mode daemon's folder approvals and control (`daemon-local-v1`, `folders-v1`, `roots-v1`). */
export class LocalHostRpcs extends RpcGroup.make(
  localHost('approveFolder'),
  localHost('listRecentFolders'),
  localHost('checkChatFolder'),
  localHost('checkApprovedFolder'),
  localHost('getActiveWork'),
  localHost('markFolderAsProject'),
  localHost('listHostFolders'),
).middleware(RpcAdmission) {}

/** Provider setup on a daemon, scoped to owners a client names (`providers-v1`). */
export class ProviderSetupRpcs extends RpcGroup.make(
  providers('getProviders'),
  providers('startProviderLogin'),
  providers('answerProviderPrompt'),
  providers('cancelProviderLogin'),
  providers('openProviderUrl'),
  providers('logoutProvider'),
  providers('releaseProviderOwner'),
  Rpc.make('watchProviderSetup', {
    payload: { host: ChatHostTargetSchema, ownerId: ChatIdentifierSchema },
    success: ProviderSetupUpdateSchema,
    error: DaemonRpcErrorSchema,
    stream: true,
  }),
).middleware(RpcAdmission) {}
