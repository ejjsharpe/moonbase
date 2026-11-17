import { useCallback, useEffect, useId, useMemo } from 'react';
import { Effect } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useAtomValue } from '@effect/atom-react';
import {
  nativeActionsAtoms,
  type ChatState,
  type NativeActionKind,
  type TranscriptNotice,
} from '@moonbase/application/chat';
import type { TranscriptCopy, TranscriptImage } from '../../../ipc/chat-rpcs.ts';
import type { DesktopRunner } from '../../shell/desktop-application.ts';

/** What a transcript asks of main for one chat target: Copy, opening a link, an image's URL. */
export type TranscriptNative = {
  copy(input: TranscriptCopy, signal?: AbortSignal): Promise<void>;
  openLink(url: string, signal?: AbortSignal): Promise<void>;
  imageUrl(input: TranscriptImage, signal?: AbortSignal): Promise<string>;
};

/** Stable for the transcript's lifetime, so rows can memoize on them. */
export type TranscriptActions = {
  run(action: (signal: AbortSignal) => Promise<void>, kind: NativeActionKind): void;
  openLink(url: string): void;
};

const noNotice = Atom.make<TranscriptNotice | null>(null);

/**
 * The transcript's native Copy/Open, run by the application's native actions (at most two at once,
 * one notice), which this view owns while mounted and cancels when it goes offline.
 */
export function useTranscriptActions(
  native: TranscriptNative | undefined,
  { ready, transcript: { observation } }: Pick<ChatState, 'ready' | 'transcript'>,
  runner: DesktopRunner,
) {
  const result = useAtomValue(nativeActionsAtoms.actions(useId()));
  const owned = AsyncResult.isSuccess(result) ? result.value : null;
  const notice = useAtomValue(owned ? nativeActionsAtoms.notice(owned) : noNotice);
  useEffect(() => {
    if (owned && (observation === 'inactive' || !ready)) runner.runSync(owned.cancel);
  }, [owned, observation, ready, runner]);
  const run = useCallback(
    (action: (signal: AbortSignal) => Promise<void>, kind: NativeActionKind) => {
      if (owned)
        runner.runSync(
          owned.run(Effect.tryPromise({ try: action, catch: (error) => error }), kind),
        );
    },
    [owned, runner],
  );
  const openLink = useCallback(
    (url: string) => {
      if (native) run((signal) => native.openLink(url, signal), 'open');
      else if (owned)
        runner.runSync(
          owned.show({ tone: 'error', text: 'Native link opening is unavailable in this view.' }),
        );
    },
    [native, run, owned, runner],
  );
  const actions = useMemo<TranscriptActions>(() => ({ run, openLink }), [run, openLink]);
  return { notice, actions };
}
