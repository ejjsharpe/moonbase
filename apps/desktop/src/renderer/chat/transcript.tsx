import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import {
  transcriptLimits,
  type ChatController,
  type ChatState,
  type TranscriptViewAnchor,
} from '@moonbase/application/chat';
import type { ChatEntry, ChatTranscriptSource } from '@moonbase/contracts/chat';
import type { TranscriptNative } from '../../chat/wire.ts';
import { MarkdownCache } from './markdown-model.ts';
import { activateChatFind } from './find.tsx';
import {
  collectActivityEvidence,
  getEntryTranscripts,
  isSameActivityEvidence,
} from './activity.ts';
import { StoredImages } from './stored-image.tsx';
import { getTranscriptParts } from './transcript-parts.ts';
import { isReadingNodePinned, subscribeReadingChanges } from './reading-pin.ts';
import { Entry, type EntryProps } from './transcript-entry.tsx';
import { useTranscriptActions } from './transcript-actions.ts';
import { getAnchorKey } from './transcript-disclosure.ts';
import { useSourceGroups, useStableValue } from './stable-props.ts';
import { TranscriptScroller, getReadingTop } from './transcript-geometry.ts';
import { transcriptStyles as styles } from './transcript-styles.ts';
import {
  createTranscriptScroll,
  isSameAnchor,
  transitionTranscriptScroll,
  type TranscriptScroll,
  type TranscriptScrollEvent,
  type TranscriptViewport,
} from './transcript-scroll.ts';

/** The application's newest window holds this many rows; live output can hide its oldest. */
const windowRows = transcriptLimits.displayedRows;
/** A scroll-captured reading anchor is saved to view memory once scrolling rests this long. */
const viewSaveDelayMs = 150;
const controlSelector = 'button, a[href], summary, [role="button"], input, select, label';

