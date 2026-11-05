import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatClient, ChatSnapshot, ChatTranscriptSelection } from '@moonbase/contracts/chat';
import { iterateTranscriptSource, type TranscriptRead } from '@moonbase/application/chat';
import { parseTranscriptMarkdown } from './transcript-source.ts';
import { fields, invalid, record, type TranscriptCopy, type TranscriptImage } from './wire.ts';
import type { IpcRequest } from '../ipc-lifetime.ts';

const areTranscriptValuesEqual = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export type NativeTranscriptActions = {
  writeText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
};
const changed = () =>
  new ApplicationError({
    code: 'Conflict',
    message: 'Transcript source changed. Reload the content and try Copy again.',
  });
export function decodeTranscriptCopy(input: unknown): TranscriptCopy {
  const value = record(input);
  fields(value, ['source', 'selection', 'code'], ['source']);
  const decoded = decodeChatInput('getChatTranscriptContent', {
    source: value.source,
    ...(value.selection !== undefined ? { selection: value.selection } : {}),
  });
  if (value.code !== undefined) {
    const code = record(value.code);
    fields(code, ['start']);
    if (
      !decoded.selection ||
      !Number.isSafeInteger(code.start) ||
      (code.start as number) < 0 ||
      (code.start as number) >= decoded.selection.bytes
    )
      invalid();
  }
  return { ...decoded, ...(value.code ? { code: value.code as TranscriptCopy['code'] } : {}) };
}
export function decodeTranscriptLink(input: unknown) {
  const value = record(input);
  fields(value, ['url']);
  if (
    typeof value.url !== 'string' ||
    value.url.length > 8192 ||
    !/^https?:\/\//i.test(value.url) ||
    [...(value.url as string)].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    )
  )
    invalid();
  let url: URL;
  try {
    url = new URL(value.url as string);
  } catch {
    return invalid();
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    invalid();
  return url.href;
}

export const transcriptImagePath = '/transcript-image/';
const imageSignatures: Record<TranscriptImage['mimeType'], number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff],
};
export const maximumTranscriptImageBytes = 4 * 1024 * 1024;
export function decodeTranscriptImage(input: unknown): TranscriptImage {
  const value = record(input);
  fields(value, ['source', 'selection', 'mimeType']);
  if (typeof value.mimeType !== 'string' || !Object.hasOwn(imageSignatures, value.mimeType))
    invalid();
  const { source, selection } = decodeChatInput('getChatTranscriptContent', {
    source: value.source,
    selection: value.selection,
  });
  return { source, selection: selection!, mimeType: value.mimeType as TranscriptImage['mimeType'] };
}
export type TranscriptImageReader = {
  image: TranscriptImage;
  read(signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
};

/** Serves one issued token; the URL itself grants nothing and every response is a fresh validated read. */
export async function respondTranscriptImage(
  request: Request,
  csp: string,
  findImage: (token: string) => TranscriptImageReader | undefined,
): Promise<Response> {
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
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await found.read(request.signal);
  } catch {
    return fail(502, 'Stored image is unavailable.');
  }
  if (!imageSignatures[found.image.mimeType].every((byte, index) => bytes[index] === byte))
    return fail(415, 'Stored image bytes do not match their declared type.');
  return new Response(bytes, {
    status: 200,
    headers: { ...headers, 'Content-Type': found.image.mimeType },
  });
}

