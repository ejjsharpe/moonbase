import { useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Button } from '@base-ui/react/button';
import type { LegendListRef } from '@legendapp/list/react';
import * as stylex from '@stylexjs/stylex';
import { Context } from 'effect';
import { RegistryContext, useAtom, useAtomMount, useAtomValue } from '@effect/atom-react';
import { controls } from '@moonbase/ui/controls';
import { space } from '@moonbase/ui/tokens.stylex';
import {
  ChatSelection,
  findRowEntryId,
  type ChatAtoms,
  type ChatServices,
} from '@moonbase/application/chat';
import type { ChatTarget, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { useRun } from '../../hooks/use-run.ts';
import { MarkdownCache } from './markdown/markdown-model.ts';
import { StoredImages } from './stored-image.tsx';
import { useTranscriptActions, type TranscriptNative } from './transcript-actions.ts';
import { TranscriptContext, type TranscriptShared } from './transcript-context.ts';
import { snapshotLabels, TranscriptFeedback } from './transcript-feedback.tsx';
import { TranscriptScroller } from './transcript-geometry.ts';
import { makeTranscriptView } from './transcript-view.ts';
import { TranscriptList } from './list/transcript-list.tsx';
import { useMountedRowKeys, useReadingRows } from './list/reading-rows.ts';
import { LiveLabelContext } from './row/transcript-row.tsx';

type Paging = 'earlier' | 'later' | 'latest';

/**
 * The open chat's conversation: what the transcript says about it, and its rows in a virtualized
 * list. Rows read their own state from the view's atoms; this reads only what the list needs.
 */
export function Transcript({
  services,
  atoms,
  backendId,
  target: shown,
  native,
}: {
  /** The open chat's services, whose selection the transcript reads and acts on. */
  services: Context.Context<ChatServices>;
  atoms: ChatAtoms;
  backendId: string;
  /** The chat shown; a view saved after the selection moved on lands nowhere. */
  target: ChatTarget;
  native?: TranscriptNative;
}) {
  const registry = useContext(RegistryContext);
  const selection = Context.get(services, ChatSelection);
  // The chat this view was made for: its key changes with the chat, but each draft commit makes a
  // new copy of the same selection, which must not reach the rows.
  const [target] = useState(shown);
  const [view] = useState(() => makeTranscriptView(atoms, selection));
  useAtomMount(view.openCalls.state);
  const list = useRef<LegendListRef | null>(null);
  const scroller = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return list.current?.getScrollableNode() ?? null;
      },
    }),
    [],
  );
  const reading = useReadingRows(scroller, view);
  const [imageSource, setImageSource] = useState<ChatTranscriptSource | null>(null);
  const latest = useAtomValue(atoms.transcript);
  const snapshot = useAtomValue(atoms.snapshot);
  const ready = useAtomValue(atoms.ready);
  const transcript = useAtomValue(view.transcript);
  const held = useAtomValue(view.held);
  const { notice, actions } = useTranscriptActions(native, { ready, transcript: latest });
  // The transcript's own chat actions, which its unmounting ends.
  const act = useRun();
  const [cache] = useState(() => new MarkdownCache());
  useEffect(() => () => cache.clear(), [cache]);
  const shared = useMemo<TranscriptShared>(
    () => ({
      selection,
      act,
      view,
      target,
      backendId,
      cache,
      native,
      actions,
    }),
    [selection, act, view, target, backendId, cache, native, actions],
  );
  const [jumping, jump] = useAtom(view.jumpToLatest, { mode: 'promise' });
  /** The last history read, which Retry repeats. */
  const [lastPaging, setLastPaging] = useState<Paging>('earlier');
  const page = (direction: Paging) => {
    const current = registry.get(view.transcript);
    if (direction !== 'latest' && (!current[direction] || current.loading)) return;
    setLastPaging(direction);
    if (direction === 'latest') {
      const scrollToEnd = () => void list.current?.scrollToEnd({ animated: false });
      void jump().then(scrollToEnd, scrollToEnd);
    } else void shared.act(direction === 'earlier' ? selection.showEarlier : selection.showLater);
  };
  /** The reader opened something while following; see TranscriptList's holdDisclosure. */
  const [holding, setHolding] = useState(false);
  const jumpToLatest = () => {
    setHolding(false);
    const selected = window.getSelection(),
      node = scroller.current;
    if (node && selected?.rangeCount && selected.getRangeAt(0).intersectsNode(node))
      selected.removeAllRanges();
    page('latest');
  };
  let liveLabel: string | undefined;
  if (snapshot && snapshot.state !== 'running') liveLabel = snapshotLabels[snapshot.state];
  if (held) liveLabel = 'Selected response';
  const mounted = useMountedRowKeys(transcript.rows, reading, imageSource, transcript.find.active);
  const [followingEnd, setFollowingEnd] = useState(true);
  /** Reads the saved view's missing anchor again, or repeats the last history read. */
  const retry = () => {
    // Retry is the reader's move, so it ends a held Find reveal; automatic paging leaves it.
    void shared.act(selection.cancelFindReveal);
    const anchor = transcript.view.anchor;
    const missing = anchor && findRowEntryId(anchor.key);
    if (missing && !transcript.rows.some((row) => row.key === anchor!.key))
      void shared.act(selection.jumpToEntry(missing));
    else page(lastPaging);
  };
  return (
    <TranscriptContext value={shared}>
      <TranscriptScroller value={scroller}>
        <StoredImages
          native={native}
          enabled={ready && !['inactive', 'reconnecting', 'failed'].includes(latest.observation)}
          fallback={scroller}
          onReadingSourceChange={setImageSource}>
          <section aria-label="Chat conversation" {...stylex.props(styles.transcript)}>
            <TranscriptFeedback
              snapshot={snapshot}
              notice={notice}
              transcript={latest}
              held={held}
              onRetry={retry}
            />
            <div {...stylex.props(styles.viewport)}>
              {snapshot && (
                <LiveLabelContext value={liveLabel}>
                  <TranscriptList
                    list={list}
                    mounted={mounted}
                    selecting={reading.selecting}
                    onFollowingChange={setFollowingEnd}
                    holding={holding}
                    onHoldingChange={setHolding}
                    onPage={page}
                    onReaderInput={() => void shared.act(selection.cancelFindReveal)}
                    header={edge}
                    footer={edge}
                  />
                </LiveLabelContext>
              )}
              {snapshot && (!followingEnd || transcript.later || held) && (
                <Button
                  {...stylex.props(controls.button, styles.jump)}
                  disabled={jumping.waiting}
                  onClick={jumpToLatest}>
                  Jump to latest
                </Button>
              )}
            </div>
          </section>
        </StoredImages>
      </TranscriptScroller>
    </TranscriptContext>
  );
}

const styles = stylex.create({
  /** The notices, then the list filling the rest of the column. */
  transcript: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 60,
    minWidth: 0,
  },
  viewport: { position: 'relative', display: 'flex', flex: 1, minHeight: 0, minWidth: 0 },
  jump: {
    position: 'absolute',
    bottom: space.lg,
    left: '50%',
    transform: 'translateX(-50%)',
    boxShadow: '0 2px 8px rgb(0 0 0 / 0.25)',
  },
  edge: { paddingBlock: space.sm },
});

/** The space above the first row and below the last. */
const edge = <div {...stylex.props(styles.edge)} />;