export function Transcript({
  controller,
  state: latestState,
  native,
}: {
  controller: ChatController;
  state: ChatState;
  native?: TranscriptNative;
}) {
  const root = useRef<HTMLElement>(null),
    content = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(() =>
      createTranscriptScroll(latestState.transcript.view.anchor),
    ),
    [imageSource, setImageSource] = useState<ChatTranscriptSource | null>(null),
    [presented, setPresented] = useState(latestState);
  const preserve = scroll.pins.live && getLiveIdentity(presented) !== getLiveIdentity(latestState);
  if (!preserve && presented !== latestState) setPresented(latestState);
  const state = preserve ? presented : latestState;
  const scrollState = useRef(scroll),
    current = useRef(state),
    /** The scrollTop last written here, so the scroll event it causes records nothing. */
    written = useRef<number | null>(null);
  useLayoutEffect(() => {
    current.current = state;
  }, [state]);
  const views = useViewSaving(controller, latestState.selected);
  const dispatch = useCallback(
    function dispatch(event: TranscriptScrollEvent) {
      const previous = scrollState.current;
      const { state: next, instruction } = transitionTranscriptScroll(previous, event);
      scrollState.current = next;
      // Rendering reads only these; the anchor and intent change on every scroll.
      if (
        next.mode !== previous.mode ||
        next.pins !== previous.pins ||
        next.earlierRow !== previous.earlierRow ||
        next.retry !== previous.retry
      )
        setScroll(next);
      const element = root.current;
      if (!element) return;
      if (instruction.cancelReveal) controller.cancelFindReveal();
      const write = (top: number) => {
        const before = element.scrollTop;
        element.scrollTop = top;
        // Only a moved position dispatches a scroll event to fence.
        if (element.scrollTop !== before) written.current = element.scrollTop;
      };
      if (instruction.scroll === 'end') write(element.scrollHeight);
      const top =
        instruction.scroll === 'anchor' && getAnchorTop(element, next, current.current, controller);
      if (typeof top === 'number') {
        write(top);
        dispatch({ type: 'applied' });
      }
      if (instruction.capture)
        dispatch({ type: 'captured', position: captureAnchor(element, controller) });
      if (instruction.save !== undefined) views.save(instruction.save);
      const navigation = instruction.navigate;
      if (!navigation) return;
      if (navigation === 'latest') {
        views.cancel();
        const selection = window.getSelection();
        if (selection?.rangeCount && selection.getRangeAt(0).intersectsNode(element))
          selection.removeAllRanges();
      } else views.flush();
      const pending = {
        earlier: () => controller.older(),
        later: () => controller.later(),
        latest: () => controller.jumpToLatest(),
        row: () => Promise.resolve(),
      }[navigation]();
      void pending.finally(() =>
        requestAnimationFrame(() => {
          if (!root.current) return;
          views.flush();
          dispatch({
            type: 'navigated',
            revision: next.revision,
            saved: controller.getSnapshot().transcript.view.anchor,
            viewport: getViewport(root.current, current.current),
          });
        }),
      );
    },
    [controller, views],
  );
  useEffect(
    () =>
      subscribeReadingChanges(() => {
        const live = root.current?.querySelector<HTMLElement>('[data-transcript-live]') ?? null;
        const oldest = root.current?.querySelector<HTMLElement>('[data-transcript-entry]') ?? null;
        dispatch({
          type: 'pinned',
          live: isReadingNodePinned(live),
          oldest: isReadingNodePinned(oldest) ? oldest!.dataset.transcriptEntry! : null,
        });
      }),
    [dispatch],
  );
  const { notice, actions } = useTranscriptActions(native, latestState);
  const [cache] = useState(() => new MarkdownCache());
  useEffect(() => () => cache.clear(), [cache]);
  useLayoutEffect(() => {
    const anchor = state.transcript.view.anchor,
      { find } = current.current.transcript;
    // This view's own saves need no re-application.
    if (!anchor || views.isOwn(anchor)) return;
    views.cancel();
    const reveal =
      find.revealing &&
      !anchor.source &&
      anchor.entryId === find.active?.source.entryId &&
      anchor.partId === find.active.partId;
    dispatch(reveal ? { type: 'reveal' } : { type: 'supplied', anchor });
  }, [state.transcript.view.anchor, dispatch, views]);
  const { active: findActive, revealing: findRevealing } = state.transcript.find;
  // Declared before the resize re-anchor: a Part has already revealed a rendered match in this
  // commit, and re-applying the previous anchor would scroll it away again.
  useLayoutEffect(() => {
    if (!findActive || !findRevealing) return;
    views.cancel();
    dispatch({ type: 'reveal' });
  }, [findActive, findRevealing, dispatch, views]);
  const resize = useCallback(() => {
    if (root.current)
      dispatch({ type: 'resized', viewport: getViewport(root.current, current.current) });
  }, [dispatch]);
  const hasRun = !!state.snapshot?.run;
  // Content size changes reach the observer below; this re-anchors window changes, which can
  // replace rows without changing the total height.
  useLayoutEffect(resize, [
    state.transcript.entries,
    state.transcript.atLatest,
    hasRun,
    preserve,
    resize,
  ]);
  useEffect(() => {
    if (!content.current) return;
    const observer = new ResizeObserver(resize);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [resize]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    element.addEventListener('scrollend', views.flush);
    return () => element.removeEventListener('scrollend', views.flush);
  }, [views]);
  const navigate = (direction: 'earlier' | 'later', retry?: true) =>
    dispatch({
      type: 'navigate',
      direction,
      ...(retry && { retry }),
      viewport: getViewport(root.current!, current.current),
    });
  const input = (device: 'wheel' | 'key' | 'pointer' | 'control', upward: boolean) =>
    dispatch({
      type: 'input',
      device,
      upward,
      viewport: getViewport(root.current!, current.current),
    });
  const onScroll = () => {
    const element = root.current!,
      top = getAnchorTop(element, scrollState.current, current.current, controller),
      at = (target: number | null) => target !== null && Math.abs(target - element.scrollTop) < 1;
    const held = at(written.current) || at(top);
    written.current = null;
    views.deferring(() =>
      dispatch({
        type: 'scrolled',
        held,
        viewport: getViewport(element, current.current),
      }),
    );
  };
  const status = latestState.transcript;
  const currentSnapshot = latestState.snapshot;
  const transcript = state.transcript,
    snapshot = state.snapshot,
    oldestPinned =
      transcript.entries.length === windowRows &&
      (transcript.view.anchor?.entryId === transcript.entries[0]?.id ||
        scroll.pins.oldest === transcript.entries[0]?.id ||
        (!!imageSource &&
          !!transcript.entries[0]?.transcript &&
          JSON.stringify(transcript.entries[0].transcript.source) === JSON.stringify(imageSource))),
    live = !scroll.earlierRow && !oldestPinned && !transcript.later ? snapshot?.run : null;
  const hiddenRow = !!live && transcript.entries.length === windowRows;
  const entries = hiddenRow ? transcript.entries.slice(1) : transcript.entries;
  const collected = useMemo(
    () =>
      collectActivityEvidence([
        ...getEntryTranscripts(transcript.entries, transcript.manifest),
        ...(live?.transcript
          ? [
              {
                ...live.transcript,
                parts: getTranscriptParts(live.transcript, transcript.manifest),
              },
            ]
          : []),
      ]),
    [transcript.entries, transcript.manifest, live],
  );
  // Streaming rebuilds the evidence each frame; rows keep it while its states are unchanged.
  const [evidence, setEvidence] = useState(collected);
  if (evidence !== collected && !isSameActivityEvidence(evidence, collected))
    setEvidence(collected);
  const liveEntry = useMemo<ChatEntry | null>(
    () =>
      live
        ? {
            id: 'live',
            role: 'assistant',
            text: live.text || 'Working…',
            truncated: live.truncated,
            transcript: live.transcript,
          }
        : null,
    [live],
  );
  const getRowProps = useRowProps(transcript);
  let liveLabel: string | undefined = live?.state;
  if (currentSnapshot && currentSnapshot.state !== 'running')
    liveLabel = snapshotLabels[currentSnapshot.state];
  if (preserve) liveLabel = 'Selected response';
  const shared = { controller, cache, native, actions, evidence };
  const failed = currentSnapshot && ['failed', 'uncertain'].includes(currentSnapshot.state);
  const body = (
    <section
      ref={root}
      aria-label="Chat transcript"
      tabIndex={0}
      onScroll={onScroll}
      onWheel={(event) => input('wheel', event.deltaY < 0)}
      onKeyDown={(event) => {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          !target.closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
          ) &&
          ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Enter'].includes(
            event.key,
          )
        )
          input(
            'key',
            ['PageUp', 'Home', 'ArrowUp'].includes(event.key) ||
              (event.key === ' ' && event.shiftKey),
          );
      }}
      onPointerDown={(event) => {
        // A press on the scroller itself is on its scrollbar; touch can drag-scroll anywhere.
        const away = event.target === event.currentTarget || event.pointerType === 'touch';
        const control =
          !away && event.target instanceof Element && !!event.target.closest(controlSelector);
        input(control ? 'control' : 'pointer', away);
      }}
      {...stylex.props(styles.transcript)}>
      <div ref={content} {...stylex.props(styles.measure)}>
        {!snapshot && (
          <p>
            {state.ready
              ? 'Reading the saved chat…'
              : 'This view is offline. Its draft and unresolved command identities are retained.'}
          </p>
        )}
        <div data-transcript-chrome {...stylex.props(styles.chrome)}>
          <div {...stylex.props(controls.row, styles.navigation)}>
            <Button
              {...stylex.props(controls.button, controls.quietButton)}
              disabled={!state.ready || (!transcript.earlier && !hiddenRow) || transcript.loading}
              onClick={() => navigate('earlier')}>
              {transcript.loading ? 'Loading history…' : 'Load earlier'}
            </Button>
            <Button
              {...stylex.props(controls.button, controls.quietButton)}
              onClick={(event) => activateChatFind(controller, event.currentTarget)}>
              Find
            </Button>
            {transcript.later && (
              <Button
                {...stylex.props(controls.button, controls.quietButton)}
                disabled={!state.ready || transcript.loading}
                onClick={() => navigate('later')}>
                Read later
              </Button>
            )}
            {(status.view.anchor?.source ||
              preserve ||
              scroll.mode !== 'following' ||
              !transcript.atLatest) && (
              <Button
                {...stylex.props(controls.button, controls.quietButton)}
                onClick={() => dispatch({ type: 'latest' })}>
                Jump to latest
              </Button>
            )}
          </div>
          {currentSnapshot && (
            <p
              aria-label="Conversation status"
              role={failed ? 'alert' : 'status'}
              {...stylex.props(failed ? styles.warning : styles.small, styles.feedback)}>
              {snapshotLabels[currentSnapshot.state]}
              {currentSnapshot.message && ` · ${currentSnapshot.message}`}
            </p>
          )}
          {notice && (
            <p
              role={notice.tone === 'error' ? 'alert' : 'status'}
              {...stylex.props(
                notice.tone === 'error' ? styles.warning : styles.small,
                styles.feedback,
              )}>
              {notice.text}
            </p>
          )}
        </div>
        {status.error && (
          <p role="alert" {...stylex.props(styles.warning)}>
            {status.error}{' '}
            <Button
              {...stylex.props(controls.button)}
              onClick={() => {
                const missing = transcript.view.anchor;
                if (
                  missing &&
                  !missing.source &&
                  !transcript.entries.some((entry) => entry.id === missing.entryId)
                )
                  void controller.jumpToEntry(missing.entryId);
                else if (scroll.retry === 'latest') dispatch({ type: 'latest' });
                else navigate(scroll.retry, true);
              }}>
              Retry history
            </Button>
          </p>
        )}
        {status.observation === 'reconnecting' && (
          <p role="status" {...stylex.props(styles.small)}>
            Reconnecting. Showing the last received content; live reads and Copy wait for a fresh
            connection.
          </p>
        )}
        {status.observation === 'failed' && (
          <p role="alert" {...stylex.props(styles.warning)}>
            Live updates stopped. Reopen the conversation to refresh.
          </p>
        )}
        {status.observation === 'legacy' && (
          <p {...stylex.props(styles.small)}>
            This host updates periodically. Upgrade the host for streaming responses.
          </p>
        )}
        {status.capabilities.transcript === 'legacy' && (
          <p {...stylex.props(styles.small)}>
            Upgrade this host for complete transcript reads and Copy. Previews remain readable.
          </p>
        )}

        {preserve && (
          <p role="status" {...stylex.props(styles.small)}>
            The response changed. Your selection is retained; Jump to latest to read the current
            output.
          </p>
        )}
        {entries.map((entry) => (
          <Entry key={'entry:' + entry.id} entry={entry} {...shared} {...getRowProps(entry)} />
        ))}
        {liveEntry && (
          <Entry
            key="live"
            entry={liveEntry}
            liveState={liveLabel}
            {...shared}
            {...getRowProps(liveEntry)}
          />
        )}
        {live &&
          !live.transcript &&
          live.tools.map((tool) => (
            <section key={tool.taskId} {...stylex.props(styles.message)}>
              <strong>
                {tool.name} · {tool.state}
              </strong>
              <pre tabIndex={0} {...stylex.props(styles.output)}>
                {tool.text}
              </pre>
              {tool.truncated && (
                <p {...stylex.props(styles.small)}>
                  This host supplied a tool-output preview. Upgrade the host for complete reads.
                </p>
              )}
            </section>
          ))}
      </div>
    </section>
  );
  return (
    <TranscriptScroller.Provider value={root}>
      <StoredImages
        native={native}
        enabled={
          latestState.ready &&
          !['inactive', 'reconnecting', 'failed'].includes(latestState.transcript.observation)
        }
        fallback={root}
        onReadingSourceChange={setImageSource}>
        {body}
      </StoredImages>
    </TranscriptScroller.Provider>
  );
}

