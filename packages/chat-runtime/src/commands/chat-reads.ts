import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { LiveDoc } from '@earendil-works/pi-durable';
import type {
  ChatHistoryPage,
  ChatInput,
  ChatOutput,
  ChatSession,
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
} from '@moonbase/contracts/chat';
import {
  ChatAccessError,
  ChatStoreError,
  ChatStoreMismatchError,
} from '@moonbase/contracts/chat-errors';
import { isSameChatHost } from '@moonbase/contracts/chat-validation';
import { listConversations, readListedConversation } from '../chat-list/list-chats.ts';
import { Store, cid, getSettings } from '../documents.ts';
import { projectSnapshot, type SnapshotCache } from '../history/chat-snapshot.ts';
import { readHistoryAround } from '../history/history-around.ts';
import { readHistory } from '../history/history-page.ts';
import { decodeStoreOwner } from '../stored-records.ts';
import { findTranscript } from '../transcript/find-transcript.ts';
import { readTranscriptContent } from '../transcript/transcript-content.ts';
import type { Host } from './chat-host.ts';

export function getTranscriptContent(host: Host, d: ChatInput<'getChatTranscriptContent'>) {
  return host.read(async (signal) => {
    await host.metadata(d.source.target);
    signal.throwIfAborted();
    return readTranscriptContent(host.harness, d, signal);
  });
}
export function findInTranscript(host: Host, d: ChatInput<'findChatTranscript'>) {
  return host.read(async (signal) => {
    await host.metadata(d.target);
    signal.throwIfAborted();
    return findTranscript(host.harness, d, signal);
  });
}
/** Searches only a chat's own working folder, or one a new chat could be created in. */
export function findFiles(host: Host, d: ChatInput<'findChatFiles'>) {
  return host.read(async (signal) => {
    let cwd: string;
    if ('target' in d) cwd = getSettings(await host.metadata(d.target)).cwd;
    else {
      host.session(d.session);
      await host.config.approveFolder?.(d.cwd);
      cwd = d.cwd;
    }
    signal.throwIfAborted();
    return host.files.find(cwd, d.query, signal);
  });
}
export function getHistoryAround(host: Host, d: ChatInput<'getChatHistoryAround'>) {
  return host.read(async (signal) => {
    await host.metadata(d.target);
    signal.throwIfAborted();
    return readHistoryAround(host.harness, d, signal);
  });
}
export async function getChatHost(
  host: Host,
  d: ChatInput<'getChatHost'>,
): Promise<ChatOutput<'getChatHost'>> {
  if (!isSameChatHost(d.host, host.config.host))
    throw new ChatStoreMismatchError({ mismatch: 'other-host' });
  decodeStoreOwner(await host.harness.snapshot(Store, 'identity', context));
  return { host: { ...host.config.host }, actorId: host.config.actorId, mode: 'local' };
}
/** One chat as a listing shows it; undefined when it is missing or not this session's. */
export async function readListedChat(
  host: Host,
  session: ChatSession,
  conversationId: string,
): Promise<ChatSummary | undefined> {
  host.session(session);
  return readListedConversation(host.harness, session, host.identity, conversationId);
}
export async function listChats(
  host: Host,
  d: ChatInput<'listChats'>,
): Promise<ChatOutput<'listChats'>> {
  host.session(d.session);
  return listConversations(host.harness, d.session, host.identity, d.cursor);
}
export async function getHistory(
  host: Host,
  d: ChatInput<'getChatHistory'>,
): Promise<ChatHistoryPage> {
  await host.metadata(d.target);
  return readHistory(host.harness, {
    identity: host.identity,
    target: d.target,
    cursor: d.cursor,
  });
}
export async function readSnapshot(
  host: Host,
  target: ChatTarget,
  cache?: SnapshotCache,
  signal?: AbortSignal,
): Promise<ChatSnapshot> {
  const meta = await host.metadata(target);
  signal?.throwIfAborted();
  const owner = decodeStoreOwner(await host.harness.snapshot(Store, 'identity', context));
  if (owner.identity !== host.identity) throw new ChatAccessError({ refusal: 'store-authority' });
  if (cache && cache.boundary === undefined) {
    if (!(await host.harness.snapshot(LiveDoc, cid(target.conversationId), context)))
      throw new ChatStoreError({ problem: 'live-state' });
  }
  return projectSnapshot(host.harness, {
    identity: host.identity,
    target,
    conversation: host.summary(target.conversationId, meta),
    pending: meta.pending,
    cache,
    signal,
  });
}
