import type { FileTarget } from '@moonbase/contracts/workspace';
import type { EditorBuffer, PendingSave } from '../buffers/buffers.ts';

/**
 * The Save request for a buffer: one whose outcome is still unknown is sent again as it was, so
 * the host can tell it is the same; otherwise a new one for the text now, made against the version
 * on disk it was edited from, or the conflicting version when overwriting it.
 */
export const makeSaveRequest = (
  buffer: EditorBuffer,
  target: FileTarget,
  clientId: string,
  overwrite: boolean,
): PendingSave =>
  buffer.pendingSave ?? {
    target: structuredClone(target),
    clientId,
    requestId: crypto.randomUUID(),
    text: buffer.text,
    expectedVersion: overwrite && buffer.conflict ? buffer.conflict.version : buffer.disk.version,
  };
