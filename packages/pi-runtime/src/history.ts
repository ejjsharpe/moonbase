import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { LiveDoc, type Harness, type Cursor, type EntryRecord } from '@earendil-works/pi-durable';
import type {
  ChatCreationSettings,
  ChatOutput,
  ChatSession,
  ChatTarget,
  ChatSummary,
  ChatHistoryPage,
  ChatSnapshot,
  ChatRun,
} from '@moonbase/contracts/chat';
import { Metadata, cid, getSettings } from './documents.ts';
import * as V from './validation.ts';
import * as S from './private-schema.ts';

const getCursorIdentity = (identity: string) => createHash('sha256').update(identity).digest('hex');
const readCursor = (
  value: string | undefined,
  kind: string,
  conversationId?: string,
): Cursor | undefined => {
  if (value === undefined) return undefined;
  try {
    const decoded = S.cursorEnvelope(
      JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(V.cursor(value), 'base64url')),
      ),
    );
    if (decoded.kind !== kind || decoded.conversationId !== conversationId) throw Error();
    return decoded.scan === null || decoded.scan?.start === true
      ? undefined
      : (V.object(decoded.scan) as Cursor);
  } catch {
    return V.fail('InvalidInput', 'This history cursor belongs to another view or is invalid.');
  }
};
const writeCursor = (scan: Cursor | undefined, kind: string, conversationId?: string) =>
  scan === undefined
    ? null
    : V.cursor(Buffer.from(JSON.stringify({ kind, conversationId, scan })).toString('base64url'));

