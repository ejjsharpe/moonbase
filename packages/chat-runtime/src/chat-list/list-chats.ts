import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { LiveDoc, type Harness, type LiveState } from '@earendil-works/pi-durable';
import type { ChatActivity, ChatOutput, ChatSession, ChatSummary } from '@moonbase/contracts/chat';
import { getScanCursorScope, openScanCursor, writeScanCursor } from '../cursors.ts';
import { Metadata, cid, getSettings, type ChatSettings } from '../documents.ts';
import { entryListBytes, rowsPerPage } from '../page-limits.ts';
import { decodeStoredMetadata } from '../stored-records.ts';

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
/** One chat as a listing shows it, or undefined when it is missing or another identity's. */
export async function readListedConversation(
  harness: Harness,
  session: ChatSession,
  identity: string,
  conversationId: string,
): Promise<ChatSummary | undefined> {
  const meta = await harness.snapshot(Metadata, cid(conversationId), 'metadata', context);
  if (meta?.identity !== identity) return undefined;
  const saved = decodeStoredMetadata(meta);
  return {
    ...summarizeConversation(session, conversationId, saved, getSettings(saved)),
    activity: await readActivity(harness, conversationId, saved.createdAt),
  };
}
export async function listConversations(
  harness: Harness,
  session: ChatSession,
  identity: string,
  encoded?: string,
): Promise<ChatOutput<'listChats'>> {
  let scan = openScanCursor(encoded, 'list', getScanCursorScope(identity)),
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
    const summary = await readListedConversation(harness, session, identity, String(row.id));
    if (summary) {
      if (
        Buffer.byteLength(JSON.stringify({ conversations: [...conversations, summary] })) >
        entryListBytes
      )
        break;
      conversations.push(summary);
    }
    scan = page.next;
  } while (scan && ++scanned < rowsPerPage);
  return { conversations, nextCursor: writeScanCursor(scan, 'list', getScanCursorScope(identity)) };
}
