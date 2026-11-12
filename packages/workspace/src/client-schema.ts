import { Schema } from 'effect';
import {
  ApplicationError,
  type CommandInput,
  type EditorRecovery,
  type SaveResult,
} from '@moonbase/contracts/workspace';
import { recovery } from './validation.ts';
import {
  OperationResultSchema,
  RecoveryChangeSchema,
  RecoveryPublicationSchema,
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
const { text: _text, ...saveRequestFields } = workspaceInputSchemas.saveFile.fields;
/**
 * A save the client sent (or is about to send), as stored: its request without the text, which
 * is kept apart (see `ClientStore.reserveSave`), so a record that changes stays small. `state` is
 * `sent` while its outcome is unknown, `restored` once its text is back in the recovery as a draft
 * while the outcome is still unknown, `settled` once its outcome is in the recovery but the host
 * has not been told, and `done` after.
 */
export const StoredSaveSchema = struct({
  state: Schema.Literals(['sent', 'restored', 'settled', 'done']),
  /** The client's publication count when the save began; text is restored only while it holds. */
  recoveryPublication: natural,
  request: struct(saveRequestFields),
  /**
   * The version of the text the draft held when the save began. Its text is the draft's baseline
   * in the recovery, or, when the save read it from the host, kept apart while the save is `sent`.
   */
  baseline: Schema.String,
  /** A `saved` outcome keeps only the version: its text is the request's. */
  result: optional(
    Schema.Union([
      struct({
        kind: Schema.Literal('saved'),
        version: Schema.String,
        recoveryChanges: array(RecoveryChangeSchema),
        persistencePending: optional(Schema.Boolean),
        message: optional(Schema.String),
      }),
      struct({ kind: Schema.Literal('conflict'), disk: storedDocument }),
    ]),
  ),
  message: optional(Schema.String),
});
export type StoredSave = typeof StoredSaveSchema.Type;
/**
 * A save with its text, as recovery works on it. The baseline's text is there when the save keeps
 * it (see `StoredSave.baseline`); its text is restored over the baseline only while it is `sent`.
 */
export type SaveRecord = Omit<StoredSave, 'request' | 'baseline' | 'result'> & {
  input: CommandInput<'saveFile'>;
  baseline: { version: string; text?: string };
  result?: SaveResult;
};
/** A save record as stored, without its text. */
export function toStoredSave({ input, baseline, result, ...rest }: SaveRecord): StoredSave {
  const { text: _text, ...request } = input;
  const stored: StoredSave = { ...rest, request, baseline: baseline.version };
  if (result?.kind === 'saved') {
    const { disk, ...saved } = result;
    stored.result = { ...saved, version: disk.version };
  } else if (result) stored.result = result;
  return stored;
}
/** A stored save record with its text, and its baseline's while it has one. */
export function fromStoredSave(
  { request, baseline, result, ...rest }: StoredSave,
  text: string,
  baselineText?: string,
): SaveRecord {
  const record: SaveRecord = {
    ...rest,
    input: { ...request, text },
    baseline:
      baselineText === undefined
        ? { version: baseline }
        : { version: baseline, text: baselineText },
  };
  if (result?.kind === 'saved') {
    const { version, ...saved } = result;
    record.result = { ...saved, disk: { text, version } };
  } else if (result) record.result = result;
  return record;
}
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
    'save-records': StoredSaveSchema,
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