type RowProps = Omit<EntryProps, 'entry' | 'liveState' | keyof SharedRowProps>;
type SharedRowProps = Pick<EntryProps, 'controller' | 'cache' | 'native' | 'actions' | 'evidence'>;
/** Slices transcript state per row, in values that keep their identity while unchanged. */
function useRowProps(transcript: ChatState['transcript']) {
  const contents = useSourceGroups(transcript.content);
  const matches = useSourceGroups(transcript.find.matches);
  const { anchor } = transcript.view;
  // Each view save decodes a fresh list.
  const expanded = useStableValue(transcript.view.expanded);
  const anchorKey = useMemo(() => (anchor ? getAnchorKey(anchor) : null), [anchor]);
  const { active, revealing, query } = transcript.find;
  const { manifest, observation } = transcript;
  const offline = ['reconnecting', 'failed', 'inactive'].includes(observation);
  return (entry: ChatEntry): RowProps => {
    const source = entry.transcript?.source;
    const key = source && JSON.stringify(source);
    const anchored =
      !!anchor &&
      !!source &&
      (anchor.source ? source.kind === 'live' : anchor.entryId === entry.id);
    const findMatch = active && key && JSON.stringify(active.source) === key ? active : null;
    const findMatches = matches(source);
    return {
      manifest: manifest && key && JSON.stringify(manifest.source) === key ? manifest : null,
      anchorPart: anchored ? (anchor.partId ?? null) : null,
      anchorKey: anchored ? anchorKey : null,
      finding: !!active,
      findMatch,
      findRevealing: !!findMatch && revealing,
      findQuery: findMatch || findMatches.length ? query : '',
      findMatches,
      contents: contents(source),
      expandedIds: expanded,
      offline,
    };
  };
}

