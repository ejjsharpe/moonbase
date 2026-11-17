import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { ChatInput, ChatSummary, ChatTarget } from '@moonbase/contracts/chat';
import { ChatUnavailableError } from '@moonbase/contracts/chat-errors';
import { Metadata, cid, type ChatSettings } from '../documents.ts';
import { decodeStoredMetadata } from '../stored-records.ts';
import type { Host } from './chat-host.ts';

/** Changes an owned chat's metadata, which the caller has already read through `metadata`. */
function updateMetadata(
  host: Host,
  target: ChatTarget,
  change: (meta: { settledAt?: string; settings?: ChatSettings }) => void,
) {
  return host.harness.commit(async (tx) => {
    const meta = await tx.doc(Metadata, cid(target.conversationId), 'metadata', {
      identity: host.identity,
      title: '',
      createdAt: '',
    });
    decodeStoredMetadata(meta);
    change(meta);
  }, context);
}
/** Settles or unsettles a chat; asking for its current state again commits nothing. */
export async function settleChat(host: Host, d: ChatInput<'settleChat'>): Promise<ChatSummary> {
  const current = await host.metadata(d.target);
  if ((current.settledAt !== undefined) !== d.settled)
    await updateMetadata(host, d.target, (meta) => {
      if (d.settled) meta.settledAt ??= new Date().toISOString();
      else delete meta.settledAt;
    });
  return host.summary(d.target.conversationId, await host.metadata(d.target));
}
/** Lists a chat without a project under the project its folder became; the folder stays put. */
export async function markFolderAsProject(host: Host, target: ChatTarget): Promise<void> {
  if (host.closed || !host.admissionsOpen) throw new ChatUnavailableError({ reason: 'quitting' });
  // Counted as active work, so Quit waits for it.
  host.mutations++;
  try {
    if (!(await host.metadata(target)).settings?.ownFolder) return;
    await updateMetadata(host, target, (meta) => {
      delete meta.settings?.ownFolder;
    });
  } finally {
    host.mutations--;
  }
}
