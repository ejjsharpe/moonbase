import { Effect, Stream, SubscriptionRef } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import type {
  ChatInput,
  ChatOutput,
  ChatSnapshot,
  ChatTranscriptSelection,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { toChatApplicationError } from '@moonbase/contracts/chat-legacy-errors';
import type { ChatServiceShape } from '@moonbase/contracts/services';
import {
  checkTranscriptReply,
  countDecodedTranscriptBytes,
  makeTranscriptFailure,
  trackTranscriptCursor,
} from '@moonbase/application/chat';
import { parseTranscriptMarkdown } from '../../ipc/transcript-markdown.ts';
import {
  maximumTranscriptImageBytes,
  type TranscriptCopy,
  type TranscriptImage,
} from '../../ipc/chat-rpcs.ts';

/** The OS actions Copy and links take: Electron's clipboard and browser. */
export type NativeTranscriptActions = {
  writeText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
};
/** Bounds main's buffered text and the clipboard write for one Copy. */
export const maximumTranscriptCopyBytes = 8 * 1024 * 1024;
/** Code Copy parses its whole part synchronously on main, so larger parts are refused. */
export const maximumTranscriptCodeCopyBytes = 1024 * 1024;
/** Whole-message Copy separates authored text parts like paragraphs. */
const transcriptPartSeparator = '\n\n';
const failure = (code: ApplicationError['code'], message: string) =>
  new ApplicationError({ code, message });
const sourceChanged = () =>
  failure('Conflict', 'Transcript source changed. Reload the content and try Copy again.');
export const transcriptImagePath = '/transcript-image/';
const imageSignatures: Record<TranscriptImage['mimeType'], number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};
/** An issued image and its read. */
export type TranscriptImageReader = {
  image: TranscriptImage;
  read: Effect.Effect<Uint8Array<ArrayBuffer>, unknown>;
};

