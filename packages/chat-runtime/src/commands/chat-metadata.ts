import { DateTime, Effect } from 'effect';
import type { ChatInput, ChatSummary, ChatTarget } from '@moonbase/contracts/chat';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import { Metadata, cid, type ChatSettings } from '../documents.ts';
import { decodeStoredMetadata } from '../stored-records.ts';
import type { Host } from './chat-host.ts';
import { commitChange, mayHaveCommitted } from './commit-boundary.ts';

/** Changes an owned chat's metadata, which the caller has already read through `metadata`. */
function updateMetadata(
  host: Host,
  target: ChatTarget,
  change: (meta: { settledAt?: string; settings?: ChatSettings }) => void,
) {
  return commitChange(host.harness, async (tx) => {
    const meta = await tx.doc(Metadata, cid(target.conversationId), 'metadata', {
      identity: host.identity,
      title: '',
      createdAt: '',
    });
    decodeStoredMetadata(meta);
    change(meta);
  });
}
/**
 * Settles or unsettles a chat; asking for its current state again commits nothing. Once it
 * commits, any failure, the read for its reply included, is uncertain.
 */
export function settleChat(
  host: Host,
  d: ChatInput<'settleChat'>,
): Effect.Effect<ChatSummary, ChatError> {
  return Effect.gen(function* () {
    const current = yield* host.metadata(d.target);
    const reply = Effect.andThen(host.metadata(d.target), (meta) =>
      host.summary(d.target.conversationId, meta),
    );
    if ((current.settledAt !== undefined) === d.settled) return yield* reply;
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* mayHaveCommitted(
      Effect.andThen(
        updateMetadata(host, d.target, (meta) => {
          if (d.settled) meta.settledAt ??= now;
          else delete meta.settledAt;
        }),
        reply,
      ),
    );
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
  return host.ownMutation(
    Effect.gen(function* () {
      if (!(yield* host.metadata(target)).settings?.ownFolder) return;
      yield* mayHaveCommitted(
        updateMetadata(host, target, (meta) => {
          delete meta.settings?.ownFolder;
        }),
      );
    }),
  );
}
