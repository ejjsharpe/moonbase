import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  defineDocFamily,
  type Harness,
  type ConversationId,
  type EntryId,
  type SubmissionId,
  type TaskId,
} from '@earendil-works/pi-durable';
import type { ChatCreationSettings, ChatTarget } from '@moonbase/contracts/chat';
/** A chat's saved folder and model; `ownFolder` marks a folder made for a chat without a project. */
export type ChatSettings = ChatCreationSettings & { cwd: string; ownFolder?: true };
import { fail } from '@moonbase/contracts/errors';
import * as S from './schema.ts';

export const Request = defineDocFamily({
  kind: 'moonbase.chat.request',
  version: 1,
  scope: 'session',
  family: true,
  initial: (binding: string) => {
    const input = S.savedBinding(binding);
    return {
      binding,
      conversationId: input.operation === 'sendChat' ? input.target.conversationId : null,
      submissionId: null as string | null,
      pending: false as boolean,
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
    return fail('InvalidInput', 'Invalid Pi record identity.');
  return Number(value);
}
export const cid = (value: string) => numeric(value) as ConversationId;
export const eid = (value: string) => numeric(value) as EntryId;
export const sid = (value: string) => numeric(value) as SubmissionId;
export const tid = (value: string) => numeric(value) as TaskId;
export async function readOwnedMetadata(harness: Harness, identity: string, target: ChatTarget) {
  const meta = await harness.snapshot(Metadata, cid(target.conversationId), 'metadata', context);
  if (!meta || meta.identity !== identity)
    return fail('Unauthorized', 'Conversation does not belong to this configured actor/store.');
  const saved = S.savedMetadata(meta);
  if (!saved.settings)
    return fail(
      'Persistence',
      'Stored local conversation settings are missing; preserve this store.',
    );
  return saved;
}
export function getSettings(meta: { settings?: ChatSettings }): ChatSettings {
  if (!meta.settings) return fail('Persistence', 'Stored local conversation settings are missing.');
  return meta.settings;
}