export function summarizeConversation(
  session: ChatSession,
  conversationId: string,
  meta: { title: string; createdAt: string; settings?: ChatCreationSettings },
  settings: ChatCreationSettings,
): ChatSummary {
  return {
    target: { host: { ...session.host }, actorId: session.actorId, conversationId },
    title: meta.title,
    createdAt: meta.createdAt,
    cwd: settings.cwd,
    model: `${settings.model.provider}/${settings.model.modelId}`,
  };
}
export async function listConversations(
  harness: Harness,
  session: ChatSession,
  identity: string,
  fixedSettings: ChatCreationSettings | undefined,
  encoded?: string,
): Promise<ChatOutput<'listChats'>> {
  let scan = readCursor(encoded, 'list', getCursorIdentity(identity)),
    scanned = 0;
  const conversations: ChatSummary[] = [];
  do {
    const page = await harness.commit(
        (tx) => tx.scanConversations({ order: 'descending' }, 1, scan),
        context,
      ),
      row = page.items[0];
    if (!row) {
      scan = undefined;
      break;
    }
    const meta = await harness.snapshot(Metadata, row.id, 'metadata', context);
    if (meta?.identity === identity) {
      const saved = S.savedMetadata(meta);
      const summary = summarizeConversation(
        session,
        String(row.id),
        saved,
        getSettings(saved, fixedSettings),
      );
      if (
        Buffer.byteLength(JSON.stringify({ conversations: [...conversations, summary] })) >
        240 * 1024
      )
        break;
      conversations.push(summary);
    }
    scan = page.next;
  } while (scan && ++scanned < 32);
  return { conversations, nextCursor: writeCursor(scan, 'list', getCursorIdentity(identity)) };
}
export async function readHistory(
  harness: Harness,
  identity: string,
  target: ChatTarget,
  encoded?: string,
  base: unknown = {},
): Promise<ChatHistoryPage> {
  let scan = readCursor(
    encoded,
    'history',
    getCursorIdentity(identity) + ':' + target.conversationId,
  );
  const entries: ChatHistoryPage['entries'] = [];
  let scanned = 0;
  do {
    const page = await harness.commit(
      (tx) =>
        tx.scanEntries(
          { conversationId: cid(target.conversationId), order: 'descending' },
          1,
          scan,
        ),
      context,
    );
    const row = page.items[0];
    if (!row) {
      scan = undefined;
      break;
    }
    const entry = entryPreview(row);
    const candidate = {
      ...(base as object),
      entries: entry ? [...entries, entry] : entries,
      olderCursor: writeCursor(
        page.next,
        'history',
        getCursorIdentity(identity) + ':' + target.conversationId,
      ),
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) > 250 * 1024)
      return {
        entries,
        olderCursor: writeCursor(
          scan ?? { start: true },
          'history',
          getCursorIdentity(identity) + ':' + target.conversationId,
        ),
      };
    if (entry) entries.push(entry);
    scan = page.next;
  } while (scan && ++scanned < 32);
  return {
    entries,
    olderCursor: writeCursor(
      scan ?? undefined,
      'history',
      getCursorIdentity(identity) + ':' + target.conversationId,
    ),
  };
}
export async function projectSnapshot(
  harness: Harness,
  identity: string,
  target: ChatTarget,
  conversation: ChatSummary,
  pending: number,
  local: boolean,
): Promise<ChatSnapshot> {
  const live = await harness.snapshot(LiveDoc, cid(target.conversationId), context);
  let run: ChatRun | null = null,
    parked = false;
  if (live?.run) {
    const task = await harness.getTask(live.run.taskId, context),
      submissionId = live.run.inputs[0];
    parked = (task?.restarts ?? 0) >= 5;
    const tools = await Promise.all(
      (live.tools ?? []).slice(0, 8).map(async (tool) => {
        const entry = tool.entry
          ? await harness.commit((tx) => tx.entry(tool.entry!), context)
          : undefined;
        const result = entry?.model?.find((message) => message.role === 'toolResult');
        const text =
          result?.role === 'toolResult'
            ? result.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
            : (tool.output ?? '');
        let toolState: 'running' | 'completed' | 'failed' = 'running';
        if (tool.status === 'done')
          toolState = result?.role === 'toolResult' && !result.isError ? 'completed' : 'failed';
        return {
          taskId: String(tool.taskId ?? live.run!.taskId),
          name: V.preview(tool.name, 128).text,
          state: toolState,
          ...V.preview(text),
        };
      }),
    );
    let runState: ChatRun['state'] = 'running';
    if (task?.abortRequested) runState = 'stopping';
    else if (live.generation?.deferred) runState = 'deferred';
    if (submissionId)
      run = {
        stop: { target, submissionId: String(submissionId), taskId: String(live.run.taskId) },
        state: runState,
        ...V.preview(
          live.generation?.message?.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('') ?? '',
        ),
        tools,
      };
  }
  const latest = (
    await harness.commit(
      (tx) =>
        tx.scanTasks(
          {
            conversationId: cid(target.conversationId),
            kind: 'pi.generation',
            order: 'descending',
          },
          1,
        ),
      context,
    )
  ).items[0];
  let state: ChatSnapshot['state'];
  if (parked) state = 'failed';
  else if (run) state = 'running';
  else if (pending) state = 'uncertain';
  else if (latest?.state.status === 'terminal' && latest.state.outcome.status === 'aborted')
    state = 'stopped';
  else if (latest?.state.status === 'terminal' && latest.state.outcome.status !== 'completed')
    state = 'failed';
  else state = 'idle';
  let message: string | undefined;
  if (parked)
    message =
      'Pi parked this task after repeated interruption. Preserve its receipt and resolve the host failure.';
  else if (pending)
    message = 'Pending Send intent is retained; query or retry its original request explicitly.';
  else if (state === 'failed') message = 'Pi could not complete the last submission.';
  if (local) {
    const cwd = conversation.cwd;
    const available = await realpath(cwd)
      .then(async (canonical) => canonical === cwd && (await stat(cwd)).isDirectory())
      .catch(() => false);
    if (!available)
      message = [
        message,
        'The saved local working folder is unavailable. Restore its original path, or create another conversation with a new folder.',
      ]
        .filter(Boolean)
        .join(' ');
  }
  const base = {
    conversation,
    run,
    state,
    ...(message === undefined ? {} : { message }),
  };
  return { ...base, ...(await readHistory(harness, identity, target, undefined, base)) };
}
function entryPreview(entry: EntryRecord): ChatHistoryPage['entries'][number] | null {
  const message = entry.model?.[0];
  if (!message) return null;
  const role = message.role === 'toolResult' ? 'tool' : message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system') return null;
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join('');
  const failed = message.role === 'assistant' && message.stopReason === 'error';
  return {
    id: String(entry.id),
    role,
    ...V.preview(failed ? 'Model response failed.' : text),
    ...(message.role === 'toolResult'
      ? { toolName: V.preview(message.toolName, 128).text, isError: message.isError }
      : {}),
  };
}