/**
 * Saves the reading anchor to view memory. Saves captured while scrolling wait until it rests, so
 * scrolling publishes nothing per event; navigation flushes them and jumping to latest drops them.
 */
function useViewSaving(controller: ChatController, selected: ChatState['selected']) {
  const [selection] = useState(() => JSON.stringify(selected));
  const [views] = useState(() => {
    let pending: { anchor: TranscriptViewAnchor | null } | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      deferred = false,
      own: TranscriptViewAnchor | null | undefined;
    const write = (anchor: TranscriptViewAnchor | null) => {
      const { view } = controller.getSnapshot().transcript;
      // Following saves no anchor on each update; only a change needs a write.
      if (!anchor && !view.anchor) return;
      own = anchor;
      controller.setTranscriptView({ anchor, expanded: view.expanded });
    };
    const cancel = () => {
      clearTimeout(timer);
      pending = null;
    };
    const flush = () => {
      const saved = pending;
      cancel();
      // A row switch unmounts this view after the selection changed; its save would land there.
      if (saved && JSON.stringify(controller.getSnapshot().selected) === selection)
        write(saved.anchor);
    };
    return {
      save(anchor: TranscriptViewAnchor | null) {
        if (!deferred) {
          cancel();
          write(anchor);
          return;
        }
        pending = { anchor };
        clearTimeout(timer);
        timer = setTimeout(flush, viewSaveDelayMs);
      },
      /** Runs `work` with its saves deferred until scrolling rests. */
      deferring(work: () => void) {
        deferred = true;
        try {
          work();
        } finally {
          deferred = false;
        }
      },
      flush,
      cancel,
      /** Whether `anchor` is this view's last save, echoed back by the application. */
      isOwn: (anchor: TranscriptViewAnchor) => own !== undefined && isSameAnchor(anchor, own),
    };
  });
  useEffect(() => views.flush, [views]);
  return views;
}

