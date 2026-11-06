import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button } from '@base-ui/react/button';
import { Collapsible } from '@base-ui/react/collapsible';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import type {
  ChatController,
  TranscriptContentState,
  TranscriptManifestState,
} from '@moonbase/application/chat';
import type {
  ChatEntry,
  ChatTranscriptMatch,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import type { TranscriptNative } from '../../chat/wire.ts';
import { Markdown } from './markdown.tsx';
import type { MarkdownCache } from './markdown-model.ts';
import {
  describeActivityPart,
  getActivityState,
  getToolSummary,
  groupTranscriptParts,
  type ActivityEvidence,
} from './activity.ts';
import { RecordedPatch } from './recorded-patch.tsx';
import { StoredImage } from './stored-image.tsx';
import { getTranscriptParts } from './transcript-parts.ts';
import { usePartBody } from './part-body.ts';
import { usePartContent } from './part-content.ts';
import { FindExcerpt, useFindHighlight, useFindHydration } from './part-find.tsx';
import { RowExpansionContext, useDisclosure } from './transcript-disclosure.ts';
import type { TranscriptActions } from './transcript-actions.ts';
import { compareProps } from './stable-props.ts';
import { transcriptStyles as styles } from './transcript-styles.ts';
import { Icon } from '../icon.tsx';

/**
 * A row's slice of transcript state. The transcript passes each row only what concerns it, in
 * values that keep their identity while unchanged, so rows skip unrelated updates.
 */
export type EntryProps = {
  entry: ChatEntry;
  /** Set for the live row: its status label. */
  liveState?: string;
  controller: ChatController;
  cache: MarkdownCache;
  native?: TranscriptNative;
  actions: TranscriptActions;
  evidence: ActivityEvidence;
  /** The loaded manifest, when it describes this row's source. */
  manifest: TranscriptManifestState | null;
  /** The active Find match, when it is in this row. */
  findMatch: ChatTranscriptMatch | null;
  findRevealing: boolean;
  findQuery: string;
  /** Find matches in this row's source. */
  findMatches: readonly ChatTranscriptMatch[];
  /** Loaded content of this row's source. */
  contents: readonly TranscriptContentState[];
  expandedIds: readonly string[];
  /** The live source can't be read now. */
  offline: boolean;
};
type PartContext = Pick<
  EntryProps,
  | 'controller'
  | 'cache'
  | 'native'
  | 'actions'
  | 'evidence'
  | 'findRevealing'
  | 'findQuery'
  | 'findMatches'
  | 'contents'
  | 'expandedIds'
>;

export const Entry = memo(
  function Entry({
    entry,
    liveState,
    controller,
    cache,
    manifest,
    findMatch,
    findRevealing,
    offline,
    ...context
  }: EntryProps) {
    const { native, actions } = context;
    const transcript = entry.transcript;
    // Live snapshots carry a fresh source object each update; parts memoize on its identity.
    const sourceKey = transcript && JSON.stringify(transcript.source);
    const source = useMemo<ChatTranscriptSource | undefined>(
      () => (sourceKey ? JSON.parse(sourceKey) : undefined),
      [sourceKey],
    );
    const parts = useMemo(
      () => (transcript ? getTranscriptParts(transcript, manifest) : []),
      [transcript, manifest],
    );
    const matchedPart = findRevealing && findMatch ? findMatch.partId : undefined;
    const [replay, setReplay] = useState({ match: findMatch, done: false });
    if (replay.match !== findMatch) setReplay({ match: findMatch, done: false });
    useEffect(() => {
      if (
        !matchedPart ||
        !source ||
        parts.some((part) => part.partId === matchedPart) ||
        manifest?.error ||
        manifest?.status === 'loading'
      )
        return;
      const restart = manifest?.status === 'complete' && manifest.omittedParts > 0 && !replay.done;
      if (!manifest || manifest.nextCursor || restart) {
        void controller.loadTranscriptManifest(source, restart).then(() => {
          if (restart && controller.getSnapshot().transcript.find.active === findMatch)
            setReplay((current) => (current === replay ? { ...current, done: true } : current));
        });
      }
    }, [matchedPart, findMatch, source, parts, manifest, controller, replay]);
    const copy = useCallback(() => {
      if (native && source) actions.run((signal) => native.copy({ source }, signal), 'copy');
    }, [native, source, actions]);
    const loadMoreParts = async () => {
      if (!source) return;
      if (!manifest) {
        await controller.loadTranscriptManifest(source);
        const first = controller.getSnapshot().transcript.manifest;
        if (first?.error || !first?.nextCursor || !areJsonValuesEqual(first.source, source)) return;
      }
      await controller.loadTranscriptManifest(source);
    };
    // Your bubbles and the agent's plain replies need no names; other roles keep theirs.
    const conversational = ['assistant', 'user'].includes(entry.role);
    const label = conversational ? '' : (entry.toolName ?? entry.role);
    const notes = [
      label,
      entry.isError ? 'Failed' : liveState,
      liveState && transcript?.thinking === 'none' && 'No thinking supplied',
      liveState && transcript?.thinking === 'pending' && 'Working · thinking not yet supplied',
    ].filter(Boolean);
    const user = entry.role === 'user';
    let body = <p {...stylex.props(styles.literal)}>{entry.text}</p>;
    if (entry.role === 'assistant')
      body = (
        <Markdown
          source={entry.text || (liveState ? 'Working…' : '')}
          identity={entry.id}
          revision=""
          cache={cache}
          openLink={actions.openLink}
        />
      );
    const entryId = source?.kind === 'live' ? JSON.stringify(source) : entry.id;
    if (transcript && source)
      body = (
        <>
          {groupTranscriptParts(parts).map((group) => {
            const children = group.parts.map((part) => (
              <Part
                key={part.partId}
                source={source}
                part={part}
                entryId={entryId}
                controller={controller}
                cache={cache}
                match={findMatch?.partId === part.partId ? findMatch : null}
                findRevealing={findRevealing}
                {...context}
              />
            ));
            const partIds = group.parts.map((part) => part.partId);
            return group.activity ? (
              <Activity
                key={group.parts[0]!.partId}
                source={source}
                parts={group.parts}
                entryId={entryId}
                controller={controller}
                evidence={context.evidence}
                expandedIds={context.expandedIds}
                match={findMatch && partIds.includes(findMatch.partId) ? findMatch : null}
                revealing={findRevealing}>
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
        {...stylex.props(stylex.defaultMarker(), styles.message, user && styles.userMessage)}>
        {notes.length > 0 && (
          <div {...stylex.props(styles.header)}>
            {label && <span {...stylex.props(styles.role)}>{label}</span>}
            {notes.slice(label ? 1 : 0).map((note) => (
              <span key={String(note)}>{note}</span>
            ))}
          </div>
        )}
        {user ? <div {...stylex.props(styles.bubble)}>{body}</div> : body}
        {source && conversational && (
          <div {...stylex.props(styles.messageActions)}>
            <Button
              aria-label="Copy message"
              title="Copy message"
              {...stylex.props(controls.button, controls.iconButton, styles.revealed)}
              disabled={!native || (source.kind === 'live' && offline)}
              onClick={copy}>
              <Icon name="copy" />
            </Button>
          </div>
        )}
        {matchedPart &&
          manifest?.status === 'complete' &&
          (replay.done || !manifest.omittedParts) &&
          !parts.some((part) => part.partId === matchedPart) && (
            <p role="alert" {...stylex.props(styles.warning)}>
              The saved Find part is unavailable. Refresh results.
            </p>
          )}
        {!transcript && entry.truncated && (
          <p {...stylex.props(styles.small)}>
            Only a preview is available from this host. Upgrade the host to read the complete
            source.
          </p>
        )}
        {transcript?.thinking === 'redacted' && !parts.some((part) => part.kind === 'thinking') && (
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
                void controller.loadTranscriptManifest(
                  source!,
                  manifest.status === 'source-changed',
                )
              }>
              Retry parts
            </Button>
          </p>
        )}
      </article>
    );
  },
  compareProps<EntryProps>({ lists: ['contents', 'findMatches', 'expandedIds'] }),
);

/** Consecutive activity parts fold together; each part's state stays visible while folded. */
function Activity({
  source,
  parts,
  entryId,
  controller,
  evidence,
  expandedIds,
  match,
  revealing,
  children,
}: {
  source: ChatTranscriptSource;
  parts: readonly ChatTranscriptPart[];
  entryId: string;
  controller: ChatController;
  evidence: ActivityEvidence;
  expandedIds: readonly string[];
  match: ChatTranscriptMatch | null;
  revealing: boolean;
  children: ReactNode;
}) {
  const disclosure = useDisclosure({
    entryId,
    id: 'activity:' + parts[0]!.partId,
    partIds: parts.map((part) => part.partId),
    source,
    expandedIds,
    match,
    revealing,
    controller,
  });
  // One step per distinct description, marked by its state like a task list.
  const steps = new Map<string, string | undefined>();
  for (const part of parts) {
    const summary = describeActivityPart(part, { source }, evidence);
    if (!steps.has(summary)) steps.set(summary, getActivityState(part, { source }, evidence));
  }
  return (
    <Collapsible.Root
      open={disclosure.open}
      onOpenChange={disclosure.onOpenChange}
      disabled={disclosure.disabled}
      render={<section data-transcript-activity />}
      {...stylex.props(styles.activity)}>
      <Collapsible.Trigger
        {...stylex.props(controls.button, controls.quietButton, styles.activityToggle)}>
        Activity · {parts.length} recorded {parts.length === 1 ? 'part' : 'parts'}
      </Collapsible.Trigger>
      <ul {...stylex.props(styles.activitySteps)}>
        {[...steps].map(([summary, state]) => {
          const split = summary.indexOf(' · ');
          return (
            <li
              key={summary}
              data-glyph={(state && stepGlyphs[state]) ?? '·'}
              {...stylex.props(styles.activityStep, stepStyles[state ?? 'unknown'])}>
              <span {...stylex.props(styles.activityTool)}>
                {split < 0 ? summary : summary.slice(0, split)}
              </span>
              {split < 0 ? '' : summary.slice(split)}
            </li>
          );
        })}
      </ul>
      {disclosure.disclosureError && (
        <p role="alert" {...stylex.props(styles.small)}>
          Could not remember this activity disclosure. Its content is expanded.
        </p>
      )}
      {/* Kept mounted so Find can hydrate folded parts. */}
      <Collapsible.Panel keepMounted>{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

type PartProps = PartContext & {
  source: ChatTranscriptSource;
  part: ChatTranscriptPart;
  entryId: string;
  /** The active Find match, when it is in this part. */
  match: ChatTranscriptMatch | null;
};
const Part = memo(
  function Part({
    source,
    part,
    entryId,
    match,
    controller,
    cache,
    native,
    actions,
    evidence,
    findRevealing: revealing,
    findQuery: query,
    findMatches,
    contents,
    expandedIds,
  }: PartProps) {
    const identity = JSON.stringify([source, part.partId]);
    const disclosure = useDisclosure({
      entryId,
      id: part.partId,
      partIds: [part.partId],
      source,
      expandedIds,
      match,
      revealing,
      controller,
    });
    const expanded = disclosure.open;
    /** Code blocks remember their unfolding with this part's other disclosures. */
    const expansions = useMemo(
      () => ({ entryId, partId: part.partId, expandedIds, controller }),
      [entryId, part.partId, expandedIds, controller],
    );
    const ordinary = part.kind === 'text' && ['user', 'assistant'].includes(part.role);
    const readable =
      part.kind !== 'image' && part.availability === 'available' && part.encoding === 'utf8';
    const { content, load, base, original } = usePartContent({
      controller,
      source,
      part,
      contents,
      wanted: readable && (ordinary || expanded),
    });
    const { text, frozen, matchVisible, matchedText, complete } = useFindHydration({
      part,
      match,
      revealing,
      content,
      base,
      original,
      readable,
      shown: expanded || ordinary,
      load,
    });
    const plain =
      !match && readable && !ordinary && !['patch', 'diff', 'image'].includes(part.kind);
    // Folded code and other patch pages reveal the active match once its source is shown.
    const findStart = match && matchVisible && !frozen ? match.start : null,
      findEnd = match?.end ?? 0;
    const findTarget = useMemo(
      () => (findStart === null ? null : { start: findStart, end: findEnd }),
      [findStart, findEnd],
    );
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
      JSON.stringify([controller.backendId, source, part.partId]),
      currentBody,
      plain && expanded,
      contents,
    );
    const shown = plain ? displayed.body : { text, retainedFrom: content?.retainedFrom ?? 0 };
    const rendered = useRef<HTMLDivElement>(null);
    const { excerpt, mark } = useFindHighlight({
      rendered,
      match,
      matches: findMatches,
      partId: part.partId,
      query,
      revealing,
      frozen,
      matchVisible,
      shown,
      expanded,
    });
    // Copy reads the latest displayed body through a stable callback, so streaming text does not
    // re-render every Markdown block for a new Copy code identity.
    const takeCopyBody = useRef(displayed.takeCopyBody);
    useLayoutEffect(() => {
      takeCopyBody.current = displayed.takeCopyBody;
    }, [displayed.takeCopyBody]);
    const copy = useCallback(
      (codeStart?: number) => {
        const body = takeCopyBody.current();
        if (native)
          actions.run(async (signal) => {
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
          }, 'copy');
      },
      [native, actions],
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
          <RowExpansionContext.Provider value={expansions}>
            <Markdown
              source={text}
              identity={identity}
              revision={part.revision}
              cache={cache}
              openLink={actions.openLink}
              copyCode={
                content?.retainedFrom === 0 || (!content && !part.truncated) ? copy : undefined
              }
              findTarget={findTarget}
            />
          </RowExpansionContext.Provider>
        );
      if (part.kind === 'patch' || part.kind === 'diff')
        presentation = (
          <RecordedPatch
            text={text}
            complete={complete}
            numbered={part.kind === 'diff'}
            findStart={findStart}
          />
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
            Recorded request. Executed arguments are labelled separately when available; this
            request alone does not prove execution.
          </p>
        )}
        {part.kind === 'arguments' && part.toolName === 'write' && (
          <p {...stylex.props(styles.small)}>
            Captured write content is in the arguments. No before/after diff was recorded here.
          </p>
        )}
        {excerpt && match && (
          <FindExcerpt
            original={original}
            base={base}
            match={match}
            matchedText={matchedText}
            mark={mark}
          />
        )}
        {match && !matchVisible && (
          <p
            role={content?.status === 'complete' ? 'alert' : 'status'}
            {...stylex.props(styles.small)}>
            {content?.status === 'complete'
              ? 'The saved match differs from this source. Refresh results.'
              : 'Loading original source through this match…'}
          </p>
        )}
        {part.pairing && part.pairing !== 'matched' && (
          <p {...stylex.props(styles.small)}>Tool result pairing: {part.pairing}.</p>
        )}
        {(!!part.droppedBytes || !!part.droppedLines) && (
          <p {...stylex.props(styles.small)}>
            {(part.droppedBytes ?? 0).toLocaleString()} earlier bytes / {part.droppedLines ?? 0}{' '}
            lines were not retained by the tool.
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
              <Button
                {...stylex.props(controls.button, controls.quietButton)}
                onClick={() => load()}>
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
    // Your bubble copies through Copy message; only the agent's text keeps a part copy.
    const copyButton = readable && !(ordinary && part.role === 'user') && (
      <Button
        {...stylex.props(controls.button, controls.quietButton, ordinary && styles.revealed)}
        disabled={!native}
        {...(plain ? displayed.copyProps : {})}
        onClick={() => copy()}>
        Copy {copyLabel}
      </Button>
    );
    if (ordinary)
      return (
        <section data-transcript-part={part.partId}>
          {body}
          {copyButton}
        </section>
      );
    const status = getActivityState(part, { source }, evidence);
    return (
      <Collapsible.Root
        open={expanded}
        onOpenChange={disclosure.onOpenChange}
        disabled={disclosure.disabled}
        render={<section data-transcript-part={part.partId} />}>
        {disclosure.disclosureError && (
          <p role="alert" {...stylex.props(styles.small)}>
            Could not remember this disclosure. Its content is expanded.
          </p>
        )}
        <Collapsible.Trigger {...stylex.props(controls.button, controls.quietButton)}>
          {part.toolName ? `${getToolSummary(part, text)} · ` : ''}
          {partLabels[part.kind]}
          {status ? ` · ${status}` : ''}
          {part.availability !== 'available' ? ` · ${part.availability}` : ''}
        </Collapsible.Trigger>
        <Collapsible.Panel {...stylex.props(styles.disclosure)}>{body}</Collapsible.Panel>
        {copyButton}
      </Collapsible.Root>
    );
  },
  compareProps<PartProps>({ lists: ['contents', 'findMatches', 'expandedIds'], records: ['part'] }),
);

const stepGlyphs: Record<string, string> = {
  completed: '✓',
  running: '⠹',
  requested: '○',
  failed: '✕',
  interrupted: '✕',
  'missing-result': '?',
};
const stepStyles: Record<string, stylex.StyleXStyles> = {
  running: styles.stepRunning,
  failed: styles.stepFailed,
  interrupted: styles.stepFailed,
  'missing-result': styles.stepFailed,
  requested: styles.stepPending,
  unknown: styles.stepPending,
};

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
