import { Schema, Struct } from 'effect';
import { isAbsolute } from 'node:path';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { hash, recovery } from './validation.ts';
import {
  CheckoutTargetSchema,
  FileDocumentSchema,
  OperationResultSchema,
  RecoveryPublicationSchema,
  SaveResultSchema,
  WorkspaceIdentifierSchema,
  WorkspaceOperationSchema,
  workspaceInputSchemas,
  decodeEditorRecovery,
} from '@moonbase/contracts/workspace-schema';

const struct = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));
const array = <S extends Schema.Constraint>(schema: S) => Schema.mutable(Schema.Array(schema));
const optional = Schema.optional;
const natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const absolute = Schema.String.check(Schema.makeFilter((s) => isAbsolute(s) && !s.includes('\0')));
const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const storedDocument = FileDocumentSchema.check(
  Schema.makeFilter((document) => hash(document.text) === document.version),
);
const operationItems = Schema.decodeUnknownSync(OperationResultSchema.fields.items, {
  onExcessProperty: 'error',
  reportInput: false,
});
const publishedItem = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      operationItems([JSON.parse(value)]);
      return true;
    } catch {
      return false;
    }
  }),
);
export const WorkspaceConfigurationSchema = struct({
  dataDirectory: absolute,
  hostId: WorkspaceIdentifierSchema,
  filesystemHelper: optional(absolute),
  gitExecutable: optional(absolute),
  ripgrepExecutable: optional(absolute),
});
const configuration = Schema.decodeUnknownSync(WorkspaceConfigurationSchema, {
  reportInput: false,
});
export function decodeConfiguration(value: unknown) {
  try {
    return configuration(value);
  } catch {
    throw new ApplicationError({
      code: 'InvalidInput',
      message: 'Invalid workspace configuration.',
    });
  }
}
export const ApprovalSchema = struct({
  target: CheckoutTargetSchema,
  identity: Schema.String,
  common: struct({ path: absolute, identity: Schema.String }),
  gitEntry: struct({ identity: Schema.String, pointer: Schema.NullOr(Schema.String) }),
});
export const SaveRecordSchema = struct({
  restorePending: optional(Schema.Boolean),
  recoveryRestored: optional(Schema.Boolean),
  recoveryPublication: optional(natural),
  recoveryRevision: optional(natural),
  baseline: optional(storedDocument),
  published: optional(Schema.Boolean),
  temporary: optional(Schema.String),
  input: workspaceInputSchemas.saveFile,
  result: optional(
    SaveResultSchema.check(
      Schema.makeFilter((result) => hash(result.disk.text) === result.disk.version),
    ),
  ),
  started: Schema.Boolean,
  message: optional(Schema.String),
});
export const OperationRecordSchema = struct({
  paths: optional(array(Schema.String)),
  publicationError: optional(Schema.String),
  staging: optional(array(Schema.String)),
  publishedItems: optional(array(publishedItem)),
  input: WorkspaceOperationSchema,
  result: OperationResultSchema,
  publicationRevisions: Schema.Record(Schema.String, Schema.mutableKey(natural)),
  acknowledgedBy: array(WorkspaceIdentifierSchema),
});
const PublicationRecordSchema = struct({
  digest,
  receipt: RecoveryPublicationSchema,
});
const stored = {
  approvals: ApprovalSchema,
  saves: SaveRecordSchema,
  operations: OperationRecordSchema,
  publications: natural,
  'recovery-publications': PublicationRecordSchema,
  meta: WorkspaceIdentifierSchema,
};
const decoders = Object.fromEntries(
  Object.entries(stored).map(([bucket, schema]) => [
    bucket,
    Schema.decodeUnknownSync(schema, {
      onExcessProperty: 'error',
      reportInput: false,
    }),
  ]),
);
export const invalidStored = () =>
  new ApplicationError({
    code: 'Persistence',
    message: 'Invalid workspace saved data. Original data retained; publication blocked.',
  });
export function savedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidStored();
  return value;
}
export function parseRecord<T>(bucket: string, body: unknown): T {
  try {
    if (typeof body !== 'string') throw Error();
    if (!Object.hasOwn(decoders, bucket)) throw Error();
    return decoders[bucket](JSON.parse(body)) as T;
  } catch {
    throw invalidStored();
  }
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
const NativeCaptureSchema = struct({
  checkout: CheckoutTargetSchema,
  clientId: WorkspaceIdentifierSchema,
  paths: array(absolute).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
const nativeCapture = Schema.decodeUnknownSync(NativeCaptureSchema, {
  onExcessProperty: 'error',
  reportInput: false,
});
export function decodeNativeCapture(value: unknown) {
  try {
    return nativeCapture(value);
  } catch {
    throw new ApplicationError({ code: 'InvalidInput', message: 'Invalid native capture input.' });
  }
}
