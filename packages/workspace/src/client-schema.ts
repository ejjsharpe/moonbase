import { Schema } from 'effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { hash, recovery } from './validation.ts';
import {
  OperationResultSchema,
  RecoveryPublicationSchema,
  SaveResultSchema,
  WorkspaceIdentifierSchema,
  WorkspaceOperationSchema,
  workspaceInputSchemas,
  decodeEditorRecovery,
} from '@moonbase/contracts/workspace-schema';
import { invalidStored } from './store.ts';
import {
  array,
  natural,
  optional,
  storedDocument,
  strictDecoders,
  struct,
  absolute,
} from './schema.ts';

export const ClientConfigurationSchema = struct({
  dataDirectory: absolute,
  installationId: WorkspaceIdentifierSchema,
  /** Host IDs whose checkouts are reopened on the connected host when recovery loads. */
  legacyHostIds: optional(array(Schema.String)),
});
const configuration = Schema.decodeUnknownSync(ClientConfigurationSchema, { reportInput: false });
export function decodeClientConfiguration(value: unknown) {
  try {
    return configuration(value);
  } catch {
    throw new ApplicationError({
      code: 'InvalidInput',
      message: 'Invalid workspace configuration.',
    });
  }
}
/** A save the client sent (or is about to send), kept until its outcome is in the recovery. */
export const SaveRecordSchema = struct({
  restorePending: optional(Schema.Boolean),
  recoveryRestored: optional(Schema.Boolean),
  recoveryPublication: optional(natural),
  baseline: optional(storedDocument),
  published: optional(Schema.Boolean),
  /** The host never admitted the request; its text was restored as a draft. */
  notStarted: optional(Schema.Boolean),
  hostAcknowledged: optional(Schema.Boolean),
  input: workspaceInputSchemas.saveFile,
  result: optional(
    SaveResultSchema.check(
      Schema.makeFilter((result) => hash(result.disk.text) === result.disk.version),
    ),
  ),
  message: optional(Schema.String),
});
/** An operation the client sent, or one the host's feed reported from another client. */
export const OperationRecordSchema = struct({
  publicationError: optional(Schema.String),
  publishedItems: optional(array(Schema.String)),
  input: WorkspaceOperationSchema,
  /** Reported by the host's feed rather than issued here; `input` then names no sources. */
  remote: optional(Schema.Boolean),
  hostAcknowledged: optional(Schema.Boolean),
  result: OperationResultSchema,
  publicationRevisions: Schema.Record(Schema.String, Schema.mutableKey(natural)),
  acknowledgedBy: array(WorkspaceIdentifierSchema),
});
const PublicationRecordSchema = struct({
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  receipt: RecoveryPublicationSchema,
});
export const FeedCursorSchema = struct({ sequence: natural, epoch: optional(Schema.String) });
export const FeedGapSchema = struct({ since: natural, checkoutId: Schema.String });
export type SaveRecord = typeof SaveRecordSchema.Type;
export type OperationRecord = typeof OperationRecordSchema.Type;
/** Fields rows carried before the host split; they are ignored, while other unknown fields stay refused. */
const legacyFields = ['started', 'temporary', 'recoveryRevision', 'paths', 'staging'];
const ignoringLegacy = (schema: Schema.Decoder<unknown>) => {
  const decode = strictDecoders({ row: schema }).row;
  return (value: unknown) =>
    decode(
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).filter(([name]) => !legacyFields.includes(name)))
        : value,
    );
};
export const clientDecoders = {
  ...strictDecoders({
    publications: natural,
    'recovery-publications': PublicationRecordSchema,
    /** Per host, the last operation-feed sequence this client has applied. */
    cursors: FeedCursorSchema,
    /** Per host and checkout, a feed gap that left drafts at their old paths. */
    gaps: FeedGapSchema,
    meta: WorkspaceIdentifierSchema,
    /** Per call, the request ID its host operation was (or is to be) sent under. */
    requests: struct({ requestId: WorkspaceIdentifierSchema }),
  }),
  saves: ignoringLegacy(SaveRecordSchema),
  operations: ignoringLegacy(OperationRecordSchema),
};
export function savedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidStored();
  return value;
}
export function parseRecovery(body: unknown, clientId: string) {
  try {
    if (typeof body !== 'string') throw Error();
    const state = decodeEditorRecovery(JSON.parse(body));
    recovery(state, clientId);
    return state;
  } catch {
    throw invalidStored();
  }
}
