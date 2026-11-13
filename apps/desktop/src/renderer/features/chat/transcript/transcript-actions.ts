import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatState } from '@moonbase/application/chat';
import type { TranscriptNative } from '../../../../shared/ipc/chat-wire.ts';

export type NativeActionKind = 'copy' | 'open';
/** `success` clears itself; `error` stays until replaced. Neither ever reports another's outcome. */
export type TranscriptNotice = { tone: 'progress' | 'success' | 'error'; text: string };
/** Stable for the transcript's lifetime, so rows can memoize on them. */
export type TranscriptActions = {
  run(action: (signal: AbortSignal) => Promise<void>, kind: NativeActionKind): void;
  openLink(url: string): void;
};

const actionLabels = {
  copy: { pending: 'Copying complete source…', done: 'Copied.' },
  open: { pending: 'Opening link…', done: 'Opened in your browser.' },
} satisfies Record<NativeActionKind, { pending: string; done: string }>;
/** Native actions running at once; more are refused rather than queued. */
const maxNativeActions = 2;
/** A success notice clears after this; failures stay until replaced. */
const successNoticeMs = 4000;

/** Runs native Copy/Open with one visible notice, cancelling held actions when the view goes offline. */
export function useTranscriptActions(
  native: TranscriptNative | undefined,
  { ready, transcript: { observation } }: Pick<ChatState, 'ready' | 'transcript'>,
) {
  const [notice, setNotice] = useState<TranscriptNotice | null>(null);
  const jobs = useRef(new Set<AbortController>());
  useEffect(() => {
    const running = jobs.current;
    return () => {
      for (const job of running) job.abort();
    };
  }, []);
  useEffect(() => {
    if (
      (observation === 'inactive' || !ready) &&
      [...jobs.current].some((job) => !job.signal.aborted)
    ) {
      for (const job of jobs.current) job.abort();
      setNotice({
        tone: 'error',
        text: 'Native action cancelled because this view is offline. Reconnect and try again.',
      });
    }
  }, [observation, ready]);
  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const timer = setTimeout(
      () => setNotice((current) => (current === notice ? null : current)),
      successNoticeMs,
    );
    return () => clearTimeout(timer);
  }, [notice]);
  const run = useCallback(
    (action: (signal: AbortSignal) => Promise<void>, kind: NativeActionKind) => {
      if (jobs.current.size >= maxNativeActions) {
        setNotice({
          tone: 'error',
          text: 'Two native actions are still running. Wait for them to finish.',
        });
        return;
      }
      const job = new AbortController();
      jobs.current.add(job);
      setNotice({ tone: 'progress', text: actionLabels[kind].pending });
      void action(job.signal)
        .then(
          () => {
            if (!job.signal.aborted) setNotice({ tone: 'success', text: actionLabels[kind].done });
          },
          (error) => {
            if (!job.signal.aborted)
              setNotice({
                tone: 'error',
                text: error instanceof Error ? error.message : 'The action failed. Try again.',
              });
          },
        )
        .finally(() => jobs.current.delete(job));
    },
    [],
  );
  const openLink = useCallback(
    (url: string) => {
      if (native) run((signal) => native.openLink(url, signal), 'open');
      else setNotice({ tone: 'error', text: 'Native link opening is unavailable in this view.' });
    },
    [native, run],
  );
  const actions = useMemo<TranscriptActions>(() => ({ run, openLink }), [run, openLink]);
  return { notice, actions };
}
