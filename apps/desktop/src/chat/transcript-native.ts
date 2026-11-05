import { decodeChatInput, decodeChatOutput } from '@moonbase/contracts/chat-schema';
import { ApplicationError } from '@moonbase/contracts/errors';
import { maximumChatReplyBytes } from '@moonbase/contracts/chat';
import type { ChatClient, ChatSnapshot, ChatTranscriptSelection } from '@moonbase/contracts/chat';
import { iterateTranscriptSource, type TranscriptRead } from '@moonbase/application/chat';
import { parseTranscriptMarkdown } from './transcript-source.ts';
import { fields, invalid, record, type TranscriptCopy } from './wire.ts';
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

/** Main-only source retrieval; the request owns observation and actual IO settlement. */
export async function copyTranscript(
  chat: ChatClient,
  input: TranscriptCopy,
  request: IpcRequest,
  native: NativeTranscriptActions,
) {
  const { source, selection, code } = input;
  let snapshot: ChatSnapshot | undefined,
    observationError: unknown,
    epoch = 0;
  const ready = Promise.withResolvers<void>();
  const pending = new Set<Promise<unknown>>();
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
      throw new ApplicationError({ code: 'Cancelled', message: 'Copy cancelled.' });
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
            try {
              snapshot = decodeChatOutput('getChat', value);
              epoch++;
              ready.resolve();
            } catch (error) {
              observationError = error;
              ready.resolve();
            }
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
        const raw = await read(input, options);
        if (Buffer.byteLength(JSON.stringify(raw)) > maximumChatReplyBytes) invalid();
        const reply = decodeChatOutput('getChatTranscriptContent', raw);
        if (
          reply.kind === 'manifest' &&
          new Set(reply.parts.map((part) => part.partId)).size !== reply.parts.length
        )
          throw new ApplicationError({
            code: 'Incompatible',
            message: 'Transcript manifest repeats a part.',
          });
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
      if (chunk.encoding !== 'utf8')
        throw new ApplicationError({
          code: 'InvalidInput',
          message: 'This part is binary and cannot be copied as text.',
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
    // Fresh fixed-prefix proofs after iteration, fenced by the live observation. A held earlier reply is insufficient.
    if (source.kind === 'live') {
      let proved = false;
      for (let attempt = 0; attempt < 3 && !proved; attempt++) {
        const proofEpoch = epoch;
        for (const selected of selections) {
          const reply = decodeChatOutput(
            'getChatTranscriptContent',
            await read({ source, selection: selected }, { signal: request.signal }),
          );
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
    try {
      await native.writeText(text);
    } catch {
      throw new ApplicationError({
        code: 'Unavailable',
        message: 'Could not write to the clipboard. Try Copy again.',
      });
    }
    if (!request.isLive() || request.signal.aborted)
      throw new ApplicationError({
        code: 'Cancelled',
        message: 'Copy was cancelled after the clipboard write began.',
      });
    // Await the OS result; a failed write must never become a success notification.
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
