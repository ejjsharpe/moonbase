import type { FileDocument, FileTarget } from '@moonbase/contracts/workspace';

/** One edit the editor has yet to see committed. */
export type RecoveryEditRequest =
  | { kind: 'openTab'; bufferId: string; target: FileTarget }
  | { kind: 'closeTab'; bufferId: string; discard: boolean }
  | { kind: 'updateDraft'; bufferId: string; text: string; disk: FileDocument }
  | { kind: 'updateLayout' };
export type CloseRequest = Extract<RecoveryEditRequest, { kind: 'closeTab' }>;
export type OpenRequest = Extract<RecoveryEditRequest, { kind: 'openTab' }>;

/** The edits not yet committed, and what the outbox remembers of the last ones. */
export type OutboxState = {
  queue: readonly RecoveryEditRequest[];
  /** The edit being sent. */
  sending: RecoveryEditRequest | undefined;
  /** The last edit's failure: edits wait for the next flush. */
  failure: unknown;
  /** A close whose reply was lost and whose outcome the store could not be asked for yet. */
  unsettled: { edit: CloseRequest; reopen: OpenRequest | undefined } | undefined;
  /** The layout last committed, so an unchanged layout is not sent again. */
  committedLayout: string | undefined;
};
export const emptyOutbox: OutboxState = {
  queue: [],
  sending: undefined,
  failure: undefined,
  unsettled: undefined,
  committedLayout: undefined,
};

/** Edits the store refuses as given, which a resync resolves; a repeat of one this many times stops. */
export const maximumResyncs = 3;

/** Whether the edit opens or closes the buffer. */
export const isStructural = (edit: RecoveryEditRequest, bufferId: string) =>
  (edit.kind === 'openTab' || edit.kind === 'closeTab') && edit.bufferId === bufferId;

/** Whether every edit made so far has committed. */
export const isOutboxIdle = (state: OutboxState) =>
  !state.queue.length && !state.sending && state.failure === undefined && !state.unsettled;

const pending = (state: OutboxState) => [state.sending, ...state.queue];
/** Whether an edit not yet committed opens or closes the buffer. */
export const isTabPending = (state: OutboxState, bufferId: string) =>
  pending(state).some((edit) => edit && isStructural(edit, bufferId));
/** Whether text for the buffer is queued or being sent. */
export const isDraftPending = (state: OutboxState, bufferId: string) =>
  pending(state).some((edit) => edit?.kind === 'updateDraft' && edit.bufferId === bufferId);

/** Queues a buffer's text: newer text replaces text not yet sent, unless opened or closed since. */
export function queueDraft(
  queue: readonly RecoveryEditRequest[],
  bufferId: string,
  text: string,
  disk: FileDocument,
): RecoveryEditRequest[] {
  const next = [...queue];
  for (let index = next.length - 1; index >= 0; index--) {
    const edit = next[index];
    if (isStructural(edit, bufferId)) break;
    if (edit.kind === 'updateDraft' && edit.bufferId === bufferId) {
      next[index] = { ...edit, text, disk: structuredClone(disk) };
      return next;
    }
  }
  next.push({ kind: 'updateDraft', bufferId, text, disk: structuredClone(disk) });
  return next;
}

/** Queues the layout, once: it is read when it is sent. */
export const queueLayout = (queue: readonly RecoveryEditRequest[]): RecoveryEditRequest[] => [
  ...queue.filter((edit) => edit.kind !== 'updateLayout'),
  { kind: 'updateLayout' },
];
