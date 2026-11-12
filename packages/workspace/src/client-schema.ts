import { Schema } from 'effect';
import { ApplicationError, type EditorRecovery } from '@moonbase/contracts/workspace';
import { hash, recovery } from './validation.ts';
import {
  OperationResultSchema,
  RecoveryPublicationSchema,
  SaveResultSchema,
  WorkspaceIdentifierSchema,
  WorkspaceOperationSchema,
  workspaceInputSchemas,
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
  /** The store's identity to a file host; when absent the store adopts the one it holds or mints one. */
  installationId: optional(WorkspaceIdentifierSchema),
  /** How long loading recovery waits on the host before it gives up on it for this load. */
  hostWaitMs: optional(natural),
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
/**
 * A save the client sent (or is about to send). `state` is `sent` while its outcome is unknown,
 * `restored` once its text is back in the recovery as a draft while the outcome is still unknown,
 * `settled` once its outcome is in the recovery but the host has not been told, and `done` after.
 */
export const SaveRecordSchema = struct({
  state: Schema.Literals(['sent', 'restored', 'settled', 'done']),
  /** The client's publication count when the save began; text is restored only while it holds. */
  recoveryPublication: natural,
  baseline: storedDocument,
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
  /** Something is left to do: an outcome, a publication or an acknowledgement (indexed). */
  open: Schema.Boolean,
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
export const FeedCursorSchema = struct({ sequence: natural, epoch: Schema.String });
export const FeedGapSchema = struct({ hostId: Schema.String, checkoutId: Schema.String });
export type SaveRecord = typeof SaveRecordSchema.Type;
export type OperationRecord = typeof OperationRecordSchema.Type;
export type FeedCursor = typeof FeedCursorSchema.Type;
export const clientDecoders = {
  ...strictDecoders({
    publications: natural,
    'recovery-publications': PublicationRecordSchema,
    /** Per host and checkout, the last operation-feed sequence applied to the recovery. */
    'feed-cursors': FeedCursorSchema,
    /** Per host and checkout, a feed gap that left drafts at their old paths. */
    'feed-gaps': FeedGapSchema,
    meta: WorkspaceIdentifierSchema,
    /** Per call, the request ID its host operation was (or is to be) sent under. */
    requests: struct({ requestId: WorkspaceIdentifierSchema }),
    saves: SaveRecordSchema,
    operations: OperationRecordSchema,
  }),
};
export function savedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidStored();
  return value;
}
export function parseRecovery(body: unknown, clientId: string): EditorRecovery {
  try {
    if (typeof body !== 'string') throw Error();
    return recovery(JSON.parse(body), clientId);
  } catch {
    throw invalidStored();
  }
}
