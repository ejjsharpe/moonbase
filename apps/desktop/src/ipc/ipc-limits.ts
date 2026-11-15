import { Effect } from 'effect';
import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';
import { maximumChatRequestBytes } from '@moonbase/contracts/chat';

// Every bound the renderer's IPC input is held to, in one place. Main decodes each request once
// with the procedures' schemas; these are the limits those schemas and its handlers apply.

export const ipcLimits = {
  /** A message on a port, in UTF-16 units; a longer one closes the connection unread. */
  messageLength: 64 * 1024 * 1024,
  /** Ports one document may hold open at once. */
  connections: 8,
  /** Editor requests, and editor watches, running at once for one document. */
  editorRequests: 128,
  /** Chat requests, and chat watches, running at once for one document and chat target. */
  chatRequests: 64,
  /** The window's Quit handshake: its actions watch, and its answers. */
  windowRequests: 8,
  /** An editor command's input as JSON. */
  commandLength: 32 * 1024 * 1024,
  /** A chat request's input as UTF-8 JSON. */
  chatRequestBytes: maximumChatRequestBytes,
  /** String and array bounds of an editor command's input, where its schema sets none. */
  stringLength: 2 ** 24,
  arrayLength: 8192,
  /** `getIgnoredPaths` asks about a whole folder listing. */
  ignoredPathsLength: 20000,
  /** An error's message as it crosses IPC, either way. */
  errorMessageLength: 512,
} as const;

/**
 * A request's payload as `schema` describes it, refusing a field it does not declare rather than
 * dropping it: the renderer's input is held to its exact shape.
 */
export const exact = <S extends Schema.Top>(schema: S) => {
  const decodeExactly = Schema.decodeUnknownEffect(Schema.toCodecJson(schema) as never, {
    onExcessProperty: 'error',
  });
  return Schema.Unknown.pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.checkEffect((input: unknown) =>
        decodeExactly(input).pipe(
          Effect.as(undefined),
          Effect.catch(() => Effect.succeed('Expected exactly the declared fields' as const)),
        ),
      ) as never,
      encode: SchemaGetter.passthrough() as never,
    }),
  );
};
/** A request ID the renderer mints: a UUID fits. */
export const IpcRequestIdSchema = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
/** A string of at most 4096 characters with no NUL. */
export const IpcTextSchema = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter((value) => !value.includes('\0')),
);
/**
 * A path inside a checkout as the renderer names one: relative, `/`-separated, with no empty,
 * `.` or `..` segment, backslash or NUL; `''` is the checkout itself.
 */
export const isRelativeCheckoutPath = (path: string) =>
  path.length <= 4096 &&
  !path.startsWith('/') &&
  !/[\\\0]/.test(path) &&
  (path === '' || !path.split('/').some((part) => part === '' || part === '.' || part === '..'));
export const RelativeCheckoutPathSchema = Schema.String.check(
  Schema.makeFilter(isRelativeCheckoutPath),
);

/**
 * Which of an editor command's bounds its decoded input breaks, if any. Its schema bounds its
 * nesting; these bound what the schema leaves open.
 */
export function findInputBoundBreach(
  value: unknown,
  arrayLength: number = ipcLimits.arrayLength,
): 'too-large' | 'string-too-long' | 'array-too-long' | undefined {
  if (JSON.stringify(value).length > ipcLimits.commandLength) return 'too-large';
  const visit = (value: unknown): ReturnType<typeof findInputBoundBreach> => {
    if (typeof value === 'string')
      return value.length > ipcLimits.stringLength ? 'string-too-long' : undefined;
    if (value === null || typeof value !== 'object') return undefined;
    if (Array.isArray(value) && value.length > arrayLength) return 'array-too-long';
    for (const item of Object.values(value)) {
      const breach = visit(item);
      if (breach) return breach;
    }
    return undefined;
  };
  return visit(value);
}

/** Whether a chat request's input fits `ipcLimits.chatRequestBytes`. */
export const isWithinChatRequestBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= ipcLimits.chatRequestBytes;
