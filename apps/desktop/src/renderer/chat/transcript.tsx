import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button } from '@base-ui/react/button';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { colors, layout, radius, space, type } from '@moonbase/ui/tokens.stylex';
import type {
  ChatController,
  ChatState,
  TranscriptContentState,
  TranscriptViewAnchor,
} from '@moonbase/application/chat';
import type {
  ChatEntry,
  ChatTranscript,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import type { TranscriptNative } from '../../chat/wire.ts';
import { getTranscriptDisclosureId } from '../../chat/transcript-source.ts';
import { Markdown, isReadingNodePinned } from './markdown.tsx';
import { MarkdownCache } from './markdown-model.ts';
import { activateChatFind, locateFindRanges, paintFindRanges } from './find.tsx';
import {
  collectActivityEvidence,
  getActivityState,
  getEntryTranscripts,
  getToolSummary,
  groupTranscriptParts,
  type ActivityEvidence,
} from './activity.ts';
import { RecordedPatch } from './recorded-patch.tsx';
import { StoredImage, StoredImages } from './stored-image.tsx';
import { getTranscriptParts } from './transcript-parts.ts';
import { usePartBody } from './part-body.ts';
import {
  createTranscriptScroll,
  transitionTranscriptScroll,
  type TranscriptScroll,
  type TranscriptScrollEvent,
  type TranscriptViewport,
} from './transcript-scroll.ts';

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
      const view = controller.getSnapshot().transcript.view;
      // Following saves no anchor on each update; only a change needs a write.
      if (instruction.save !== undefined && (instruction.save || view.anchor))
        controller.setTranscriptView({ anchor: instruction.save, expanded: view.expanded });
      const navigation = instruction.navigate;
      if (!navigation) return;
      if (navigation === 'latest') {
        const selection = window.getSelection();
        if (selection?.rangeCount && selection.getRangeAt(0).intersectsNode(element))
          selection.removeAllRanges();
      }
      const pending = {
        earlier: () => controller.showEarlier(),
        later: () => controller.showLater(),
        latest: () => controller.jumpToLatest(),
        row: () => Promise.resolve(),
      }[navigation]();
      void pending.finally(() =>
        requestAnimationFrame(() => {
          if (root.current)
            dispatch({
              type: 'navigated',
              revision: next.revision,
              saved: controller.getSnapshot().transcript.view.anchor,
              viewport: getViewport(root.current, current.current),
            });
        }),
      );
    },
    [controller],
  );
  useEffect(() => {
    const update = () => {
      const live = root.current?.querySelector<HTMLElement>('[data-transcript-live]') ?? null;
      const oldest = root.current?.querySelector<HTMLElement>('[data-transcript-entry]') ?? null;
      dispatch({
        type: 'pinned',
        live: isReadingNodePinned(live),
        oldest: isReadingNodePinned(oldest) ? oldest!.dataset.transcriptEntry! : null,
      });
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, [dispatch]);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const jobs = useRef(new Set<AbortController>());
  const [cache] = useState(() => new MarkdownCache());
  useEffect(
    () => () => {
      for (const job of jobs.current) job.abort();
      cache.clear();
    },
    [controller, cache],
  );
  useEffect(() => {
    if (
      (latestState.transcript.observation === 'inactive' || !latestState.ready) &&
      [...jobs.current].some((job) => !job.signal.aborted)
    ) {
      for (const job of jobs.current) job.abort();
      setNotice({
        error: true,
        text: 'Native action cancelled because this view is offline. Reconnect and try again.',
      });
    }
  }, [latestState.transcript.observation, latestState.ready]);
  const run = useCallback((action: (signal: AbortSignal) => Promise<void>, success: string) => {
    if (jobs.current.size >= 2) {
      setNotice({
        error: true,
        text: 'Two native actions are still running. Wait for them to finish.',
      });
      return;
    }
    const job = new AbortController();
    jobs.current.add(job);
    setNotice({
      error: false,
      text: success === 'Copied.' ? 'Copying complete source…' : 'Opening link…',
    });
    void action(job.signal)
      .then(
        () => {
          if (!job.signal.aborted) setNotice({ error: false, text: success });
        },
        (error) => {
          if (!job.signal.aborted)
            setNotice({
              error: true,
              text: error instanceof Error ? error.message : 'The action failed. Try again.',
            });
        },
      )
      .finally(() => jobs.current.delete(job));
  }, []);
  const openLink = useCallback(
    (url: string) => {
      if (native) run((signal) => native.openLink(url, signal), 'Opened in your browser.');
      else setNotice({ error: true, text: 'Native link opening is unavailable in this view.' });
    },
    [native, run],
  );
  useLayoutEffect(() => {
    const anchor = state.transcript.view.anchor,
      { find } = current.current.transcript;
    if (!anchor) return;
    const reveal =
      find.revealing &&
      !anchor.source &&
      anchor.entryId === find.active?.source.entryId &&
      anchor.partId === find.active.partId;
    dispatch(reveal ? { type: 'reveal' } : { type: 'supplied', anchor });
  }, [state.transcript.view.anchor, dispatch]);
  const { active: findActive, revealing: findRevealing } = state.transcript.find;
  // Declared before the resize re-anchor: a Part has already revealed a rendered match in this
  // commit, and re-applying the previous anchor would scroll it away again.
  useLayoutEffect(() => {
    if (findActive && findRevealing) dispatch({ type: 'reveal' });
  }, [findActive, findRevealing, dispatch]);
  const resize = useCallback(() => {
    if (root.current)
      dispatch({ type: 'resized', viewport: getViewport(root.current, current.current) });
  }, [dispatch]);
  useLayoutEffect(resize, [state.transcript, state.snapshot?.run, resize]);
  useEffect(() => {
    if (!content.current) return;
    const observer = new ResizeObserver(resize);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [resize]);
  const navigate = (direction: 'earlier' | 'later', retry?: true) =>
    dispatch({
      type: 'navigate',
      direction,
      ...(retry && { retry }),
      viewport: getViewport(root.current!, current.current),
    });
  const input = (device: 'wheel' | 'key' | 'pointer', upward: boolean) =>
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
    dispatch({
      type: 'scrolled',
      held,
      viewport: getViewport(element, current.current),
    });
  };
  const status = latestState.transcript;
  const currentSnapshot = latestState.snapshot;
  const transcript = state.transcript,
    snapshot = state.snapshot,
    oldestPinned =
      transcript.entries.length === 128 &&
      (transcript.view.anchor?.entryId === transcript.entries[0]?.id ||
        scroll.pins.oldest === transcript.entries[0]?.id ||
        (!!imageSource &&
          !!transcript.entries[0]?.transcript &&
          sameSource(transcript.entries[0].transcript, { source: imageSource }))),
    live = !scroll.earlierRow && !oldestPinned && !transcript.later ? snapshot?.run : null;
  const hiddenRow = !!live && transcript.entries.length === 128;
  const entries = hiddenRow ? transcript.entries.slice(1) : transcript.entries;
  const evidence = useMemo(
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
  let liveLabel: string | undefined = live?.state;
  if (currentSnapshot && currentSnapshot.state !== 'running')
    liveLabel = snapshotLabels[currentSnapshot.state];
  if (preserve) liveLabel = 'Selected response';
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
      onPointerDown={(event) =>
        input('pointer', event.target === event.currentTarget || event.pointerType === 'touch')
      }
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
              role={['failed', 'uncertain'].includes(currentSnapshot.state) ? 'alert' : 'status'}
              {...stylex.props(
                ['failed', 'uncertain'].includes(currentSnapshot.state)
                  ? styles.warning
                  : styles.small,
                styles.feedback,
              )}>
              {snapshotLabels[currentSnapshot.state]}
              {currentSnapshot.message && ` · ${currentSnapshot.message}`}
            </p>
          )}
          {notice && (
            <p
              role={notice.error ? 'alert' : 'status'}
              {...stylex.props(notice.error ? styles.warning : styles.small, styles.feedback)}>
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
          <Entry
            key={'entry:' + entry.id}
            entry={entry}
            evidence={evidence}
            controller={controller}
            state={transcript}
            cache={cache}
            native={native}
            run={run}
            openLink={openLink}
          />
        ))}
        {live && (
          <Entry
            key="live"
            evidence={evidence}
            entry={{
              id: 'live',
              role: 'assistant',
              text: live.text || 'Working…',
              truncated: live.truncated,
              transcript: live.transcript,
            }}
            controller={controller}
            state={transcript}
            cache={cache}
            native={native}
            run={run}
            openLink={openLink}
            liveState={liveLabel}
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
    <StoredImages
      key={controller.backendId + JSON.stringify(latestState.selected)}
      native={native}
      enabled={
        latestState.ready &&
        !['inactive', 'reconnecting', 'failed'].includes(latestState.transcript.observation)
      }
      fallback={root}
      onReadingSourceChange={setImageSource}>
      {body}
    </StoredImages>
  );
}
type EntryProps = {
  entry: ChatEntry;
  controller: ChatController;
  state: ChatState['transcript'];
  cache: MarkdownCache;
  native?: TranscriptNative;
  run(action: (signal: AbortSignal) => Promise<void>, success: string): void;
  openLink(url: string): void;
  liveState?: string;
  evidence: ActivityEvidence;
};
const Entry = memo(function Entry({
  entry,
  controller,
  state,
  cache,
  native,
  run,
  openLink,
  liveState,
  evidence,
}: EntryProps) {
  const transcript = entry.transcript;
  const manifest =
    transcript && state.manifest && sameSource(transcript, state.manifest) ? state.manifest : null;
  const parts = transcript ? getTranscriptParts(transcript, manifest) : undefined;
  const source = transcript?.source;
  const saved = state.view.anchor;
  const match = state.find.active;
  const matchedPart =
    state.find.revealing && match && source && sameSource({ source }, match)
      ? match.partId
      : undefined;
  const revealPart =
    matchedPart ??
    (saved?.partId &&
    transcript &&
    (saved.source ? transcript.source.kind === 'live' : saved.entryId === entry.id)
      ? saved.partId
      : undefined);
  const [replay, setReplay] = useState({ match, done: false });
  if (replay.match !== match) setReplay({ match, done: false });
  useEffect(() => {
    if (
      !revealPart ||
      !source ||
      parts?.some((part) => part.partId === revealPart) ||
      manifest?.error ||
      manifest?.status === 'loading'
    )
      return;
    const restart =
      !!matchedPart && manifest?.status === 'complete' && manifest.omittedParts > 0 && !replay.done;
    if (!manifest || manifest.nextCursor || restart) {
      void controller.loadTranscriptManifest(source, restart).then(() => {
        if (restart && controller.getSnapshot().transcript.find.active === match)
          setReplay((current) => (current === replay ? { ...current, done: true } : current));
      });
    }
  }, [revealPart, matchedPart, match, source, parts, manifest, controller, replay]);
  const copy = useCallback(() => {
    if (native && source) run((signal) => native.copy({ source }, signal), 'Copied.');
  }, [native, source, run]);
  const loadMoreParts = async () => {
    if (!source) return;
    if (!manifest) {
      await controller.loadTranscriptManifest(source);
      const first = controller.getSnapshot().transcript.manifest;
      if (first?.error || !first?.nextCursor || !sameSource(transcript!, first)) return;
    }
    await controller.loadTranscriptManifest(source);
  };
  let label = entry.toolName ?? entry.role;
  if (entry.role === 'user') label = 'You';
  if (entry.role === 'assistant') label = 'Assistant';
  let body = <p {...stylex.props(styles.literal)}>{entry.text}</p>;
  if (entry.role === 'assistant')
    body = (
      <Markdown
        source={entry.text}
        identity={entry.id}
        revision={entry.text}
        cache={cache}
        openLink={openLink}
      />
    );
  if (parts)
    body = (
      <>
        {groupTranscriptParts(parts).map((group) => {
          const children = group.parts.map((part) => (
            <Part
              key={part.partId}
              transcript={transcript!}
              part={part}
              controller={controller}
              state={state}
              cache={cache}
              native={native}
              run={run}
              openLink={openLink}
              entryId={source?.kind === 'live' ? JSON.stringify(source) : entry.id}
              evidence={evidence}
            />
          ));
          return group.activity ? (
            <Activity
              key={group.parts[0]!.partId}
              transcript={transcript!}
              parts={group.parts}
              state={state}
              controller={controller}
              entryId={source?.kind === 'live' ? JSON.stringify(source) : entry.id}
              evidence={evidence}>
              {children}
            </Activity>
          ) : (
            children
          );
        })}
      </>
    );
  return (
    <article
      data-transcript-entry={liveState ? undefined : entry.id}
      data-transcript-live={liveState ? JSON.stringify(source ?? 'legacy') : undefined}
      aria-label={liveState ? 'Live response' : undefined}
      {...stylex.props(styles.message)}>
      <div {...stylex.props(styles.header)}>
        <strong>{label}</strong>
        <span>{entry.isError ? 'Failed' : liveState}</span>
        {liveState && transcript?.thinking === 'none' && <span>No thinking supplied</span>}
        {liveState && transcript?.thinking === 'pending' && (
          <span>Working · thinking not yet supplied</span>
        )}
        {source && ['assistant', 'user'].includes(entry.role) && (
          <Button
            {...stylex.props(controls.button, controls.quietButton)}
            disabled={
              !native ||
              (source.kind === 'live' &&
                ['reconnecting', 'failed', 'inactive'].includes(state.observation))
            }
            onClick={copy}>
            Copy message
          </Button>
        )}
      </div>
      {body}
      {matchedPart &&
        manifest?.status === 'complete' &&
        (replay.done || !manifest.omittedParts) &&
        !parts?.some((part) => part.partId === matchedPart) && (
          <p role="alert" {...stylex.props(styles.warning)}>
            The saved Find part is unavailable. Refresh Find.
          </p>
        )}
      {!parts && entry.truncated && (
        <p {...stylex.props(styles.small)}>
          Only a preview is available from this host. Upgrade the host to read the complete source.
        </p>
      )}
      {transcript?.thinking === 'redacted' && !parts?.some((part) => part.kind === 'thinking') && (
        <p {...stylex.props(styles.small)}>Thinking is redacted by the provider.</p>
      )}
      {source && (manifest ? manifest.nextCursor : transcript?.nextCursor) && (
        <Button
          {...stylex.props(controls.button)}
          disabled={manifest?.status === 'loading'}
          onClick={() => void loadMoreParts()}>
          Load more parts
        </Button>
      )}
      {manifest?.omittedParts ? (
        <p {...stylex.props(styles.small)}>
          Earlier part descriptions were released from memory.{' '}
          <Button
            {...stylex.props(controls.button)}
            onClick={() => void controller.loadTranscriptManifest(source!, true)}>
            Reload parts
          </Button>
        </p>
      ) : null}
      {manifest?.error && (
        <p role="alert" {...stylex.props(styles.warning)}>
          {manifest.error}{' '}
          <Button
            {...stylex.props(controls.button)}
            onClick={() =>
              void controller.loadTranscriptManifest(source!, manifest.status === 'source-changed')
            }>
            Retry parts
          </Button>
        </p>
      )}
    </article>
  );
});
function useDisclosure(
  entryId: string,
  id: string,
  anchored: boolean,
  state: ChatState['transcript'],
  controller: ChatController,
  partIds: readonly string[],
  source: ChatTranscript['source'],
) {
  const disclosure = useMemo(() => getTranscriptDisclosureId(entryId, id), [entryId, id]);
  const [resolved, setResolved] = useState<{ disclosure: typeof disclosure; value: string } | null>(
    null,
  );
  const [failed, setFailed] = useState<typeof disclosure | null>(null);
  useEffect(() => {
    if (typeof disclosure === 'string') return;
    let active = true;
    void disclosure.then(
      (value) => {
        if (active) setResolved({ disclosure, value });
      },
      () => {
        if (active) setFailed(disclosure);
      },
    );
    return () => {
      active = false;
    };
  }, [disclosure]);
  let expansion: string | null = null;
  if (typeof disclosure === 'string') expansion = disclosure;
  else if (resolved?.disclosure === disclosure) expansion = resolved.value;
  const disclosureError = failed === disclosure;
  const active = state.find.active;
  const match =
    active && sameSource({ source }, active) && partIds.includes(active.partId) ? active : null;
  let anchorKey: string | null = null;
  if (!active && anchored) anchorKey = JSON.stringify({ ...state.view.anchor, offset: 0 });
  if (match) anchorKey = JSON.stringify(match);
  const [collapsedAnchor, setCollapsedAnchor] = useState<string | null>(null);
  const toggleExpanded = useRef<boolean | null>(null);
  if (anchorKey === null && collapsedAnchor !== null) setCollapsedAnchor(null);
  const expanded =
    disclosureError ||
    (expansion !== null && state.view.expanded.includes(expansion)) ||
    (anchorKey !== null && collapsedAnchor !== anchorKey);
  return {
    expanded,
    disclosureError,
    disabled: !expansion,
    toggleProps: {
      onPointerDown: () => {
        toggleExpanded.current = expanded;
      },
      onPointerCancel: () => {
        toggleExpanded.current = null;
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (!event.repeat)
          toggleExpanded.current = [' ', 'Enter'].includes(event.key) ? expanded : null;
      },
      onClick: () => {
        if (!expansion) return;
        const collapse = toggleExpanded.current ?? expanded;
        toggleExpanded.current = null;
        const view = controller.getSnapshot().transcript.view;
        // Reading capture can reveal a child between pointer/key down and click.
        const active = controller.getSnapshot().transcript.find.active;
        const match =
          active && sameSource({ source }, active) && partIds.includes(active.partId)
            ? active
            : null;
        if (collapse && match) setCollapsedAnchor(JSON.stringify(match));
        else if (collapse && !active && view.anchor?.partId && partIds.includes(view.anchor.partId))
          setCollapsedAnchor(JSON.stringify({ ...view.anchor, offset: 0 }));
        controller.setTranscriptView({
          ...view,
          expanded: collapse
            ? view.expanded.filter((id) => id !== expansion)
            : [...view.expanded, expansion],
        });
      },
    },
  };
}
function Activity({
  transcript,
  parts,
  state,
  controller,
  entryId,
  evidence,
  children,
}: {
  transcript: ChatTranscript;
  parts: ChatTranscriptPart[];
  state: ChatState['transcript'];
  controller: ChatController;
  entryId: string;
  evidence: ActivityEvidence;
  children: ReactNode;
}) {
  const saved = state.view.anchor;
  const anchored =
    !!saved?.partId &&
    parts.some((part) => part.partId === saved.partId) &&
    (saved.source ? transcript.source.kind === 'live' : saved.entryId === entryId);
  const disclosure = useDisclosure(
    entryId,
    'activity:' + parts[0]!.partId,
    anchored,
    state,
    controller,
    parts.map((part) => part.partId),
    transcript.source,
  );
  const summaries = [
    ...new Set(
      parts.map((part) => {
        const status = getActivityState(part, transcript, evidence);
        if (part.kind === 'thinking')
          return `Thinking · ${part.availability}${status && status !== 'completed' ? ` · ${status}` : ''}${part.availability === 'available' ? ` · ${part.bytes.toLocaleString()} bytes` : ''}`;
        const progress =
          part.kind === 'result'
            ? ` · ${part.bytes.toLocaleString()} bytes${['running', 'failed', 'interrupted'].includes(status ?? '') && part.text ? ` · ${part.text.replace(/\s+/g, ' ').slice(0, 100)}${part.truncated ? '…' : ''}` : ''}`
            : '';
        return `${getToolSummary(part)}${status ? ` · ${status === 'requested' ? 'requested · result not shown' : status}` : ''}${part.pairing && part.pairing !== 'matched' ? ` · ${part.pairing}` : ''}${progress}`;
      }),
    ),
  ];
  return (
    <section data-transcript-activity {...stylex.props(styles.activity)}>
      <Button
        aria-expanded={disclosure.expanded}
        disabled={disclosure.disabled}
        {...disclosure.toggleProps}
        {...stylex.props(controls.button, controls.quietButton, styles.activityToggle)}>
        Activity · {parts.length} recorded {parts.length === 1 ? 'part' : 'parts'}
      </Button>
      <p {...stylex.props(styles.small, styles.activitySummary)}>{summaries.join(' · ')}</p>
      {disclosure.disclosureError && (
        <p role="alert" {...stylex.props(styles.small)}>
          Could not remember this activity disclosure. Its content is expanded.
        </p>
      )}
      <div hidden={!disclosure.expanded}>{children}</div>
    </section>
  );
}
function Part({
  transcript,
  part,
  controller,
  state,
  cache,
  native,
  run,
  openLink,
  entryId,
  evidence,
}: Omit<EntryProps, 'entry' | 'liveState'> & {
  transcript: ChatTranscript;
  part: ChatTranscriptPart;
  entryId: string;
}) {
  const identity = JSON.stringify([transcript.source, part.partId]);
  const [source, setSource] = useState(transcript.source);
  if (JSON.stringify(source) !== JSON.stringify(transcript.source)) setSource(transcript.source);
  const saved = state.view.anchor;
  const active = state.find.active;
  const match =
    active && sameSource(transcript, active) && active.partId === part.partId ? active : null;
  const anchored =
    (!active || !!match) &&
    saved?.partId === part.partId &&
    (saved.source ? transcript.source.kind === 'live' : saved.entryId === entryId);
  const { expanded, disclosureError, disabled, toggleProps } = useDisclosure(
    entryId,
    part.partId,
    anchored,
    state,
    controller,
    [part.partId],
    transcript.source,
  );
  const content = state.content.find(
    (item) =>
      sameSource(transcript, item) &&
      item.selection.partId === part.partId &&
      item.selection.revision === part.revision &&
      item.selection.bytes === part.bytes,
  );
  const ordinary = part.kind === 'text' && ['user', 'assistant'].includes(part.role);
  const readable =
    part.kind !== 'image' && part.availability === 'available' && part.encoding === 'utf8';
  const load = useCallback(
    (restart = false) => {
      void controller.loadTranscriptPart(
        source,
        { partId: part.partId, bytes: part.bytes, revision: part.revision },
        restart,
      );
    },
    [controller, source, part.partId, part.bytes, part.revision],
  );
  useEffect(() => {
    if (readable && (ordinary || expanded) && part.truncated && !content) load();
  }, [readable, ordinary, expanded, part.truncated, content, load]);
  const base = content?.chunks[0]?.textOffset ?? 0;
  const original = useMemo(() => {
    if (content?.chunks.length) return decodeText(content);
    return part.truncated ? '' : part.text;
  }, [content, part]);
  const matchedText =
    match && match.start >= base ? original.slice(match.start - base, match.end - base) : null;
  const expectedText = match?.snippet.text.slice(
    match.start - match.snippet.start,
    match.end - match.snippet.start,
  );
  const matchVisible = !!match && matchedText === expectedText;
  // Preserve the reading body while Find hydrates; show the source once it contains the match.
  const frozen = !!match && !(matchVisible && base === 0);
  const [reading, setReading] = useState({ revision: part.revision, text: part.text });
  const text = useMemo(() => {
    if (reading.revision !== part.revision) return part.text;
    if (frozen) return reading.text;
    return content?.chunks.length ? original : part.text;
  }, [reading, part, frozen, content, original]);
  if (reading.revision !== part.revision || (!frozen && text !== reading.text))
    setReading({ revision: part.revision, text });
  const complete =
    !part.truncated ||
    (content?.status === 'complete' &&
      content.retainedFrom === 0 &&
      content.loadedBytes === part.bytes &&
      (!match || text.length === content.loadedText));
  useEffect(() => {
    if (
      !match ||
      !state.find.revealing ||
      !readable ||
      (!expanded && !ordinary) ||
      content?.error ||
      content?.status === 'loading'
    )
      return;
    if (match.start < base) load(true);
    else if (!matchVisible && (!content || content.status === 'partial')) load();
  }, [
    match,
    readable,
    expanded,
    ordinary,
    content,
    base,
    matchVisible,
    load,
    state.find.revealing,
  ]);
  const plain = !match && readable && !ordinary && !['patch', 'diff', 'image'].includes(part.kind);
  const currentBody = useMemo(
    () => ({
      source,
      part,
      text,
      complete,
      loaded: !!content?.chunks.length,
      retainedFrom: content?.retainedFrom ?? 0,
      loadedBytes: content?.loadedBytes ?? 0,
    }),
    [
      source,
      part,
      text,
      complete,
      content?.chunks.length,
      content?.retainedFrom,
      content?.loadedBytes,
    ],
  );
  const displayed = usePartBody(
    JSON.stringify([controller.backendId, transcript.source, part.partId]),
    currentBody,
    plain && expanded,
    state.content,
  );
  const takeCopyBody = displayed.takeCopyBody;
  const query = state.find.query,
    revealing = state.find.revealing;
  const findStarts = useMemo(() => {
    const starts = state.find.matches
      .filter((item) => sameSource({ source }, item) && item.partId === part.partId)
      .map((item) => item.start)
      .filter((start) => start !== match?.start);
    return match ? [match.start, ...starts] : starts;
  }, [state.find.matches, source, part.partId, match]);
  const shown = plain ? displayed.body : { text, retainedFrom: content?.retainedFrom ?? 0 };
  const rendered = useRef<HTMLDivElement>(null),
    activeRange = useRef<Range | null>(null),
    mark = useRef<HTMLElement>(null);
  const [unlocated, setUnlocated] = useState<typeof match>(null);
  useLayoutEffect(() => {
    const root = rendered.current;
    if (!root || !findStarts.length) return;
    let clear = () => {};
    const paint = () => {
      clear();
      // Rendered text can be mapped only when it renders the original source from its start.
      const ranges =
        frozen || shown.retainedFrom ? null : locateFindRanges(root, shown.text, query, findStarts);
      const active = (match && ranges?.[0]) || null;
      activeRange.current = active;
      const others = ranges?.slice(match ? 1 : 0).filter((range) => !!range) ?? [];
      const clearMatches = paintFindRanges('find-match', others),
        clearActive = paintFindRanges('find-active', active ? [active] : []);
      clear = () => {
        clearMatches();
        clearActive();
      };
      setUnlocated(match && !active ? match : null);
    };
    paint();
    const observer = new MutationObserver(paint);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      clear();
      activeRange.current = null;
    };
  }, [findStarts, frozen, shown.text, shown.retainedFrom, query, match, expanded]);
  const excerpt = !!match && matchVisible && unlocated === match;
  useLayoutEffect(() => {
    const target = excerpt ? mark.current : activeRange.current;
    if (revealing && target) scrollToReading(target);
  }, [match, revealing, frozen, excerpt, expanded]);
  const copy = useCallback(
    (codeStart?: number) => {
      const body = takeCopyBody();
      if (native)
        run(async (signal) => {
          if (!body) throw Error('The displayed output changed. Try Copy again.');
          await native.copy(
            {
              source: body.source,
              selection: {
                partId: body.part.partId,
                bytes: body.part.bytes,
                revision: body.part.revision,
              },
              ...(codeStart !== undefined ? { code: { start: codeStart } } : {}),
            },
            signal,
          );
        }, 'Copied.');
    },
    [native, run, takeCopyBody],
  );
  let presentation = <p {...stylex.props(styles.small)}>{part.availability} content</p>;
  if (part.kind === 'image') presentation = <StoredImage source={source} part={part} />;
  if (part.kind !== 'image' && !readable && part.availability !== 'redacted' && part.text)
    presentation = (
      <>
        {presentation}
        <pre {...stylex.props(styles.output)}>{part.text}</pre>
      </>
    );
  if (readable) {
    presentation = (
      <pre
        ref={plain ? displayed.root : undefined}
        tabIndex={ordinary ? undefined : 0}
        {...stylex.props(ordinary ? styles.literal : styles.output)}>
        {plain ? displayed.body.text : text}
      </pre>
    );
    if (ordinary && part.role === 'assistant')
      presentation = (
        <Markdown
          source={text}
          identity={identity}
          revision={part.revision}
          cache={cache}
          openLink={openLink}
          copyCode={content?.retainedFrom === 0 || (!content && !part.truncated) ? copy : undefined}
        />
      );
    if (part.kind === 'patch' || part.kind === 'diff')
      presentation = (
        <RecordedPatch text={text} complete={complete} numbered={part.kind === 'diff'} />
      );
  }
  const retainedFrom = plain ? displayed.body.retainedFrom : (content?.retainedFrom ?? 0);
  const body = (
    <>
      <div ref={rendered} {...stylex.props(styles.findable)}>
        {presentation}
      </div>
      {displayed.held && (
        <p role="status" {...stylex.props(styles.small)}>
          Showing previously read output. Copy uses this version; latest progress remains above.
        </p>
      )}
      {part.kind === 'arguments' && (
        <p {...stylex.props(styles.small)}>
          Recorded request. Executed arguments are labelled separately when available; this request
          alone does not prove execution.
        </p>
      )}
      {part.kind === 'arguments' && part.toolName === 'write' && (
        <p {...stylex.props(styles.small)}>
          Captured write content is in the arguments. No before/after diff was recorded here.
        </p>
      )}
      {excerpt && (
        <section aria-label="Matched original source">
          <p {...stylex.props(styles.small)}>Match in original source</p>
          <pre {...stylex.props(styles.literal)}>
            {original
              .slice(Math.max(0, match.start - base - 120), match.start - base)
              .replace(/^[\udc00-\udfff]/, '')}
            <mark ref={mark} data-transcript-find-match {...stylex.props(styles.match)}>
              {matchedText}
            </mark>
            {original
              .slice(match.end - base, match.end - base + 120)
              .replace(/[\ud800-\udbff]$/, '')}
          </pre>
        </section>
      )}
      {match && !matchVisible && (
        <p
          role={content?.status === 'complete' ? 'alert' : 'status'}
          {...stylex.props(styles.small)}>
          {content?.status === 'complete'
            ? 'The saved match differs from this source. Refresh Find.'
            : 'Loading original source through this match…'}
        </p>
      )}
      {part.pairing && part.pairing !== 'matched' && (
        <p {...stylex.props(styles.small)}>Tool result pairing: {part.pairing}.</p>
      )}
      {(!!part.droppedBytes || !!part.droppedLines) && (
        <p {...stylex.props(styles.small)}>
          {(part.droppedBytes ?? 0).toLocaleString()} earlier bytes / {part.droppedLines ?? 0} lines
          were not retained by the tool.
        </p>
      )}
      {!!retainedFrom && (
        <p {...stylex.props(styles.small)}>
          Showing retained content from byte {retainedFrom.toLocaleString()}. Copy still reads the
          complete selected source.{' '}
          <Button {...stylex.props(controls.button)} onClick={() => load(true)}>
            Read from start
          </Button>
        </p>
      )}
      {content?.error && (
        <p role="alert" {...stylex.props(styles.warning)}>
          {content.error}{' '}
          <Button
            {...stylex.props(controls.button)}
            onClick={() => load(content.status === 'source-changed')}>
            Retry content
          </Button>
        </p>
      )}
      {readable &&
        (content?.status === 'loading' ? (
          <p role="status" {...stylex.props(styles.small)}>
            Loading content…
          </p>
        ) : (
          (content?.nextCursor || (!content && part.truncated)) && (
            <Button {...stylex.props(controls.button, controls.quietButton)} onClick={() => load()}>
              Read more · {content?.loadedBytes.toLocaleString() ?? 0} of{' '}
              {part.bytes.toLocaleString()} bytes
            </Button>
          )
        ))}
    </>
  );
  let copyLabel = 'part';
  if (ordinary) copyLabel = 'text';
  else if (part.kind === 'patch' || part.kind === 'diff') copyLabel = part.kind;
  return (
    <section data-transcript-part={part.partId}>
      {disclosureError && (
        <p role="alert" {...stylex.props(styles.small)}>
          Could not remember this disclosure. Its content is expanded.
        </p>
      )}
      {ordinary ? (
        body
      ) : (
        <>
          <Button
            aria-expanded={expanded}
            disabled={disabled}
            {...stylex.props(controls.button, controls.quietButton)}
            {...toggleProps}>
            {part.toolName ? `${getToolSummary(part, text)} · ` : ''}
            {partLabels[part.kind]}
            {getActivityState(part, transcript, evidence)
              ? ` · ${getActivityState(part, transcript, evidence)}`
              : ''}
            {part.availability !== 'available' ? ` · ${part.availability}` : ''}
          </Button>
          {expanded && <div {...stylex.props(styles.disclosure)}>{body}</div>}
        </>
      )}
      {readable && (
        <Button
          {...stylex.props(controls.button, controls.quietButton)}
          disabled={!native}
          {...(plain ? displayed.copyProps : {})}
          onClick={() => copy()}>
          Copy {copyLabel}
        </Button>
      )}
    </section>
  );
}
function getLiveIdentity(state: ChatState) {
  return JSON.stringify(
    state.snapshot?.run?.transcript?.source ?? state.snapshot?.run?.stop ?? null,
  );
}
function scrollToReading(target: Range | HTMLElement) {
  const start = target instanceof Range ? target.startContainer.parentElement : target;
  const scroller = start?.closest<HTMLElement>('[aria-label="Chat transcript"]');
  if (!scroller) return;
  // Move only the transcript and scrolling output inside it; keep the Find field and the reader's
  // selection/focus intact.
  for (let element = start; element && element !== scroller; element = element.parentElement) {
    if (!/auto|scroll/.test(getComputedStyle(element).overflow)) continue;
    const box = element.getBoundingClientRect(),
      rect = target.getBoundingClientRect();
    element.scrollLeft += rect.left - box.left - element.clientWidth / 2;
    element.scrollTop += rect.top - box.top - element.clientHeight / 2;
  }
  scroller.scrollTop += target.getBoundingClientRect().top - getReadingTop(scroller) - 24;
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
    boundary: transcript.atLatest && !!snapshot?.run && transcript.entries.length === 128,
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
function getReadingTop(element: HTMLElement) {
  return Math.max(
    element.getBoundingClientRect().top,
    element.querySelector<HTMLElement>('[data-transcript-chrome]')?.getBoundingClientRect()
      .bottom ?? 0,
  );
}
const partLabels = {
  text: 'Text',
  thinking: 'Thinking',
  arguments: 'Requested arguments',
  'executed-arguments': 'Executed arguments',
  result: 'Output',
  details: 'Details',
  patch: 'Recorded patch',
  diff: 'Recorded diff',
  image: 'Stored image',
  notice: 'Notice',
};
const snapshotLabels = {
  idle: 'Idle',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  uncertain: 'Uncertain',
};
const sameSource = (a: { source: unknown }, b: { source: unknown }) =>
  JSON.stringify(a.source) === JSON.stringify(b.source);
function decodeText(content: TranscriptContentState) {
  return content.chunks.map((chunk) => (chunk.encoding === 'utf8' ? chunk.data : '')).join('');
}
const styles = stylex.create({
  transcript: {
    overflowY: 'auto',
    // Reading anchors sit below the sticky chrome, whose status/notice height changes; native
    // anchoring would hold rows against the scroller top instead, hiding them under the chrome.
    overflowAnchor: 'none',
    flex: 1,
    minHeight: 60,
    padding: '8px 24px',
    minWidth: 0,
  },
  measure: { maxWidth: layout.conversation, margin: '0 auto', minWidth: 0 },
  chrome: { position: 'sticky', top: 0, zIndex: 1, backgroundColor: colors.canvas },
  navigation: { flexWrap: 'wrap', minHeight: 28 },
  feedback: { padding: space.sm, margin: 0 },
  message: { margin: '24px 0', minWidth: 0 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    fontSize: type.small,
    color: colors.secondary,
    flexWrap: 'wrap',
  },
  literal: {
    fontFamily: type.sans,
    fontSize: type.message,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    margin: '8px 0',
  },
  output: {
    fontFamily: type.mono,
    fontSize: type.body,
    lineHeight: 1.6,
    maxHeight: 320,
    overflow: 'auto',
    whiteSpace: 'pre',
    margin: '8px 0',
    padding: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
  },
  match: { backgroundColor: colors.selection, color: colors.text, fontWeight: 700 },
  findable: {
    '::highlight(find-match)': { backgroundColor: colors.selection, color: colors.text },
    '::highlight(find-active)': { backgroundColor: colors.accent, color: colors.onAccent },
  },
  disclosure: { minWidth: 0 },
  activity: { minWidth: 0, margin: '8px 0' },
  activityToggle: { textAlign: 'left', whiteSpace: 'normal' },
  activitySummary: { margin: '0 0 8px', paddingInline: space.sm },
  small: {
    color: colors.secondary,
    fontSize: type.small,
    lineHeight: 1.6,
    overflowWrap: 'anywhere',
  },
  warning: {
    backgroundColor: colors.warningSurface,
    color: colors.warningText,
    padding: space.md,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.warningBorder,
    borderRadius: radius.control,
    overflowWrap: 'anywhere',
  },
});