/** Main-only validated source retrieval; the request owns observation and actual IO settlement. */
async function readTranscript<T>(
  chat: ChatClient,
  input: Pick<TranscriptCopy, 'source' | 'selection'>,
  request: IpcRequest,
  encoding: 'utf8' | 'base64',
  finish: (chunks: string[], check: () => void) => Promise<T>,
): Promise<T> {
  const { source, selection } = input;
  let snapshot: ChatSnapshot | undefined,
    observationError: unknown,
    epoch = 0;
  const ready = Promise.withResolvers<void>();
  const pending = new Set<Promise<unknown>>();
  // The main-process ChatClient boundary has already decoded and bounded replies and snapshots.
  const read: TranscriptRead = (input, options) => {
    const promise = chat.command('getChatTranscriptContent', input, options);
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const check = () => {
    if (!request.isLive() || request.signal.aborted)
      throw new ApplicationError({ code: 'Cancelled', message: 'Transcript read cancelled.' });
    if (observationError) throw observationError;
    if (
      source.kind === 'live' &&
      (!snapshot ||
        snapshot.observationStatus === 'reconnecting' ||
        !areTranscriptValuesEqual(snapshot.run?.transcript?.source, source))
    )
      throw changed();
  };
  const close =
    source.kind === 'live'
      ? chat.watch(
          { target: source.target },
          (value) => {
            snapshot = value;
            epoch++;
            ready.resolve();
          },
          (error) => {
            observationError = error;
            epoch++;
            ready.resolve();
          },
        )
      : undefined;
  const aborted = () => ready.resolve();
  request.signal.addEventListener('abort', aborted, { once: true });
  if (request.signal.aborted) ready.resolve();
  try {
    if (close) await ready.promise;
    check();
    const selections: ChatTranscriptSelection[] = [];
    // The iterator validates every manifest/content echo, chunk and continuation independently of UI retention.
    const chunks: string[] = [];
    const seenParts = new Set<string>();
    for await (const chunk of iterateTranscriptSource({
      source,
      selection,
      signal: request.signal,
      isCurrent: () => {
        check();
        return true;
      },
      read: async (input, options) => {
        const reply = await read(input, options);
        return !selection && reply.kind === 'manifest'
          ? {
              ...reply,
              parts: reply.parts.filter(
                (part) => part.kind === 'text' && ['user', 'assistant'].includes(part.role),
              ),
            }
          : reply;
      },
    })) {
      check();
      if (chunk.encoding !== encoding)
        throw new ApplicationError({
          code: 'InvalidInput',
          message:
            encoding === 'utf8'
              ? 'This part is binary and cannot be copied as text.'
              : 'This part is text, not stored image data.',
        });
      if (chunk.offset === 0) {
        if (seenParts.has(chunk.selection.partId))
          throw new ApplicationError({
            code: 'Incompatible',
            message: 'Transcript manifest repeats a selected part.',
          });
        seenParts.add(chunk.selection.partId);
        selections.push(chunk.selection);
      }
      chunks.push(chunk.data);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!selections.length)
      throw new ApplicationError({
        code: 'Unavailable',
        message: 'No authored text is available to copy.',
      });
    // Fresh fixed-prefix proofs after iteration, fenced by the live observation. A held earlier reply is insufficient.
    if (source.kind === 'live') {
      let proved = false;
      for (let attempt = 0; attempt < 3 && !proved; attempt++) {
        const proofEpoch = epoch;
        for (const selected of selections) {
          const reply = await read({ source, selection: selected }, { signal: request.signal });
          check();
          if (
            reply.kind !== 'content' ||
            reply.offset !== 0 ||
            reply.cursor !== null ||
            !areTranscriptValuesEqual(reply.source, source) ||
            !areTranscriptValuesEqual(reply.selection, selected)
          )
            throw changed();
          if (epoch !== proofEpoch) break;
        }
        proved = epoch === proofEpoch;
      }
      if (!proved) throw changed();
    }
    check();
    return await finish(chunks, check);
  } finally {
    request.signal.removeEventListener('abort', aborted);
    const [, observation] = await Promise.allSettled([
      Promise.allSettled(pending),
      Promise.resolve().then(() => close?.()),
    ]);
    if (observation.status === 'rejected') {
      // Retain failed cleanup at the captured document even when the Copy reply is lost.
      const release = await request.retainDocumentRelease(async () => {
        throw observation.reason;
      });
      await release();
    }
  }
}

/** Main-only Copy; the request owns observation and actual IO settlement. */
export function copyTranscript(
  chat: ChatClient,
  input: TranscriptCopy,
  request: IpcRequest,
  native: NativeTranscriptActions,
) {
  return readTranscript(chat, input, request, 'utf8', async (chunks, check) => {
    const { code } = input;
    let text = chunks.join('');
    if (code) {
      const block = parseTranscriptMarkdown(text).codeBlocks.find(
        (node) => node.position?.start.offset === code.start,
      );
      if (!block)
        throw new ApplicationError({
          code: 'Conflict',
          message:
            'The displayed code block changed as more Markdown was loaded. Read more and try Copy again.',
        });
      text = block.value;
    }
    check();
    try {
      await native.writeText(text);
    } catch {
      throw new ApplicationError({
        code: 'Unavailable',
        message: 'Could not write to the clipboard. Try Copy again.',
      });
    }
    // Await the OS result; a failed write must never become a success notification.
    if (!request.isLive() || request.signal.aborted)
      throw new ApplicationError({
        code: 'Cancelled',
        message: 'Copy was cancelled after the clipboard write began.',
      });
  });
}

export function readTranscriptImage(chat: ChatClient, image: TranscriptImage, request: IpcRequest) {
  return readTranscript(chat, image, request, 'base64', async (chunks) =>
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'base64'))),
  );
}
