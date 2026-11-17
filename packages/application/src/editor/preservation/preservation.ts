import type { FileTarget } from '@moonbase/contracts/workspace';
import type { BuffersState, EditorBuffer } from '../buffers/buffers.ts';
import { isSaving } from '../buffers/buffers.ts';
import { fileKey } from '../recovery/recovery-references.ts';
import { isOutboxIdle, type OutboxState } from '../recovery/recovery-outbox.ts';
import { areOperationsSettled, type OperationsState } from '../operations/operations.ts';
import type { SessionState } from '../session/session-service.ts';

export type CloseChoice = 'save' | 'discard' | 'cancel';
/** A close asks Save, Discard or Cancel for a buffer with unsaved changes. */
export type ClosePrompt = { id: string; buffer: Readonly<EditorBuffer> };
export const isCloseChoice = (choice: unknown): choice is CloseChoice =>
  choice === 'save' || choice === 'discard' || choice === 'cancel';

/**
 * Whether everything the editor holds is in recovery: it is loaded and idle, every edit has
 * committed, no save is unsettled and every file operation is acknowledged.
 */
export const isRecoveryReady = (
  session: SessionState,
  outbox: OutboxState,
  buffers: BuffersState,
  operations: OperationsState,
) =>
  session.ready &&
  !session.loading &&
  !session.closing &&
  !session.preserving &&
  !session.initializing &&
  isOutboxIdle(outbox) &&
  ![...buffers.buffers.values()].some(isSaving) &&
  areOperationsSettled(operations);

/** The files a close takes, each once. */
export const captureTargets = (targets: readonly FileTarget[]) => [
  ...new Map(targets.map((target) => [fileKey(target), structuredClone(target)])).values(),
];
