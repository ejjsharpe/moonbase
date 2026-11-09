import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  LiveDoc,
  type LiveState,
  type Harness,
  type Cursor,
  type EntryRecord,
  type EntryId,
  type TaskInspection,
} from '@earendil-works/pi-durable';
import type {
  ChatActivity,
  ChatInput,
  ChatOutput,
  ChatSession,
  ChatTarget,
  ChatSummary,
  ChatHistoryPage,
  ChatSnapshot,
  ChatRun,
} from '@moonbase/contracts/chat';
import { Metadata, cid, eid, getSettings, type ChatSettings } from './documents.ts';
import * as V from './validation.ts';
import * as S from './private-schema.ts';
import {
  NestedSourceRetired,
  captureTranscript,
  getLiveSource,
  hashJson,
  projectEntryTranscript,
  projectLiveTranscript,
  sealCursor,
  openCursor,
  readEntry,
  scanAdjacentEntry,
} from './transcript.ts';

/** Snapshots and history pages stay below the reply limit with room for their envelope. */
const historyPageBytes = 250 * 1024;
/** Listing and around-entry windows leave more room for their surrounding reply fields. */
const entryListBytes = 240 * 1024;
/** Rows one listing or history page may scan before returning a continuation. */
const rowsPerPage = 32;
/** Leading live tool slots a snapshot reads, more than its embedded transcript page reaches. */
const snapshotToolSlots = 8;

