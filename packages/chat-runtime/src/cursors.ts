import * as Schema from 'effect/Schema';
import { fail } from '@moonbase/contracts/errors';
import { boundedText, naturalNumber, recordId, safeInteger } from './field-schemas.ts';

// Cursors come back from clients, which are untrusted, so each is decoded when it is opened.
function decode<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S['Type'] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error', reportInput: false })(
      value,
    );
  } catch {
    return fail('InvalidInput', 'Invalid chat cursor.');
  }
}

// Pi owns scan positions. Only Moonbase's envelope and start sentinel are interpreted here.
const historyCursor = Schema.Struct({
  kind: Schema.Literals(['list', 'history']),
  conversationId: Schema.optional(boundedText(512)),
  scan: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
});
/** A list or history cursor's envelope around Pi's scan position. */
export function decodeHistoryCursor(value: unknown) {
  const result = decode(historyCursor, value);
  if (result.scan?.start === true)
    decode(Schema.Struct({ start: Schema.Literal(true) }), result.scan);
  return result;
}

const findPartPositionSchema = Schema.Struct({
  message: naturalNumber,
  block: naturalNumber,
  auxiliary: naturalNumber,
});
export type FindPartPosition = typeof findPartPositionSchema.Type;
/**
 * Find JSON token paths are bounded so a sealed find cursor always fits the 1024-character cursor
 * schema: the other fields need at most 353 JSON bytes, leaving 382 of the 735 a cursor can encode.
 */
export const maximumFindPathDepth = 32;
export const maximumFindPathChars = 360;
const digest = Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/.test(value)));
const transcriptCursorSchema = Schema.Struct({
  kind: Schema.Literals(['manifest', 'content', 'around', 'find']),
  binding: digest,
  position: naturalNumber,
  revision: Schema.optional(digest),
  upper: Schema.optional(recordId),
  entries: Schema.optional(safeInteger),
  bytes: Schema.optional(safeInteger),
  part: Schema.optional(findPartPositionSchema),
  path: Schema.optional(
    Schema.Array(naturalNumber).check(
      Schema.isMaxLength(maximumFindPathDepth),
      Schema.makeFilter((value) => JSON.stringify(value).length <= maximumFindPathChars),
    ),
  ),
  offset: Schema.optional(naturalNumber),
  textOffset: Schema.optional(naturalNumber),
  direction: Schema.optional(Schema.Literals(['older', 'newer'])),
});
/** A transcript read's sealed position: which read it continues and where. */
export type TranscriptCursor = typeof transcriptCursorSchema.Type;
export const decodeTranscriptCursor = (value: unknown): TranscriptCursor =>
  decode(transcriptCursorSchema, value);
