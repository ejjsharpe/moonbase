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
import * as V from './validation.ts';
import * as S from './private-schema.ts';

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
    settings?: ChatCreationSettings;
  }) => ({
    ...value,
    pending: 0,
  }),
  checkpointWhen: () => true,
});
export const key = (actorId: string, requestId: string) => JSON.stringify([actorId, requestId]);
function numeric(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    return V.fail('InvalidInput', 'Invalid Pi record identity.');
  return Number(value);
}
export const cid = (value: string) => numeric(value) as ConversationId;
export const eid = (value: string) => numeric(value) as EntryId;
export const sid = (value: string) => numeric(value) as SubmissionId;
export const tid = (value: string) => numeric(value) as TaskId;
export async function readOwnedMetadata(
  harness: Harness,
  identity: string,
  target: ChatTarget,
  local: boolean,
) {
  const meta = await harness.snapshot(Metadata, cid(target.conversationId), 'metadata', context);
  if (!meta || meta.identity !== identity)
    return V.fail('Unauthorized', 'Conversation does not belong to this configured actor/store.');
  const saved = S.savedMetadata(meta);
  if (local && !saved.settings)
    return V.fail(
      'Persistence',
      'Stored local conversation settings are missing; preserve this store.',
    );
  if (!local && saved.settings)
    return V.fail(
      'Persistence',
      'Remote conversation has incompatible settings; preserve this store.',
    );
  return saved;
}
export function getSettings(
  meta: { settings?: ChatCreationSettings },
  fixedSettings?: ChatCreationSettings,
): ChatCreationSettings {
  if (!fixedSettings) {
    if (!meta.settings)
      return V.fail('Persistence', 'Stored local conversation settings are missing.');
    return meta.settings;
  }
  if (meta.settings)
    return V.fail(
      'Persistence',
      'Remote conversation has incompatible settings; preserve this store.',
    );
  return fixedSettings;
}
