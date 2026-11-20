import { useCallback, useEffect, useId, useMemo } from 'react';
import type { Effect } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { useAtomValue } from '@effect/atom-react';
import {
  nativeActionsAtoms,
  type ChatState,
  type NativeActionKind,
  type TranscriptNotice,
} from '@moonbase/application/chat';
import type { ChatTargetId } from '../../../ipc/chat-rpcs.ts';
import type { DesktopNativeShape } from '../../ipc/desktop-native.ts';
import { useRun } from '../../hooks/use-run.ts';

/** What a transcript asks of main for one chat target: Copy, opening a link, an image's URL. */
export type TranscriptNative = DesktopNativeShape['transcripts'][ChatTargetId];

/** Stable for the transcript's lifetime, so rows can memoize on them. */
export type TranscriptActions = {
  run(action: Effect.Effect<void, unknown>, kind: NativeActionKind): void;
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
) {
  const start = useRun();
  const result = useAtomValue(nativeActionsAtoms.actions(useId()));
  const owned = AsyncResult.isSuccess(result) ? result.value : null;
  const notice = useAtomValue(owned ? nativeActionsAtoms.notice(owned) : noNotice);
  useEffect(() => {
    if (owned && (observation === 'inactive' || !ready)) start(owned.cancel);
  }, [owned, observation, ready, start]);
  const run = useCallback(
    (action: Effect.Effect<void, unknown>, kind: NativeActionKind) => {
      if (owned) start(owned.run(action, kind));
    },
    [owned, start],
  );
  const openLink = useCallback(
    (url: string) => {
      if (native) run(native.openLink(url), 'open');
      else if (owned)
        start(
          owned.show({ tone: 'error', text: 'Native link opening is unavailable in this view.' }),
        );
    },
    [native, run, owned, start],
  );
  const actions = useMemo<TranscriptActions>(() => ({ run, openLink }), [run, openLink]);
  return { notice, actions };
}
