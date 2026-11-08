import type { EntryReference } from '@moonbase/contracts/workspace';
import { normalizeApplicationError } from '../../runtime/effect-client.ts';
import type { EditorMutation, MutationAction } from './workflows.ts';

/** How a direct mutation ended: done, declined (or aborted) without an error, or failed. */
export type MutationRunResult = { completed: boolean; error: string };

/**
 * Runs one file operation without a dialog: applies it, asks `confirmReplace` only when existing
 * destinations would be replaced, and applies again with that consent. It never throws; the
 * mutation is disposed on every path. Aborting `signal` disposes it at once, so a late reply
 * completes nothing, and resolves as declined.
 */
export async function runMutation(
  controller: {
    createMutation(action: MutationAction): EditorMutation;
    report(error: unknown): void;
  },
  action: MutationAction,
  destination: string,
  {
    confirmReplace,
    signal,
  }: {
    /** Resolves true to replace these captured destinations. */
    confirmReplace: (replacements: EntryReference[]) => Promise<boolean>;
    signal?: AbortSignal;
  },
): Promise<MutationRunResult> {
  const declined = { completed: false, error: '' };
  if (signal?.aborted) return declined;
  let mutation: EditorMutation;
  try {
    mutation = controller.createMutation(action);
  } catch (error) {
    return { completed: false, error: normalizeApplicationError(error).message };
  }
  let disposal: Promise<void> | undefined;
  const dispose = () => (disposal ??= mutation.dispose().catch(controller.report));
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    let completed = await mutation.apply(destination, '', false);
    const { error, replacements } = mutation.getSnapshot();
    if (!completed && !error && replacements?.length && !signal?.aborted) {
      if (!(await confirmReplace(replacements)) || signal?.aborted) return declined;
      completed = await mutation.apply(destination, '', true);
    }
    if (completed || signal?.aborted) return { completed, error: '' };
    return {
      completed: false,
      error: mutation.getSnapshot().error || 'File action unavailable. Try again.',
    };
  } finally {
    signal?.removeEventListener('abort', dispose);
    await dispose();
  }
}