const getCursorIdentity = (identity: string) => createHash('sha256').update(identity).digest('hex');
type BlockedReason = Extract<TaskInspection['state'], { kind: 'blocked' }>['reason'];
export type SnapshotCache = {
  statusVersion: number;
  retired?: boolean;
  boundary?: EntryId | null;
  history?: {
    boundary: string | null;
    page: ChatHistoryPage;
    continuations: (string | null)[];
  };
  status?: { taskId: string; blocked?: BlockedReason };
};
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
  meta: { title: string; createdAt: string; settings?: ChatSettings; settledAt?: string },
  settings: ChatSettings,
): ChatSummary {
  return {
    target: { host: { ...session.host }, actorId: session.actorId, conversationId },
    title: meta.title,
    createdAt: meta.createdAt,
    cwd: settings.cwd,
    ...(settings.ownFolder ? { ownFolder: true as const } : {}),
    model: `${settings.model.provider}/${settings.model.modelId}`,
    ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    ...(meta.settledAt ? { settledAt: meta.settledAt } : {}),
  };
}
/** Running while a submission owns the chat; otherwise how its latest generation ended, and when. */
export async function readActivity(
  harness: Harness,
  conversationId: string,
  createdAt: string,
): Promise<ChatActivity> {
  return harness.commit(async (tx) => {
    const live = (await tx.doc(LiveDoc, cid(conversationId))) as LiveState | undefined;
    const latest = (
      await tx.scanTasks(
        { conversationId: cid(conversationId), kind: 'pi.generation', order: 'descending' },
        1,
      )
    ).items[0];
    let state: ChatActivity['state'] = 'idle';
    if (live?.run) state = 'running';
    else if (latest?.state.status === 'terminal' && latest.state.outcome.status === 'aborted')
      state = 'stopped';
    else if (latest?.state.status === 'terminal' && latest.state.outcome.status !== 'completed')
      state = 'failed';
    const ms = latest?.endedAt ?? latest?.startedAt;
    return { state, at: ms === undefined ? createdAt : new Date(ms).toISOString() };
  }, context);
}
export async function listConversations(
  harness: Harness,
  session: ChatSession,
  identity: string,
  fixedSettings: ChatSettings | undefined,
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
      const summary = {
        ...summarizeConversation(session, String(row.id), saved, getSettings(saved, fixedSettings)),
        activity: await readActivity(harness, String(row.id), saved.createdAt),
      };
      if (
        Buffer.byteLength(JSON.stringify({ conversations: [...conversations, summary] })) >
        entryListBytes
      )
        break;
      conversations.push(summary);
    }
    scan = page.next;
  } while (scan && ++scanned < rowsPerPage);
  return { conversations, nextCursor: writeCursor(scan, 'list', getCursorIdentity(identity)) };
}
export async function readHistory(
  harness: Harness,
  {
    identity,
    target,
    cursor,
    upperEntryId,
    continuations,
    signal,
  }: {
    identity: string;
    target: ChatTarget;
    cursor?: string;
    /** Newest entry to include; `null` reads an empty conversation. */
    upperEntryId?: string | null;
    /** Receives the older cursor after each returned entry. */
    continuations?: (string | null)[];
    signal?: AbortSignal;
  },
): Promise<ChatHistoryPage> {
  if (upperEntryId === null) return { entries: [], olderCursor: null };
  let scan = readCursor(
    cursor,
    'history',
    getCursorIdentity(identity) + ':' + target.conversationId,
  );
  const entries: ChatHistoryPage['entries'] = [];
  let scanned = 0;
  do {
    signal?.throwIfAborted();
    const page = await harness.commit(
      (tx) =>
        tx.scanEntries(
          {
            conversationId: cid(target.conversationId),
            order: 'descending',
            ...(upperEntryId ? { maxEntryId: eid(upperEntryId) } : {}),
          },
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
    const entry = await projectEntry(harness, target, row, signal);
    const candidate = {
      entries: [...entries, entry],
      olderCursor: writeCursor(
        page.next,
        'history',
        getCursorIdentity(identity) + ':' + target.conversationId,
      ),
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) > historyPageBytes) {
      return {
        entries,
        olderCursor: writeCursor(
          scan ?? { start: true },
          'history',
          getCursorIdentity(identity) + ':' + target.conversationId,
        ),
      };
    }
    entries.push(entry);
    continuations?.push(candidate.olderCursor);
    scan = page.next;
  } while (scan && ++scanned < rowsPerPage);
  return {
    entries,
    olderCursor: writeCursor(
      scan ?? undefined,
      'history',
      getCursorIdentity(identity) + ':' + target.conversationId,
    ),
  };
}
type SnapshotInput = {
  identity: string;
  target: ChatTarget;
  conversation: ChatSummary;
  /** Pending Send intents recorded in metadata. */
  pending: number;
  /** Local conversations also report whether their saved working folder is available. */
  local: boolean;
  cache?: SnapshotCache;
  signal?: AbortSignal;
};
export async function projectSnapshot(
  harness: Harness,
  input: SnapshotInput,
): Promise<ChatSnapshot> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await projectSnapshotOnce(harness, input);
    } catch (error) {
      if (!(error instanceof NestedSourceRetired) || attempt === 2) throw error;
    }
  }
}
async function projectSnapshotOnce(
  harness: Harness,
  { identity, target, conversation, pending, local, cache, signal }: SnapshotInput,
): Promise<ChatSnapshot> {
  signal?.throwIfAborted();
  const captured = await captureTranscript(harness, target, {
    cache,
    toolSlots: snapshotToolSlots,
  });
  signal?.throwIfAborted();
  const { live, task, latest } = captured;
  let run: ChatRun | null = null,
    blocked: BlockedReason | undefined;
  if (live?.run) {
    const submissionId = live.run.inputs[0];
    let status = cache?.status;
    if (!status || status.taskId !== String(live.run.taskId)) {
      const version = cache?.statusVersion;
      const inspection = await harness.inspect(context);
      signal?.throwIfAborted();
      const active = inspection.tasks.find((item) => item.record.id === live.run!.taskId);
      // An inspection from another control revision cannot describe this captured run.
      if (active && JSON.stringify(active.record) === JSON.stringify(task)) {
        const waiting = new Set<string>([String(active.record.id)]);
        for (let size = -1; size !== waiting.size;) {
          size = waiting.size;
          for (const item of inspection.tasks)
            if (waiting.has(String(item.record.id)) && item.state.kind === 'waiting')
              for (const id of item.state.on) waiting.add(String(id));
        }
        const stopped = inspection.tasks.find(
          (item) => waiting.has(String(item.record.id)) && item.state.kind === 'blocked',
        );
        status = {
          taskId: String(active.record.id),
          ...(stopped?.state.kind === 'blocked' ? { blocked: stopped.state.reason } : {}),
        };
        if (cache && cache.statusVersion === version) cache.status = status;
      }
    }
    blocked = status?.blocked;
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
      };
  }
  let state: ChatSnapshot['state'];
  if (blocked) state = 'failed';
  else if (run) state = 'running';
  else if (pending) state = 'uncertain';
  else if (latest?.state.status === 'terminal' && latest.state.outcome.status === 'aborted')
    state = 'stopped';
  else if (latest?.state.status === 'terminal' && latest.state.outcome.status !== 'completed')
    state = 'failed';
  else state = 'idle';
  let message: string | undefined;
  if (blocked === 'restart_limit')
    message =
      'Pi parked this task after repeated interruption. Preserve its receipt and resolve the host failure.';
  else if (blocked)
    message =
      'Pi cannot run this task with the installed host definitions. Preserve its receipt and resolve the host configuration.';
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
  const source = getLiveSource(harness, target, captured);
  if (run && source) run.transcript = await projectLiveTranscript(harness, source, captured);
  const base = {
    transcriptBoundary: captured.boundary ? String(captured.boundary) : null,
    conversation,
    run,
    state,
    ...(message === undefined ? {} : { message }),
  };
  signal?.throwIfAborted();
  let history = cache?.history;
  if (!history || history.boundary !== base.transcriptBoundary) {
    const continuations: (string | null)[] = [];
    const page = await readHistory(harness, {
      identity,
      target,
      upperEntryId: base.transcriptBoundary,
      continuations,
      signal,
    });
    history = { boundary: base.transcriptBoundary, page, continuations };
    if (cache) cache.history = history;
  }
  signal?.throwIfAborted();
  const page = { ...history.page, entries: [...history.page.entries] };
  // A growing escaped live preview can shrink the page without rereading retained entries.
  while (
    page.entries.length &&
    Buffer.byteLength(JSON.stringify({ ...base, ...page })) > historyPageBytes
  ) {
    page.entries.pop();
    page.olderCursor = page.entries.length
      ? history.continuations[page.entries.length - 1]
      : writeCursor(
          { start: true },
          'history',
          getCursorIdentity(identity) + ':' + target.conversationId,
        );
  }
  return { ...base, ...page };
}
export async function projectEntry(
  harness: Harness,
  target: ChatTarget,
  entry: EntryRecord,
  signal?: AbortSignal,
): Promise<ChatHistoryPage['entries'][number]> {
  const message = entry.model?.[0];
  const transcript = await projectEntryTranscript(harness, target, entry, signal);
  if (!message)
    return {
      id: String(entry.id),
      role: 'system',
      ...V.preview(transcript.parts[0]?.text ?? 'Transcript record.'),
      transcript,
    };
  const role = message.role === 'toolResult' ? 'tool' : message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'system')
    return {
      id: String(entry.id),
      role: 'system',
      text: 'Unsupported transcript record.',
      truncated: false,
      transcript,
    };
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .filter((x) => x.type === 'text')
          .map((x) => x.text)
          .join('');
  const failed = message.role === 'assistant' && message.stopReason === 'error';
  // An empty interrupted or failed message shows the transcript's label instead of blank text.
  const empty = transcript.parts.find((part) => part.partId === 'm0.empty')?.text;
  const recorded = new Date(message.timestamp);
  return {
    id: String(entry.id),
    transcript,
    role,
    ...(Number.isFinite(recorded.getTime()) ? { createdAt: recorded.toISOString() } : {}),
    ...V.preview(failed ? 'Model response failed.' : text || empty || ''),
    ...(message.role === 'toolResult'
      ? { toolName: V.preview(message.toolName, 128).text, isError: message.isError }
      : {}),
  };
}