function getLiveIdentity(state: ChatState) {
  return JSON.stringify(
    state.snapshot?.run?.transcript?.source ?? state.snapshot?.run?.stop ?? null,
  );
}
function getViewport(
  element: HTMLElement,
  { transcript, snapshot }: ChatState,
): TranscriptViewport {
  return {
    top: element.scrollTop,
    bottom: element.scrollHeight - element.scrollTop - element.clientHeight,
    atLatest: transcript.atLatest,
    selected: window.getSelection()?.isCollapsed === false,
    earlier:
      transcript.earlier &&
      !transcript.loading &&
      !document.activeElement?.closest('[data-transcript-entry], [data-transcript-live]'),
    boundary: transcript.atLatest && !!snapshot?.run && transcript.entries.length === windowRows,
  };
}
/** Records the first visible entry/part as a semantic, viewport-relative anchor. */
function captureAnchor(
  element: HTMLElement,
  controller: ChatController,
): TranscriptViewAnchor | undefined {
  const observed = controller.getSnapshot();
  const top = getReadingTop(element);
  const nodes = [
    ...element.querySelectorAll<HTMLElement>(
      '[data-transcript-part], [data-transcript-entry], [data-transcript-live]',
    ),
  ];
  const node =
    nodes.find(
      (node) =>
        node.getBoundingClientRect().bottom > top && node.getBoundingClientRect().top >= top,
    ) ?? nodes.find((node) => node.getBoundingClientRect().bottom > top);
  if (!node) return;
  const row = node.closest<HTMLElement>('[data-transcript-entry], [data-transcript-live]')!;
  if (!row.dataset.transcriptLive)
    return {
      entryId: row.dataset.transcriptEntry!,
      ...(node.dataset.transcriptPart ? { partId: node.dataset.transcriptPart } : {}),
      offset: node.getBoundingClientRect().top - top,
    };
  const summary = observed.snapshot?.run?.transcript;
  if (
    !observed.ready ||
    !summary ||
    row.dataset.transcriptLive !== JSON.stringify(summary.source) ||
    summary.source.kind !== 'live' ||
    ['inactive', 'reconnecting', 'failed'].includes(observed.transcript.observation)
  )
    return;
  const partNode = node.dataset.transcriptPart
    ? node
    : row.querySelector<HTMLElement>('[data-transcript-part]');
  const part =
    getTranscriptParts(summary, observed.transcript.manifest).find(
      (part) => part.partId === partNode?.dataset.transcriptPart,
    ) ?? summary.parts.find((part) => part.partId === partNode?.dataset.transcriptPart);
  if (!part || part.availability !== 'available') return;
  return {
    backendId: controller.backendId,
    source: summary.source,
    partId: part.partId,
    bytes: part.bytes,
    revision: part.revision,
    offset: partNode!.getBoundingClientRect().top - top,
  };
}
/**
 * Finds the scroll position that places the anchor at its offset, or a missing row/part nearby. A
 * pending restoration waits for its window and parts.
 */
