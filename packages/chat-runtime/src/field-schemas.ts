import { isAbsolute } from 'node:path';
import * as Schema from 'effect/Schema';

/** Well-formed, NUL-free, non-blank text of at most `bytes` UTF-8 bytes. */
export const boundedText = (bytes: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        value.isWellFormed() &&
        !value.includes('\0') &&
        !!value.trim() &&
        Buffer.byteLength(value) <= bytes,
    ),
  );
export const absolutePath = boundedText(4096).check(Schema.makeFilter(isAbsolute));
export const safeInteger = Schema.Number.check(Schema.makeFilter(Number.isSafeInteger));
export const naturalNumber = safeInteger.check(Schema.makeFilter((value) => value >= 0));
/** A Pi record id: a positive safe integer in decimal. */
export const recordId = Schema.String.check(
  Schema.makeFilter((value) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))),
);
