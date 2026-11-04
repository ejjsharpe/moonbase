import { iterateTranscriptSource } from '@moonbase/application/chat';
import type {
  ChatEntry,
  ChatInput,
  ChatSnapshot,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import type { TranscriptNative } from '../src/chat/wire.ts';
import type { chatCapabilities } from './chat.ts';
import { locateFences } from '../src/chat/transcript-source.ts';
import { markdownMetrics } from '../src/renderer/chat/markdown.tsx';
export async function installTranscriptDemo(chat: ReturnType<typeof chatCapabilities>) {
  const sources = new Map<
    string,
    { source: ChatTranscriptSource; parts: ChatTranscriptPart[]; texts: string[] }
  >();
  const digest = async (text: string) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
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
    '# Reading a retained answer\n\nA **complete** answer with _emphasis_, ~~old words~~ and `inline code`.\n\n- First item\n- Second item\n  - Nested item\n\n> A quoted explanation.\n\n| File | Result |\n| --- | --- |\n| `src/main.ts` | Kept |\n| A very long filename that stays inside the table | Readable |\n\n```typescript\r\n  const moon = "🌔";\t\r\nconsole.log(moon);\r\n```\r\n\n[Read documentation](https://example.com/read)\n\n![External image](https://example.com/never-fetch.png)\n\n<script>window.transcriptExecuted = true</script>\n<button onclick="alert(1)">inert model control</button>\n<svg onload="alert(1)"><circle /></svg>\n\n[Unsafe](javascript:alert(1)) [File](file:///tmp/example.ts)\n';
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
        ['withheld', 'thinking'],
      ];
      for (const [text, kind] of additional) {
        texts.push(text);
        parts.push(await part(text, `m0.b${parts.length}`, kind));
      }
      parts.at(-1)!.availability = 'redacted';
      parts.at(-1)!.text = '';
      parts.at(-1)!.truncated = false;
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
        thinking: 'redacted',
      },
    });
  }
  chat.snapshot.entries = entries.slice(-32).reverse();
  chat.snapshot.olderCursor = '148';
  chat.snapshot.transcriptBoundary = entries.at(-1)!.id;
  const original = chat.dependencies.chat.command;
  chat.dependencies.chat.command = async (operation, input, options) => {
    if (operation === 'getChatHost')
      return {
        ...chat.dependencies.context,
        features: ['transcript-v1', 'chat-stream-v1'],
        ...(chat.dependencies.mode === 'local'
          ? { mode: 'local' }
          : { cwd: '/controlled', model: 'controlled' }),
      } as never;
    if (operation === 'getChatHistory') {
      const hi = Number((input as { cursor?: string }).cursor ?? entries.length),
        lo = Math.max(0, hi - 32);
      return {
        entries: entries.slice(lo, hi).reverse(),
        olderCursor: lo ? String(lo) : null,
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
      const bytes = new TextEncoder().encode(data).slice(0, request.selection.bytes);
      if ((await digest(new TextDecoder().decode(bytes))) !== request.selection.revision)
        throw Error('Demo fixed prefix changed.');
      const offset = Number(request.cursor ?? 0);
      let end = Math.min(offset + 16000, bytes.length);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      return {
        kind: 'content',
        source: request.source,
        selection: request.selection,
        cursor: request.cursor ?? null,
        offset,
        encoding: 'utf8',
        data: new TextDecoder().decode(bytes.slice(offset, end)),
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
      copied.push(
        input.code
          ? locateFences(text).find((fence) => fence.start === input.code!.start)!.text
          : text,
      );
    },
    async openLink(url) {
      links.push(url);
    },
  };
  async function live(text: string) {
    const source: ChatTranscriptSource = {
      kind: 'live',
      target: chat.target,
      submissionId: 'demo-submission',
      taskId: 'demo-task',
      attempt: 0,
      incarnation: 'a'.repeat(64),
    };
    const parts = [await part(text)];
    sources.set(JSON.stringify(source), { source, parts, texts: [text] });
    chat.snapshot.run = {
      stop: { target: chat.target, submissionId: 'demo-submission', taskId: 'demo-task' },
      state: 'running',
      text: [...text].slice(0, 1000).join(''),
      truncated: text.length > 1000,
      tools: [],
      transcript: { source, parts, nextCursor: null, thinking: 'none' },
    };
    chat.snapshot.state = 'running';
    chat.controls.receiveChat(structuredClone(chat.snapshot));
  }
  return {
    native,
    copied,
    links,
    entries,
    markdown,
    live,
    metrics: markdownMetrics,
    snapshot: chat.snapshot as ChatSnapshot,
  };
}
