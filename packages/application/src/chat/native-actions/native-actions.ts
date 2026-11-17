/** What a transcript asks of its platform: Copy, or opening a link. */
export type NativeActionKind = 'copy' | 'open';
/** `success` clears itself; `error` stays until replaced. Neither ever reports another's outcome. */
export type TranscriptNotice = { tone: 'progress' | 'success' | 'error'; text: string };

/** Native actions running at once; more are refused rather than queued. */
export const maxNativeActions = 2;
/** A success notice clears after this; failures stay until replaced. */
export const successNoticeMs = 4000;

const labels = {
  copy: { pending: 'Copying complete source…', done: 'Copied.' },
  open: { pending: 'Opening link…', done: 'Opened in your browser.' },
} satisfies Record<NativeActionKind, { pending: string; done: string }>;

export const pendingNotice = (kind: NativeActionKind): TranscriptNotice => ({
  tone: 'progress',
  text: labels[kind].pending,
});
export const doneNotice = (kind: NativeActionKind): TranscriptNotice => ({
  tone: 'success',
  text: labels[kind].done,
});
export const busyNotice: TranscriptNotice = {
  tone: 'error',
  text: 'Two native actions are still running. Wait for them to finish.',
};
export const offlineNotice: TranscriptNotice = {
  tone: 'error',
  text: 'Native action cancelled because this view is offline. Reconnect and try again.',
};
/** A failed action's notice: Moonbase's own message for it, else fixed text. */
export const failedNotice = (error: unknown): TranscriptNotice => ({
  tone: 'error',
  text: error instanceof Error ? error.message : 'The action failed. Try again.',
});