export async function readHistoryAround(
  harness: Harness,
  input: ChatInput<'getChatHistoryAround'>,
  signal?: AbortSignal,
): Promise<ChatOutput<'getChatHistoryAround'>> {
  const { target } = input;
  await readEntry(harness, target, input.entryId);
  signal?.throwIfAborted();
  const binding = hashJson({ target, entryId: input.entryId });
  const cursor = input.cursor ? openCursor(harness, input.cursor, 'around', binding) : undefined;
  const upper = cursor?.upper ?? String((await scanAdjacentEntry(harness, target, 'older'))!.id);
  const entries: ChatHistoryPage['entries'] = [];
  async function scanNearby(direction: 'older' | 'newer', position: number) {
    signal?.throwIfAborted();
    if (position < 1 || position > Number(upper)) return undefined;
    return scanAdjacentEntry(harness, target, direction, position, upper);
  }
  async function collect(direction: 'older' | 'newer', start: number, limit: number) {
    let position = start;
    for (let i = 0; i < limit; i++) {
      const row = await scanNearby(direction, position);
      if (!row) break;
      signal?.throwIfAborted();
      const entry = await projectEntry(harness, target, row, signal);
      if (Buffer.byteLength(JSON.stringify([...entries, entry])) > entryListBytes) break;
      entries.push(entry);
      position = Number(row.id) + (direction === 'older' ? -1 : 1);
    }
  }
  if (cursor) {
    if (!cursor.direction || !cursor.upper)
      return V.fail('InvalidInput', 'Invalid history direction.');
    await collect(cursor.direction, cursor.position, rowsPerPage);
  } else {
    await collect('older', Number(input.entryId), rowsPerPage / 2);
    await collect('newer', Number(input.entryId) + 1, rowsPerPage / 2);
  }
  entries.sort((a, b) => Number(b.id) - Number(a.id));
  const first = Number(entries.at(-1)?.id ?? input.entryId),
    last = Number(entries[0]?.id ?? input.entryId);
  async function sealContinuation(direction: 'older' | 'newer', position: number) {
    return (await scanNearby(direction, position))
      ? sealCursor(harness, { kind: 'around', binding, position, upper, direction })
      : null;
  }
  return {
    target,
    cursor: input.cursor ?? null,
    entryId: input.entryId,
    upperEntryId: upper,
    entries,
    olderCursor: await sealContinuation('older', first - 1),
    newerCursor: await sealContinuation('newer', last + 1),
  };
}
