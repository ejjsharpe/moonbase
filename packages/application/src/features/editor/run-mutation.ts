import type { EntryReference, OperationResult } from '@moonbase/contracts/workspace';
import { normalizeApplicationError } from '../../runtime/effect-client.ts';
import type { EditorMutation, MutationAction } from './workflows.ts';

/**
 * How a direct mutation ended: done, declined (or aborted) without an error, or failed. `items`
 * are the dispatched operation's per-entry outcomes, empty when none was dispatched; a batch that
 * failed partway lists the entries it did complete.
 */
export type MutationRunResult = {
  completed: boolean;
  error: string;
  items: OperationResult['items'];
};

/** Settles with `promise`, or with `fallback` as soon as `signal` aborts. */
function settleUnlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined, fallback: T) {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => resolve(fallback);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/**
 * Runs one file operation without a dialog: applies it, asks `confirmReplace` only when existing
 * destinations would be replaced, and applies again with that consent. It never throws, even when
 * `confirmReplace` does; the mutation is disposed exactly once on every path. Aborting `signal`
 * disposes it at once, so a late reply completes nothing, and resolves as declined without
 * waiting for a pending confirmation.
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
  if (signal?.aborted) return { completed: false, error: '', items: [] };
  let mutation: EditorMutation;
  try {
    mutation = controller.createMutation(action);
  } catch (error) {
    return { completed: false, error: normalizeApplicationError(error).message, items: [] };
  }
  const items = () => structuredClone(mutation.getSnapshot().result?.items ?? []);
  const declined = () => ({ completed: false, error: '', items: items() });
  let disposal: Promise<void> | undefined;
  const dispose = () => (disposal ??= mutation.dispose().catch(controller.report));
  signal?.addEventListener('abort', dispose, { once: true });
  try {
    let completed = await mutation.apply(destination, '', false);
    const { error, replacements } = mutation.getSnapshot();
    if (!completed && !error && replacements?.length && !signal?.aborted) {
      let consent: boolean;
      try {
        consent = await settleUnlessAborted(confirmReplace(replacements), signal, false);
      } catch (error) {
        if (signal?.aborted) return declined();
        return { completed: false, error: normalizeApplicationError(error).message, items: [] };
      }
      if (!consent || signal?.aborted) return declined();
      completed = await mutation.apply(destination, '', true);
    }
    if (completed || signal?.aborted) return { completed, error: '', items: items() };
    return {
      completed: false,
      error: mutation.getSnapshot().error || 'File action unavailable. Try again.',
      items: items(),
    };
  } finally {
    signal?.removeEventListener('abort', dispose);
    await dispose();
  }
}
