import { iterateTranscriptSource } from '@moonbase/application/chat';
import type {
  ChatEntry,
  ChatInput,
  ChatSnapshot,
  ChatTranscriptPart,
  ChatTranscriptSource,
  ChatTranscript,
} from '@moonbase/contracts/chat';
import { chatLiveTextBytes } from '@moonbase/contracts/chat';
import type { TranscriptNative } from '../src/ipc/chat-wire.ts';
import type { chatCapabilities } from './chat.ts';
import { parseTranscriptMarkdown } from '../src/main/chat/transcript-source.ts';
import { markdownWork } from '../src/renderer/chat/markdown-model.ts';
export async function installTranscriptDemo(chat: ReturnType<typeof chatCapabilities>) {
  const sources = new Map<
    string,
    {
      source: ChatTranscriptSource;
      parts: ChatTranscriptPart[];
      texts: string[];
      encoded?: Uint8Array<ArrayBuffer>[];
    }
  >();
  const digestBytes = async (bytes: Uint8Array<ArrayBuffer>) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  const digest = (text: string) => digestBytes(new TextEncoder().encode(text));
  async function part(
    text: string,
    partId = 'm0.b0',
    kind: ChatTranscriptPart['kind'] = 'text',
  ): Promise<ChatTranscriptPart> {
    const preview = [...text].slice(0, 64).join('');
    return {
      partId,
      kind,
      role: 'assistant',
      availability: 'available',
      encoding: 'utf8',
      text: preview,
      truncated: preview !== text,
      bytes: new TextEncoder().encode(text).length,
      revision: await digest(text),
    };
  }
  const markdown =
    '# Reading a retained answer\n\nA **complete** answer with _emphasis_, ~~old words~~ and `inline code`.\n\n- First item\n- Second item\n  - Nested item\n\n> A quoted explanation.\n\n| File | Result |\n| --- | ---: |\n| `src/main.ts` | Kept |\n| A very long filename that stays inside the table | Readable |\n\n```typescript\r\n  const moon = "🌔";\t\r\nconsole.log(moon);\r\n```\r\n\n[Read documentation](https://example.com/read)\n\n![External image](https://example.com/never-fetch.png)\n\n[**![Badge target](https://example.com/never-fetch-badge.png)**](https://example.com/badge)\n\n<script>window.transcriptExecuted = true</script>\n<button onclick="alert(1)">inert model control</button>\n<svg onload="alert(1)"><circle /></svg>\n\n[Unsafe](javascript:alert(1)) [File](file:///tmp/example.ts)\n';
  const entries: ChatEntry[] = [];
  for (let index = 0; index < 180; index++) {
    const id = `reading-${index}`,
      source: ChatTranscriptSource = { kind: 'entry', target: chat.target, entryId: id };
    const text =
      index === 179
        ? markdown
        : `Saved answer ${index}\n\n\`\`\`typescript\nconst entry = ${index};\n\`\`\`\n`;
    const texts = [text];
    const parts = [await part(text)];
    if (index === 178) parts[0]!.role = 'user';
    if (index === 179) {
      const additional: [string, ChatTranscriptPart['kind']][] = [
        ['  result 🌔\r\n' + 'long retained tool output\n'.repeat(4000), 'result'],
        ['*** original patch data ***\n@@ -1 +1 @@\n-old\n+new\n', 'patch'],
        ['1 - old\n2 + new\n', 'diff'],
        ['', 'thinking'],
        ['Published unknown record description', 'notice'],
      ];
      for (const [text, kind] of additional) {
        texts.push(text);
        parts.push(await part(text, `m0.b${parts.length}`, kind));
      }
      parts.find((part) => part.kind === 'thinking')!.availability = 'redacted';
      parts.find((part) => part.kind === 'notice')!.availability = 'unsupported';
    }
    sources.set(JSON.stringify(source), { source, parts, texts });
    entries.push({
      id,
      role: index === 178 ? 'user' : 'assistant',
      text: text.slice(0, 4000),
      truncated: text.length > 4000,
      transcript: {
        source,
        parts: parts.slice(0, 4),
        nextCursor: parts.length > 4 ? '4' : null,
        thinking: index === 179 ? 'redacted' : 'none',
      },
    });
  }
  chat.snapshot.entries = entries.slice(-32).reverse();
  chat.snapshot.olderCursor = '148';
  chat.snapshot.transcriptBoundary = entries.at(-1)!.id;
  const original = chat.dependencies.chat.command;
  chat.dependencies.chat.command = async (operation, input, options) => {
    if (operation === 'getChatHost')
      return { ...chat.dependencies.context, mode: 'local' } as never;
    if (operation === 'getChatHistory') {
      const hi = Number((input as { cursor?: string }).cursor ?? entries.length),
        lo = Math.max(0, hi - 32);
      return {
        entries: entries.slice(lo, hi).reverse(),
        olderCursor: lo ? String(lo) : null,
      } as never;
    }
    if (operation === 'findChatTranscript') {
      const request = input as ChatInput<'findChatTranscript'>;
      const position = request.cursor
        ? (JSON.parse(request.cursor) as {
            upper: number;
            index: number;
            part: number;
            offset: number;
            bytes: number;
          })
        : { upper: entries.length, index: 0, part: 0, offset: 0, bytes: 0 };
      const startCursor = JSON.stringify({
        upper: position.upper,
        index: 0,
        part: 0,
        offset: 0,
        bytes: 0,
      });
      const matches = [];
      const expression = new RegExp(request.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      let rows = 0;
      while (position.index < position.upper && rows++ < 32 && matches.length < 32) {
        const entry = entries[position.index]!,
          found = sources.get(JSON.stringify(entry.transcript!.source))!;
        for (; position.part < found.parts.length; position.part++, position.offset = 0) {
          const part = found.parts[position.part]!;
          if (part.availability !== 'available' || part.encoding !== 'utf8') continue;
          const text = found.texts[position.part]!;
          expression.lastIndex = position.offset;
          let match: RegExpExecArray | null;
          while ((match = expression.exec(text))) {
            const start = match.index,
              end = start + match[0].length;
            let lo = Math.max(0, start - 80),
              hi = Math.min(text.length, end + 80);
            if (/[\udc00-\udfff]/.test(text[lo] ?? '')) lo--;
            if (/[\udc00-\udfff]/.test(text[hi] ?? '')) hi--;
            matches.push({
              source: found.source,
              partId: part.partId,
              start,
              end,
              snippet: { start: lo, text: text.slice(lo, hi) },
            });
            position.offset = end;
            if (matches.length === 32) break;
          }
          if (matches.length === 32) break;
        }
        if (matches.length === 32) break;
        position.index++;
        position.part = 0;
        position.offset = 0;
      }
      position.bytes++;
      return {
        target: request.target,
        query: request.query,
        cursor: request.cursor ?? null,
        startCursor,
        upperEntryId: entries[position.upper - 1]?.id ?? null,
        matches,
        progress: { entries: position.index, bytes: position.bytes },
        nextCursor: position.index < position.upper ? JSON.stringify(position) : null,
      } as never;
    }
    if (operation === 'getChatHistoryAround') {
      const request = input as ChatInput<'getChatHistoryAround'>,
        index = entries.findIndex((entry) => entry.id === request.entryId);
      const range = request.cursor
        ? (JSON.parse(request.cursor) as { lo: number; hi: number })
        : { lo: Math.max(0, index - 15), hi: Math.min(entries.length, index + 17) };
      return {
        target: chat.target,
        entryId: request.entryId,
        cursor: request.cursor ?? null,
        upperEntryId: entries.at(-1)!.id,
        entries: entries.slice(range.lo, range.hi).reverse(),
        olderCursor: range.lo
          ? JSON.stringify({ lo: Math.max(0, range.lo - 32), hi: range.lo })
          : null,
        newerCursor:
          range.hi < entries.length
            ? JSON.stringify({ lo: range.hi, hi: Math.min(entries.length, range.hi + 32) })
            : null,
      } as never;
    }
    if (operation === 'getChatTranscriptContent') {
      const request = input as ChatInput<'getChatTranscriptContent'>,
        found = sources.get(JSON.stringify(request.source));
      if (!found) throw Error('Demo source changed.');
      if (!request.selection) {
        const start = Number(request.cursor ?? 0);
        return {
          kind: 'manifest',
          source: request.source,
          cursor: request.cursor ?? null,
          parts: found.parts.slice(start, start + 4),
          nextCursor: start + 4 < found.parts.length ? String(start + 4) : null,
          thinking: 'redacted',
        } as never;
      }
      const index = found.parts.findIndex((part) => part.partId === request.selection!.partId),
        data = found.texts[index]!;
      const descriptor = found.parts[index]!;
      const binary = descriptor.encoding === 'base64';
      const retained =
        found.encoded?.[index] ??
        (binary
          ? Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
          : new TextEncoder().encode(data));
      const bytes = retained.subarray(0, request.selection.bytes);
      if (
        !(
          request.selection.bytes === descriptor.bytes &&
          request.selection.revision === descriptor.revision
        ) &&
        (await digestBytes(bytes)) !== request.selection.revision
      )
        throw Error('Demo fixed prefix changed.');
      const offset = Number(request.cursor ?? 0);
      let end = Math.min(offset + 16000, bytes.length);
      while (!binary && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      return {
        kind: 'content',
        source: request.source,
        selection: request.selection,
        cursor: request.cursor ?? null,
        offset,
        encoding: binary ? 'base64' : 'utf8',
        data: binary
          ? btoa(String.fromCharCode(...bytes.slice(offset, end)))
          : new TextDecoder().decode(bytes.slice(offset, end)),
        nextCursor: end < bytes.length ? String(end) : null,
      } as never;
    }
    return original(operation, input, options) as never;
  };
  const copied: string[] = [],
    links: string[] = [];
  const native: TranscriptNative = {
    async copy(input, signal) {
      let text = '';
      for await (const chunk of iterateTranscriptSource({
        ...input,
        signal,
        isCurrent: () => true,
        read: (input, options) =>
          chat.dependencies.chat.command('getChatTranscriptContent', input, options),
      }))
        text += chunk.data;
      if (input.code) {
        const block = parseTranscriptMarkdown(text).codeBlocks.find(
          (node) => node.position?.start.offset === input.code!.start,
        );
        if (!block)
          throw Error(
            'The displayed code block changed as more Markdown was loaded. Read more and try Copy again.',
          );
        text = block.value;
      }
      copied.push(text);
    },
    async openLink(url) {
      links.push(url);
    },
    // Without Electron main, serve the volatile fixture bytes directly; production uses moonbase:// tokens.
    async imageUrl({ mimeType, ...input }, signal) {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for await (const chunk of iterateTranscriptSource({
        ...input,
        signal,
        isCurrent: () => true,
        read: (input, options) =>
          chat.dependencies.chat.command('getChatTranscriptContent', input, options),
      }))
        chunks.push(Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0)));
      return URL.createObjectURL(new Blob(chunks, { type: mimeType }));
    },
  };
  type DemoPart = { data?: string } & Pick<ChatTranscriptPart, 'text' | 'kind'> &
    Partial<Omit<ChatTranscriptPart, 'text' | 'kind' | 'bytes' | 'revision' | 'truncated'>>;
  async function makeParts(values: DemoPart[]) {
    return Promise.all(
      values.map(async ({ text, data, ...value }, index) => ({
        ...(await part(text, value.partId ?? `m0.b${index}`, value.kind)),
        ...value,
        ...(data === undefined
          ? {}
          : {
              encoding: 'base64' as const,
              bytes: atob(data).length,
              revision: await digestBytes(
                Uint8Array.from(atob(data), (char) => char.charCodeAt(0)),
              ),
            }),
      })),
    );
  }
  async function record(
    records: {
      id: string;
      role?: ChatEntry['role'];
      thinking?: ChatTranscript['thinking'];
      parts: DemoPart[];
    }[],
  ) {
    const next: ChatEntry[] = [];
    for (const record of records) {
      const source: ChatTranscriptSource = {
        kind: 'entry',
        target: chat.target,
        entryId: record.id,
      };
      const parts = await makeParts(record.parts);
      sources.set(JSON.stringify(source), {
        source,
        parts,
        texts: record.parts.map((part) => part.data ?? part.text),
      });
      next.push({
        id: record.id,
        role: record.role ?? 'assistant',
        text: record.parts
          .filter((part) => part.kind === 'text')
          .map((part) => part.text)
          .join(''),
        truncated: false,
        transcript: {
          source,
          parts: parts.slice(0, 4),
          nextCursor: parts.length > 4 ? '4' : null,
          thinking: record.thinking ?? 'none',
        },
      });
    }
    entries.splice(0, entries.length, ...next);
    chat.snapshot.entries = entries.slice(-32).reverse();
    chat.snapshot.olderCursor = entries.length > 32 ? String(entries.length - 32) : null;
    chat.snapshot.transcriptBoundary = entries.at(-1)?.id ?? null;
    chat.snapshot.run = null;
    chat.snapshot.state = 'idle';
    chat.controls.receiveChat(structuredClone(chat.snapshot));
  }
  async function activity(
    values: DemoPart[],
    thinking: ChatTranscript['thinking'] = 'available',
    attempt = 0,
  ) {
    const source: ChatTranscriptSource = {
      kind: 'live',
      target: chat.target,
      submissionId: 'demo-submission',
      taskId: 'demo-task',
      attempt,
      incarnation: (attempt ? 'b' : 'a').repeat(64),
    };
    const texts = values.map((part) => part.data ?? part.text),
      parts = await makeParts(values);
    const text = values
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('');
    sources.set(JSON.stringify(source), { source, parts, texts });
    chat.snapshot.run = {
      stop: { target: chat.target, submissionId: 'demo-submission', taskId: 'demo-task' },
      state: 'running',
      text: [...text].slice(0, 1000).join(''),
      truncated: text.length > 1000,
      transcript: {
        source,
        parts: giveWholeText(parts.slice(0, 4), texts.slice(0, 4)),
        nextCursor: parts.length > 4 ? '4' : null,
        thinking,
      },
    };
    chat.snapshot.state = 'running';
    chat.controls.receiveChat(structuredClone(chat.snapshot));
  }
  /** As the host does for a running response: its text parts whole while their text fits. */
  function giveWholeText(parts: ChatTranscriptPart[], texts: string[]) {
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    let spent = parts.reduce((sum, part) => sum + bytes(part.text), 0);
    return parts.map((part, index) => {
      const text = texts[index];
      if (part.kind !== 'text' || part.encoding !== 'utf8' || !part.truncated || text === undefined)
        return part;
      const next = spent - bytes(part.text) + bytes(text);
      if (next > chatLiveTextBytes) return part;
      spent = next;
      return { ...part, text, truncated: false };
    });
  }
  async function live(text: string, outputs: string[] = []) {
    await activity(
      [{ text, kind: 'text' }, ...outputs.map((text): DemoPart => ({ text, kind: 'result' }))],
      'none',
    );
  }
  /**
   * Replaces the conversation with `count` alternating questions and answers of varied length.
   * Every tenth answer has a code block long enough to fold; `lighthouse` appears only in the
   * third answer, far back in history.
   */
  async function long(count = 2000) {
    await record(
      Array.from({ length: count }, (_, index) => {
        const user = index % 2 === 0;
        let text = user
          ? `Question ${index}: how does part ${index} fit together?`
          : `Answer ${index}.\n\n` + 'A paragraph of steady explanation. '.repeat(1 + (index % 7));
        if (!user && index % 10 === 1)
          text +=
            '\n\n```typescript\n' +
            Array.from({ length: 60 }, (_, line) => `const line${line} = ${index};`).join('\n') +
            '\n```\n';
        if (index === 5) text += '\n\nThe old lighthouse note.';
        return {
          id: `long-${index}`,
          role: user ? ('user' as const) : ('assistant' as const),
          parts: [
            {
              text,
              kind: 'text' as const,
              role: user ? ('user' as const) : ('assistant' as const),
            },
          ],
        };
      }),
    );
  }
  return {
    long,
    async setEntry(index: number, texts: string[], kinds: ChatTranscriptPart['kind'][] = []) {
      const entry = entries[index]!;
      const parts = await Promise.all(
        texts.map((text, i) => part(text, `m0.b${i}`, kinds[i] ?? 'text')),
      );
      sources.set(JSON.stringify(entry.transcript!.source), {
        source: entry.transcript!.source,
        parts,
        texts,
      });
      entry.transcript = {
        ...entry.transcript!,
        parts: parts.slice(0, 4),
        nextCursor: parts.length > 4 ? '4' : null,
      };
      chat.snapshot.entries = entries.slice(-32).reverse();
      chat.controls.receiveChat(structuredClone(chat.snapshot));
    },
    native,
    copied,
    links,
    entries,
    markdown,
    live,
    activity,
    record,
    metrics: markdownWork,
    snapshot: chat.snapshot as ChatSnapshot,
  };
}
