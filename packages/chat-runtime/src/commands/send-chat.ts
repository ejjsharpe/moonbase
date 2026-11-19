import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { ChatInput, ChatSendReceipt, ChatTarget } from '@moonbase/contracts/chat';
import { Effect } from 'effect';
import { ChatStoreError, type ChatError } from '@moonbase/contracts/chat-errors';
import { isSameChatTarget } from '@moonbase/contracts/chat-validation';
import { RequestReusedError } from '@moonbase/contracts/host-errors';
import { callAbortable } from '../abortable-call.ts';
import { Metadata, Request, cid, key } from '../documents.ts';
import {
  decodeStoredBinding,
  decodeStoredMetadata,
  decodeStoredRequest,
} from '../stored-records.ts';
import type { Host } from './chat-host.ts';
import { callHarness } from './harness-call.ts';
import { Refusal, commitChange, mayHaveCommitted, submitError } from './commit-boundary.ts';
import { runCheck, uncertainError } from './safe-error.ts';

/**
 * Admits a Send once: a retry of its request reads the first admission and never resubmits. From
 * its reservation's commit on, only a conflicting binding and Pi's raw busy refusal from submit
 * stay definite; anything else, a journal that fails to decode included, may follow a commit, so
 * it is uncertain.
 */
export const sendChat = (
  host: Host,
  d: ChatInput<'sendChat'>,
): Effect.Effect<ChatSendReceipt, ChatError> =>
  mayHaveCommitted(
    Effect.gen(function* () {
      const binding = JSON.stringify({ operation: 'sendChat', ...d }),
        requestKey = key(d.target.actorId, d.requestId);
      yield* commitChange(host.harness, async (tx) => {
        const request = await tx.doc(Request, requestKey, binding);
        decodeStoredRequest(request, d.target.actorId, d.requestId);
        if (request.binding !== binding) throw new Refusal(new RequestReusedError());
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
      });
      const existing = yield* lookupSend(host, d.target, d.requestId);
      if (existing?.admission === 'admitted') return existing;
      const conversation = yield* callHarness(() =>
        host.harness.conversation(cid(d.target.conversationId), context),
      );
      if (!conversation) return yield* uncertainError();
      yield* callAbortable(() =>
        conversation.submit(
          { type: 'input', requestId: requestKey, content: d.text, whenBusy: 'reject' },
          context,
        ),
      ).pipe(Effect.mapError(submitError));
      const receipt = yield* lookupSend(host, d.target, d.requestId);
      if (!receipt) return yield* uncertainError();
      return receipt;
    }),
  );
export function getSend(
  host: Host,
  d: ChatInput<'getChatSend'>,
): Effect.Effect<ChatSendReceipt | null, ChatError> {
  return Effect.andThen(host.metadata(d.target), lookupSend(host, d.target, d.requestId));
}
/** A Send's receipt, recording its submission once Pi has admitted it. */
const lookupSend = (
  host: Host,
  target: ChatTarget,
  requestId: string,
): Effect.Effect<ChatSendReceipt | null, ChatError> =>
  Effect.gen(function* () {
    const requestKey = key(target.actorId, requestId),
      old = yield* callHarness(() => host.harness.snapshot(Request, requestKey, context));
    if (!old) return null;
    const value = yield* runCheck(() => {
      decodeStoredRequest(old, target.actorId, requestId);
      return decodeStoredBinding(old.binding);
    });
    if (value.operation !== 'sendChat' || !isSameChatTarget(value.target, target))
      return yield* new RequestReusedError();
    if (old.conversationId !== target.conversationId)
      return yield* new ChatStoreError({ problem: 'request-conversation' });
    const submissionId = yield* callHarness(() =>
      host.harness.commit(async (tx) => {
        const found = await tx.submissionByRequest(cid(target.conversationId), requestKey);
        const request = await tx.doc(Request, requestKey, old.binding);
        decodeStoredRequest(request, target.actorId, requestId);
        if (request.submissionId && (!found || String(found.id) !== request.submissionId))
          throw new ChatStoreError({ problem: 'admission-identity' });
        if (found && found.type !== 'input')
          throw new ChatStoreError({ problem: 'admission-type' });
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
      }, context),
    );
    return submissionId
      ? { target, requestId, admission: 'admitted' as const, submissionId }
      : { target, requestId, admission: 'reserved' as const, submissionId: null };
  });
