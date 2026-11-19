import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  defineDocFamily,
  type Harness,
  type ConversationId,
  type EntryId,
  type SubmissionId,
  type TaskId,
} from '@earendil-works/pi-durable';
import { Effect } from 'effect';
import type { ChatCreationSettings, ChatTarget } from '@moonbase/contracts/chat';
/** A chat's saved folder and model; `ownFolder` marks a folder made for a chat without a project. */
export type ChatSettings = ChatCreationSettings & { cwd: string; ownFolder?: true };
import {
  ChatAccessError,
  ChatStoreError,
  InvalidChatRequestError,
} from '@moonbase/contracts/chat-errors';
import { decodeStoredBinding, decodeStoredMetadata } from './stored-records.ts';
import { callHarness } from './commands/harness-call.ts';
import { runCheck } from './commands/safe-error.ts';

export const Request = defineDocFamily({
  kind: 'moonbase.chat.request',
  version: 1,
  scope: 'session',
  family: true,
  initial: (binding: string) => {
    const input = decodeStoredBinding(binding);
    return {
      binding,
      conversationId: input.operation === 'sendChat' ? input.target.conversationId : null,
      submissionId: null as string | null,
      pending: false as boolean,
      /** A Stop's recorded refusal of a target that did not exist, returned on each replay. */
      refused: null as 'stop-submission' | 'stop-task' | null,
    };
  },
  checkpointWhen: () => true,
});
export const Store = defineDocFamily({
  kind: 'moonbase.chat.store',
  version: 1,
  scope: 'session',
  family: true,
  initial: (identity: string) => ({ identity }),
  checkpointWhen: () => true,
});
export const Metadata = defineDocFamily({
  kind: 'moonbase.chat.metadata',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'current',
  family: true,
  initial: (value: {
    title: string;
    createdAt: string;
    identity: string;
    settings?: ChatSettings;
    /** When the user settled the chat; a Send clears it. */
    settledAt?: string;
  }) => ({
    ...value,
    pending: 0,
  }),
  checkpointWhen: () => true,
});
export const key = (actorId: string, requestId: string) => JSON.stringify([actorId, requestId]);
function numeric(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidChatRequestError({ problem: 'record-identity' });
  return Number(value);
}
export const cid = (value: string) => numeric(value) as ConversationId;
export const eid = (value: string) => numeric(value) as EntryId;
export const sid = (value: string) => numeric(value) as SubmissionId;
export const tid = (value: string) => numeric(value) as TaskId;
/** A chat's saved metadata, refused unless `identity` owns it. */
function checkOwnedMetadata(meta: unknown, identity: string) {
  if (!meta || (meta as { identity?: unknown }).identity !== identity)
    throw new ChatAccessError({ refusal: 'other-owner' });
  const saved = decodeStoredMetadata(meta);
  if (!saved.settings) throw new ChatStoreError({ problem: 'settings-missing' });
  return saved;
}
/** An owned chat's metadata; `uncertain` inside a mutation, where an unknown failure may follow a commit. */
export const readOwnedMetadata = (harness: Harness, identity: string, target: ChatTarget) =>
  Effect.flatMap(
    callHarness(() => harness.snapshot(Metadata, cid(target.conversationId), 'metadata', context)),
    (meta) => runCheck(() => checkOwnedMetadata(meta, identity)),
  );
export function getSettings(meta: { settings?: ChatSettings }): ChatSettings {
  if (!meta.settings) throw new ChatStoreError({ problem: 'settings-missing' });
  return meta.settings;
}
