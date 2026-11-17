import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { DateTime, Effect } from 'effect';
import type { ChatInput, ChatSummary, ChatTarget } from '@moonbase/contracts/chat';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import { Metadata, cid, type ChatSettings } from '../documents.ts';
import { decodeStoredMetadata } from '../stored-records.ts';
import type { Host } from './chat-host.ts';
import { callHarness } from './harness-call.ts';

/** Changes an owned chat's metadata, which the caller has already read through `metadata`. */
function updateMetadata(
  host: Host,
  target: ChatTarget,
  change: (meta: { settledAt?: string; settings?: ChatSettings }) => void,
) {
  return callHarness(
    () =>
      host.harness.commit(async (tx) => {
        const meta = await tx.doc(Metadata, cid(target.conversationId), 'metadata', {
          identity: host.identity,
          title: '',
          createdAt: '',
        });
        decodeStoredMetadata(meta);
        change(meta);
      }, context),
    true,
  );
}
/** Settles or unsettles a chat; asking for its current state again commits nothing. */
export function settleChat(
  host: Host,
  d: ChatInput<'settleChat'>,
): Effect.Effect<ChatSummary, ChatError> {
  return Effect.gen(function* () {
    const current = yield* host.metadata(d.target, true);
    if ((current.settledAt !== undefined) !== d.settled) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* updateMetadata(host, d.target, (meta) => {
        if (d.settled) meta.settledAt ??= now;
        else delete meta.settledAt;
      });
    }
    return yield* host.summary(d.target.conversationId, yield* host.metadata(d.target, true));
  });
}
/**
 * Lists a chat without a project under the project its folder became; the folder stays put. It is
 * admitted and owned like any mutation, so Quit waits for it and closing the store settles it.
 */
export function markFolderAsProject(
  host: Host,
  target: ChatTarget,
): Effect.Effect<void, ChatError> {
  return host.own(
    host.admitMutation(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (!(yield* host.metadata(target, true)).settings?.ownFolder) return;
          yield* updateMetadata(host, target, (meta) => {
            delete meta.settings?.ownFolder;
          });
        }),
      ),
    ),
  );
}