/** Serves one issued token; the URL itself grants nothing and every response is a fresh validated read. */
export const respondTranscriptImage = (
  request: Request,
  csp: string,
  findImage: (token: string) => TranscriptImageReader | undefined,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const headers = {
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    };
    const fail = (status: number, message: string) =>
      new Response(message, {
        status,
        headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    const url = new URL(request.url);
    if (url.host !== 'editor' || url.search || url.hash) return fail(403, 'Forbidden');
    if (request.method !== 'GET') return fail(405, 'Method not allowed');
    const found = findImage(url.pathname.slice(transcriptImagePath.length));
    if (!found) return fail(404, 'Not found');
    if (found.image.selection.bytes > maximumTranscriptImageBytes)
      return fail(413, 'Stored image exceeds the 4 MiB preview limit.');
    const read = yield* Effect.exit(found.read);
    if (read._tag === 'Failure') return fail(502, 'Stored image is unavailable.');
    const bytes = read.value;
    if (!imageSignatures[found.image.mimeType].every((byte, index) => bytes[index] === byte))
      return fail(415, 'Stored image bytes do not match their declared type.');
    return new Response(bytes, {
      status: 200,
      headers: { ...headers, 'Content-Type': found.image.mimeType },
    });
  });

type Observation =
  | { _tag: 'Waiting' }
  | { _tag: 'Seen'; snapshot: ChatSnapshot }
  | { _tag: 'Failed'; error: ApplicationError };
type ContentInput = ChatInput<'getChatTranscriptContent'>;
type ContentReply = ChatOutput<'getChatTranscriptContent'>;
type Limit = { bytes: number; message: string };

/**
 * Watches a live source's chat while the scope is open, from its first snapshot: the check fails
 * once the watch fails, reconnects, or no longer shows this source.
 */
const watchSource = (chat: ChatServiceShape, source: ChatTranscriptSource) =>
  Effect.gen(function* () {
    if (source.kind !== 'live') return Effect.void;
    const observed = yield* SubscriptionRef.make<Observation>({ _tag: 'Waiting' });
    yield* chat.watch({ target: source.target }).pipe(
      Stream.mapError(toChatApplicationError),
      Stream.runForEach((snapshot) => SubscriptionRef.set(observed, { _tag: 'Seen', snapshot })),
      Effect.catch((error) => SubscriptionRef.set(observed, { _tag: 'Failed', error })),
      Effect.forkScoped,
    );
    yield* SubscriptionRef.changes(observed).pipe(
      Stream.filter((observation) => observation._tag !== 'Waiting'),
      Stream.take(1),
      Stream.runDrain,
    );
    return Effect.flatMap(SubscriptionRef.get(observed), (observation) => {
      if (observation._tag === 'Failed') return Effect.fail(observation.error);
      if (observation._tag === 'Waiting') return Effect.fail(sourceChanged());
      const { snapshot } = observation;
      return snapshot.observationStatus === 'reconnecting' ||
        !areJsonValuesEqual(snapshot.run?.transcript?.source, source)
        ? Effect.fail(sourceChanged())
        : Effect.void;
    });
  });

/**
 * Reads `source`'s selected part, or its authored text parts in order, checking `check` around
 * each read and handing each chunk to `receive`. Every manifest and content echo, chunk and
 * continuation is validated; the replies themselves were decoded at the chat client's boundary.
 */
const readSource = (
  read: (input: ContentInput) => Effect.Effect<ContentReply, ApplicationError>,
  input: Pick<TranscriptCopy, 'source' | 'selection'>,
  check: Effect.Effect<void, ApplicationError>,
  receive: (
    chunk: { selection: ChatTranscriptSelection; offset: number; encoding: string; data: string },
  ) => Effect.Effect<void, ApplicationError>,
) =>
  Effect.gen(function* () {
    const { source, selection } = input;
    const readChecked = (request: ContentInput): Effect.Effect<ContentReply, ApplicationError> =>
      Effect.gen(function* () {
        yield* check;
        const reply = yield* read(request);
        yield* check;
        return yield* Effect.try({
          try: () => checkTranscriptReply(request, reply),
          catch: (error) => error as ApplicationError,
        });
      });
    const advance = trackTranscriptCursor();
    let manifestCursor: string | null = null;
    do {
      let selections: ChatTranscriptSelection[] = selection ? [selection] : [];
      let next: string | null = null;
      if (!selection) {
        const manifest: ContentReply = yield* readChecked({
          source,
          ...(manifestCursor ? { cursor: manifestCursor } : {}),
        });
        if (manifest.kind !== 'manifest')
          return yield* Effect.fail(makeTranscriptFailure('Expected a transcript manifest.'));
        next = manifest.nextCursor;
        selections = [];
        for (const part of manifest.parts) {
          if (part.availability !== 'available')
            return yield* Effect.fail(
              makeTranscriptFailure('Selected transcript content is unavailable.', 'Unavailable'),
            );
          selections.push({ partId: part.partId, bytes: part.bytes, revision: part.revision });
        }
      }
      for (const selected of selections) {
        let cursor: string | null = null,
          offset = 0,
          encoding: string | undefined;
        do {
          const chunk: ContentReply = yield* readChecked({
            source,
            selection: selected,
            ...(cursor ? { cursor } : {}),
          });
          if (chunk.kind !== 'content' || chunk.offset !== offset)
            return yield* Effect.fail(
              makeTranscriptFailure('Transcript content has a missing or overlapping chunk.'),
            );
          if (encoding && encoding !== chunk.encoding)
            return yield* Effect.fail(
              makeTranscriptFailure('Transcript encoding changed within a selected part.'),
            );
          encoding = chunk.encoding;
          offset += countDecodedTranscriptBytes(chunk);
          cursor = chunk.nextCursor;
          yield* check;
          yield* receive({ ...chunk, selection: selected });
          // Each chunk lets other IPC run before the next.
          yield* Effect.yieldNow;
        } while (cursor !== null);
        if (offset !== selected.bytes)
          return yield* Effect.fail(makeTranscriptFailure('Transcript content is incomplete.'));
      }
      yield* Effect.try({
        try: () => advance(manifestCursor, next),
        catch: (error) => error as ApplicationError,
      });
      manifestCursor = next;
    } while (manifestCursor !== null);
    yield* check;
  });

/**
 * Main's validated read of a transcript source, as whole parts of `encoding`, within `limit`. A
 * live source is watched throughout, and read again at the end: the host re-hashes the selected
 * prefix on every read, so one fresh read per part fixes the copied snapshot point.
 */
const readTranscript = (
  chat: ChatServiceShape,
  input: Pick<TranscriptCopy, 'source' | 'selection'>,
  encoding: 'utf8' | 'base64',
  limit: Limit,
) =>
  Effect.gen(function* () {
    const { source, selection } = input;
    const tooLarge = () => failure('Unavailable', limit.message);
    if (selection && selection.bytes > limit.bytes) return yield* Effect.fail(tooLarge());
    const check = yield* watchSource(chat, source);
    const read = (request: ContentInput) =>
      chat.getChatTranscriptContent(request).pipe(Effect.mapError(toChatApplicationError));
    const parts: string[][] = [];
    const selections: ChatTranscriptSelection[] = [];
    let total = 0;
    yield* readSource(
      // A whole message is its authored text, without thinking or tools.
      (request) =>
        Effect.map(read(request), (reply) =>
          !selection && reply.kind === 'manifest'
            ? {
                ...reply,
                parts: reply.parts.filter(
                  (part) => part.kind === 'text' && ['user', 'assistant'].includes(part.role),
                ),
              }
            : reply,
        ),
      input,
      check,
      (chunk) =>
        Effect.gen(function* () {
          if (chunk.encoding !== encoding)
            return yield* Effect.fail(
              failure(
                'InvalidInput',
                encoding === 'utf8'
                  ? 'This part is binary and cannot be copied as text.'
                  : 'This part is text, not stored image data.',
              ),
            );
          if (chunk.offset === 0) {
            if (selections.some(({ partId }) => partId === chunk.selection.partId))
              return yield* Effect.fail(
                failure('Incompatible', 'Transcript manifest repeats a selected part.'),
              );
            // Each part delivers exactly its selected bytes, so refuse before buffering it.
            total += chunk.selection.bytes + (parts.length ? transcriptPartSeparator.length : 0);
            if (total > limit.bytes) return yield* Effect.fail(tooLarge());
            selections.push(chunk.selection);
            parts.push([]);
          }
          parts.at(-1)!.push(chunk.data);
        }),
    );
    if (!selections.length)
      return yield* Effect.fail(failure('Unavailable', 'No authored text is available to copy.'));
    if (source.kind === 'live')
      for (const selected of selections) {
        yield* check;
        const reply = yield* read({ source, selection: selected });
        yield* check;
        if (
          reply.kind !== 'content' ||
          reply.offset !== 0 ||
          reply.cursor !== null ||
          !areJsonValuesEqual(reply.source, source) ||
          !areJsonValuesEqual(reply.selection, selected)
        )
          return yield* Effect.fail(sourceChanged());
      }
    yield* check;
    return { parts, check };
  });

/**
 * Main-only Copy: the validated text of a message, or of one code block in a part, written to the
 * clipboard. A clipboard write under way is waited for, so cancelling never leaves one unseen.
 */
export const copyTranscript = (
  chat: ChatServiceShape,
  input: TranscriptCopy,
  native: NativeTranscriptActions,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { code } = input;
      const limit = code
        ? {
            bytes: maximumTranscriptCodeCopyBytes,
            message: 'Code Copy supports parts up to 1 MiB. Copy the whole message instead.',
          }
        : {
            bytes: maximumTranscriptCopyBytes,
            message: 'Copy supports up to 8 MiB of text. This content is larger.',
          };
      const { parts, check } = yield* readTranscript(chat, input, 'utf8', limit);
      // Code Copy always selects one part, so its parser offsets match the renderer's per-part parse.
      let text = parts.map((chunks) => chunks.join('')).join(transcriptPartSeparator);
      if (code) {
        const block = parseTranscriptMarkdown(text).codeBlocks.find(
          (node) => node.position?.start.offset === code.start,
        );
        if (!block)
          return yield* Effect.fail(
            failure(
              'Conflict',
              'The displayed code block changed as more Markdown was loaded. Read more and try Copy again.',
            ),
          );
        text = block.value;
      }
      yield* check;
      // Await the OS result; a failed write must never become a success notification.
      yield* Effect.uninterruptible(
        Effect.tryPromise({
          try: () => native.writeText(text),
          catch: () => failure('Unavailable', 'Could not write to the clipboard. Try Copy again.'),
        }),
      );
    }),
  );

/** A stored image's validated bytes. */
export const readTranscriptImage = (chat: ChatServiceShape, image: TranscriptImage) =>
  Effect.scoped(
    Effect.map(
      readTranscript(chat, image, 'base64', {
        bytes: maximumTranscriptImageBytes,
        message: 'Stored image exceeds the 4 MiB preview limit.',
      }),
      ({ parts }) =>
        new Uint8Array(Buffer.concat(parts.flat().map((chunk) => Buffer.from(chunk, 'base64')))),
    ),
  );
