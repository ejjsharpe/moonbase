import * as Schema from 'effect/Schema';
import { InvalidChatRequestError } from '@moonbase/contracts/chat-errors';
import { boundedText, naturalNumber, recordId } from './field-schemas.ts';

/**
 * Cursors are opaque to clients but carry no secret: base64url JSON. A token holder may already
 * read everything a cursor can reach, so a cursor only has to be well formed and belong to the read
 * it continues; each read is authorized again before its cursor is opened.
 */

/** Checks an opaque cursor: well-formed, NUL-free text of at most 1 KiB. */
export function checkCursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.includes('\0') ||
    !value.trim() ||
    Buffer.byteLength(value) > 1024
  )
    throw new InvalidChatRequestError({ problem: 'text' });
  return value;
}

/** Encodes a cursor's value as base64url JSON. */
export const writeCursor = (value: object) =>
  checkCursor(Buffer.from(JSON.stringify(value)).toString('base64url'));

/** Reads a cursor's JSON from its canonical base64url, refusing anything else. */
function readCursorJson(encoded: string): unknown {
  const bytes = Buffer.from(checkCursor(encoded), 'base64url');
  if (bytes.toString('base64url') !== encoded)
    throw new InvalidChatRequestError({ problem: 'cursor' });
  return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
}

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
    throw new InvalidChatRequestError({ problem: 'cursor' });
  }
}

// Pi owns scan positions. Only Moonbase's envelope and start sentinel are interpreted here.
const historyCursor = Schema.Struct({
  kind: Schema.Literals(['list', 'history']),
  conversationId: Schema.optional(boundedText(512)),
  scan: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
});
/** A list or history cursor's envelope around Pi's scan position. */
export function openHistoryCursor(encoded: string) {
  const result = decode(historyCursor, readCursorJson(encoded));
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
 * Find JSON token paths are bounded so a find cursor always fits the 1024-character cursor schema:
 * the other fields need at most 353 JSON bytes, leaving 415 of the 768 a cursor can encode.
 */
export const maximumFindPathDepth = 32;
export const maximumFindPathChars = 360;
const digest = Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/.test(value)));
const transcriptCursorSchema = Schema.Struct({
  kind: Schema.Literals(['manifest', 'content', 'around', 'find']),
  /** The digest of the read this cursor continues. */
  binding: digest,
  position: naturalNumber,
  revision: Schema.optional(digest),
  upper: Schema.optional(recordId),
  entries: Schema.optional(naturalNumber),
  bytes: Schema.optional(naturalNumber),
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
/** A transcript read's position: which read it continues and where. */
export type TranscriptCursor = typeof transcriptCursorSchema.Type;
/**
 * Opens a transcript cursor of `kind` for the read `binding` names. A malformed cursor, or one for
 * another read, is `transcript-cursor`; a position the read no longer has fails in that read.
 */
export function openTranscriptCursor(
  encoded: string,
  kind: TranscriptCursor['kind'],
  binding: string,
): TranscriptCursor {
  try {
    const value = decode(transcriptCursorSchema, readCursorJson(encoded));
    if (value.kind !== kind || value.binding !== binding) throw Error();
    return value;
  } catch {
    throw new InvalidChatRequestError({ problem: 'transcript-cursor' });
  }
}
