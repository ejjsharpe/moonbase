import { createHash } from 'node:crypto';
import type { Cursor } from '@earendil-works/pi-durable';
import { Effect } from 'effect';
import * as Schema from 'effect/Schema';
import { readObject } from '@moonbase/contracts/common';
import { InvalidChatRequestError } from '@moonbase/contracts/chat-errors';
import { boundedText, naturalNumber, recordId } from './field-schemas.ts';

/**
 * Cursors are opaque to clients but carry no secret: base64url JSON. A token holder may already
 * read everything a cursor can reach, so a cursor only has to be well formed and belong to the read
 * it continues; each read is authorized again before its cursor is opened.
 */

/** Whether a cursor is well-formed, NUL-free text of at most 1 KiB. */
const isCursorText = (value: string) =>
  value.isWellFormed() &&
  !value.includes('\0') &&
  !!value.trim() &&
  Buffer.byteLength(value) <= 1024;

/** Encodes a cursor's value as base64url JSON. */
export const writeCursor = (value: object): Effect.Effect<string, InvalidChatRequestError> => {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return isCursorText(encoded)
    ? Effect.succeed(encoded)
    : Effect.fail(new InvalidChatRequestError({ problem: 'text' }));
};

/**
 * Reads a cursor's JSON from its canonical base64url and decodes it against `schema`. Cursors come
 * back from clients, which are untrusted, so each is decoded when it is opened; the caller names
 * what any failure is.
 */
const readCursor = <S extends Schema.ConstraintDecoder<unknown, never>>(
  encoded: string,
  schema: S,
): Effect.Effect<S['Type'], unknown> =>
  Effect.gen(function* () {
    if (!isCursorText(encoded)) return yield* Effect.fail('text');
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return yield* Effect.fail('encoding');
    const value = yield* Effect.try(() =>
      JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
    );
    return yield* Schema.decodeUnknownEffect(schema, {
      onExcessProperty: 'error',
      reportInput: false,
    })(value);
  });

// Pi owns scan positions. Only Moonbase's envelope and start sentinel are interpreted here.
const historyCursor = Schema.Struct({
  kind: Schema.Literals(['list', 'history']),
  conversationId: Schema.optional(boundedText(512)),
  scan: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
});
/** A listing cursor is bound to the store's identity, and a history cursor also to its chat. */
export function getScanCursorScope(identity: string, conversationId?: string) {
  const owner = createHash('sha256').update(identity).digest('hex');
  return conversationId === undefined ? owner : owner + ':' + conversationId;
}
const scanStart = Schema.Struct({ start: Schema.Literal(true) });
/** Opens a list or history cursor of `kind` in `scope`: Pi's scan position, or none at the start. */
export const openScanCursor = (
  encoded: string | undefined,
  kind: 'list' | 'history',
  scope: string,
): Effect.Effect<Cursor | undefined, InvalidChatRequestError> =>
  encoded === undefined
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        const value = yield* readCursor(encoded, historyCursor);
        if (value.scan?.start === true)
          yield* Schema.decodeUnknownEffect(scanStart, { onExcessProperty: 'error' })(value.scan);
        if (value.kind !== kind || value.conversationId !== scope)
          return yield* Effect.fail('other-read');
        return value.scan === null || value.scan?.start === true
          ? undefined
          : ((yield* Effect.try(() => readObject(value.scan))) as Cursor);
      }).pipe(Effect.mapError(() => new InvalidChatRequestError({ problem: 'history-cursor' })));
/** A list or history cursor for Pi's scan position; none once the scan is done. */
export const writeScanCursor = (
  scan: Cursor | { start: true } | undefined,
  kind: 'list' | 'history',
  scope: string,
): Effect.Effect<string | null, InvalidChatRequestError> =>
  scan === undefined ? Effect.succeed(null) : writeCursor({ kind, conversationId: scope, scan });

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
/**
 * Find's counters and text offsets stay far below 2^53, so a forged cursor's next page cannot
 * overflow a safe integer: one page adds at most a slice's bytes and rows to them.
 */
const findCount = naturalNumber.check(Schema.makeFilter((value) => value <= 2 ** 40));
const digest = Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/.test(value)));
const transcriptCursorSchema = Schema.Struct({
  kind: Schema.Literals(['manifest', 'content', 'around', 'find']),
  /** The digest of the read this cursor continues. */
  binding: digest,
  position: naturalNumber,
  revision: Schema.optional(digest),
  upper: Schema.optional(recordId),
  entries: Schema.optional(findCount),
  bytes: Schema.optional(findCount),
  part: Schema.optional(findPartPositionSchema),
  path: Schema.optional(
    Schema.Array(naturalNumber).check(
      Schema.isMaxLength(maximumFindPathDepth),
      Schema.makeFilter((value) => JSON.stringify(value).length <= maximumFindPathChars),
    ),
  ),
  offset: Schema.optional(findCount),
  textOffset: Schema.optional(findCount),
  direction: Schema.optional(Schema.Literals(['older', 'newer'])),
});
/** A transcript read's position: which read it continues and where. */
export type TranscriptCursor = typeof transcriptCursorSchema.Type;
/**
 * Opens a transcript cursor of `kind` for the read `binding` names. A malformed cursor, or one for
 * another read, is `transcript-cursor`; a position the read no longer has fails in that read.
 */
export const openTranscriptCursor = (
  encoded: string,
  kind: TranscriptCursor['kind'],
  binding: string,
): Effect.Effect<TranscriptCursor, InvalidChatRequestError> =>
  Effect.gen(function* () {
    const value = yield* readCursor(encoded, transcriptCursorSchema);
    if (value.kind !== kind || value.binding !== binding) return yield* Effect.fail('other-read');
    return value;
  }).pipe(Effect.mapError(() => new InvalidChatRequestError({ problem: 'transcript-cursor' })));
