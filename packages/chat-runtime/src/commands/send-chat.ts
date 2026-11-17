import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { ChatInput, ChatSendReceipt, ChatTarget } from '@moonbase/contracts/chat';
import { Effect } from 'effect';
import {
  ChatStoreError,
  InvalidChatRequestError,
  type ChatError,
} from '@moonbase/contracts/chat-errors';
import { isSameChatTarget } from '@moonbase/contracts/chat-validation';
import { RequestReusedError } from '@moonbase/contracts/host-errors';
import { Metadata, Request, cid, key } from '../documents.ts';
import {
  decodeStoredBinding,
  decodeStoredMetadata,
  decodeStoredRequest,
} from '../stored-records.ts';
import type { Host } from './chat-host.ts';
import { callHarness } from './harness-call.ts';

/** Admits a Send once: a retry of its request reads the first admission and never resubmits. */
export function sendChat(
  host: Host,
  d: ChatInput<'sendChat'>,
): Effect.Effect<ChatSendReceipt, ChatError> {
  return callHarness(() => submitSend(host, d), true);
}
async function submitSend(host: Host, d: ChatInput<'sendChat'>): Promise<ChatSendReceipt> {
  const binding = JSON.stringify({ operation: 'sendChat', ...d }),
    requestKey = key(d.target.actorId, d.requestId);
  await host.harness.commit(async (tx) => {
    const request = await tx.doc(Request, requestKey, binding);
    decodeStoredRequest(request, d.target.actorId, d.requestId);
    if (request.binding !== binding) throw new RequestReusedError();
    const meta = await tx.doc(Metadata, cid(d.target.conversationId), 'metadata', {
      identity: host.identity,
      title: '',
      createdAt: '',
    });
    decodeStoredMetadata(meta);
    if (!request.submissionId && !request.pending) {
      if (
        !Number.isSafeInteger(meta.pending) ||
        meta.pending < 0 ||
        meta.pending === Number.MAX_SAFE_INTEGER
      )
        throw new ChatStoreError({ problem: 'pending-intent' });
      meta.pending++;
      request.pending = true;
      // Sending to a settled chat takes it up again; a retry of the same Send does not.
      if (meta.settledAt !== undefined) delete meta.settledAt;
    }
    request.conversationId = d.target.conversationId;
  }, context);
  const existing = await lookupSend(host, d.target, d.requestId);
  if (existing?.admission === 'admitted') return existing;
  const conversation = await host.harness.conversation(cid(d.target.conversationId), context);
  if (!conversation) throw new InvalidChatRequestError({ problem: 'unknown-conversation' });
  await conversation.submit(
    { type: 'input', requestId: requestKey, content: d.text, whenBusy: 'reject' },
    context,
  );
  return (await lookupSend(host, d.target, d.requestId))!;
}
export function getSend(
  host: Host,
  d: ChatInput<'getChatSend'>,
): Effect.Effect<ChatSendReceipt | null, ChatError> {
  return Effect.andThen(
    host.metadata(d.target),
    callHarness(() => lookupSend(host, d.target, d.requestId)),
  );
}
async function lookupSend(
  host: Host,
  target: ChatTarget,
  requestId: string,
): Promise<ChatSendReceipt | null> {
  const requestKey = key(target.actorId, requestId),
    old = await host.harness.snapshot(Request, requestKey, context);
  if (!old) return null;
  decodeStoredRequest(old, target.actorId, requestId);
  const value = decodeStoredBinding(old.binding);
  if (value.operation !== 'sendChat' || !isSameChatTarget(value.target, target))
    throw new RequestReusedError();
  if (old.conversationId !== target.conversationId)
    throw new ChatStoreError({ problem: 'request-conversation' });
  const submissionId = await host.harness.commit(async (tx) => {
    const found = await tx.submissionByRequest(cid(target.conversationId), requestKey);
    const request = await tx.doc(Request, requestKey, old.binding);
    decodeStoredRequest(request, target.actorId, requestId);
    if (request.submissionId && (!found || String(found.id) !== request.submissionId))
      throw new ChatStoreError({ problem: 'admission-identity' });
    if (found && found.type !== 'input') throw new ChatStoreError({ problem: 'admission-type' });
    if (found && !request.submissionId) {
      request.submissionId = String(found.id);
      const meta = await tx.doc(Metadata, cid(target.conversationId), 'metadata', {
        identity: host.identity,
        title: '',
        createdAt: '',
      });
      decodeStoredMetadata(meta);
      if (request.pending) {
        if (!Number.isSafeInteger(meta.pending) || meta.pending < 1)
          throw new ChatStoreError({ problem: 'pending-intent' });
        meta.pending--;
        request.pending = false;
      }
    }
    return request.submissionId;
  }, context);
  return submissionId
    ? { target, requestId, admission: 'admitted', submissionId }
    : { target, requestId, admission: 'reserved', submissionId: null };
}