function getAnchorTop(
  element: HTMLElement,
  { anchor: target, mode }: TranscriptScroll,
  state: ChatState,
  { backendId }: ChatController,
) {
  const restoring = mode === 'restoring';
  if (!target || (target.source && target.backendId !== backendId)) return null;
  if (restoring && (!state.snapshot || state.transcript.loading)) return null;
  const nodes = [
    ...element.querySelectorAll<HTMLElement>('[data-transcript-entry], [data-transcript-live]'),
  ];
  const entry = nodes.find((node) =>
    target.source ? !!node.dataset.transcriptLive : node.dataset.transcriptEntry === target.entryId,
  );
  const part =
    target.partId &&
    [...(entry?.querySelectorAll<HTMLElement>('[data-transcript-part]') ?? [])].find(
      (node) => node.dataset.transcriptPart === target.partId,
    );
  const manifest = state.transcript.manifest;
  const summary = target.source
    ? state.snapshot?.run?.transcript
    : state.transcript.entries.find((entry) => entry.id === target.entryId)?.transcript;
  if (
    restoring &&
    target.partId &&
    !part &&
    summary &&
    (manifest && sameSource(summary, manifest)
      ? !manifest.error && manifest.status !== 'complete'
      : !!summary.nextCursor)
  )
    return null;
  const node =
    (part &&
      (part.getClientRects().length
        ? part
        : part.closest<HTMLElement>('[data-transcript-activity]'))) ||
    entry ||
    (restoring ? nodes.at(-1) : undefined);
  if (!node) return null;
  const top =
    element.scrollTop + node.getBoundingClientRect().top - getReadingTop(element) - target.offset;
  return Math.max(0, Math.min(top, element.scrollHeight - element.clientHeight));
}
const snapshotLabels = {
  idle: 'Idle',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  uncertain: 'Uncertain',
};
const sameSource = (a: { source: unknown }, b: { source: unknown }) =>
  JSON.stringify(a.source) === JSON.stringify(b.source);
