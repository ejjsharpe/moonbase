import { isPathAtOrInside } from '@moonbase/contracts/paths';
import { normalizeApplicationError } from '@moonbase/effect';
import {
  InvalidWorkspaceRequestError,
  isWorkspaceHostError,
} from '@moonbase/contracts/workspace-host-errors';
import { isCheckoutPath, isWellFormed } from '@moonbase/contracts/workspace-schema';
import { createHash } from 'node:crypto';
import {
  maximumFileBytes,
  type CheckoutTarget,
  type FileDocument,
  type GitCheckoutTarget,
  type OperationResult,
  type WorkspaceOperation,
} from '@moonbase/contracts/workspace';
export const ensure: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new InvalidWorkspaceRequestError({ reason: message });
};
/** Refuses a path that is not exactly checkout-relative (see `isCheckoutPath`). */
export function path(value: unknown, directory = false): asserts value is string {
  ensure(
    typeof value === 'string' && isCheckoutPath(value, directory),
    'Use an exact checkout-relative path without traversal, links or metadata.',
  );
}
/** Refuses a Git-only operation on a plain-folder checkout. */
export function requireGit(target: CheckoutTarget): asserts target is GitCheckoutTarget {
  ensure(target.vcs === 'git', 'This project is not a Git repository. Initialize Git first.');
}
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function document(bytes: Buffer): FileDocument {
  ensure(
    bytes.length <= maximumFileBytes && !bytes.includes(0),
    'Text unavailable: binary or exceeds 2 MiB.',
  );
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InvalidWorkspaceRequestError({ reason: 'Text unavailable: invalid UTF-8.' });
  }
  return { text: decoded, version: hash(bytes) };
}
/** Checks that `text` is a file's worth of well-formed text, without hashing it. */
export function text(value: unknown): asserts value is string {
  ensure(typeof value === 'string', 'Invalid text.');
  ensure(isWellFormed(value), 'Invalid Unicode text.');
  ensure(
    !value.includes('\0') && Buffer.byteLength(value) <= maximumFileBytes,
    'Text unavailable: binary or exceeds 2 MiB.',
  );
}
export function textDocument(value: string): FileDocument {
  text(value);
  return { text: value, version: hash(value) };
}
export const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
/** Journal key of one request: a hash of its owner and identifier parts. */
export const key = (...parts: string[]) => hash(canonical(parts));
/** An item that reports its own source or destination, not a replacement moved to Trash. */
export const isOriginalResult = (
  kind: WorkspaceOperation['kind'],
  item: OperationResult['items'][number],
) => kind === 'trash' || item.destination !== undefined;
/** The text an error may show: a workspace error's own, and a fixed one for anything else. */
export const errorText = (error: unknown) =>
  isWorkspaceHostError(error) ? error.message : normalizeApplicationError(error).message;
export const folded = (p: string) => p.normalize('NFC').toLowerCase();
/** Whether any path of `a` is, contains or is contained by a path of `b`; '' is the whole checkout. */
export const overlaps = (a: string[], b: string[]) =>
  a.some((p) =>
    b.some(
      (q) =>
        p === '' ||
        q === '' ||
        isPathAtOrInside(folded(p), folded(q)) ||
        isPathAtOrInside(folded(q), folded(p)),
    ),
  );
