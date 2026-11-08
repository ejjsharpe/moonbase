import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Button } from '@base-ui/react/button';
import { Collapsible } from '@base-ui/react/collapsible';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { spinner } from '@moonbase/ui/spinner';
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
  classifyEntry,
  describeActivityStep,
  describeActivityHeadline,
  getActivityState,
  getActivityStepState,
  summarizeActivityHeadlines,
  type ActivityHeadline,
  getToolSummary,
  groupActivitySteps,
  groupTranscriptParts,
  type ActivityEvidence,
  type ActivityStep,
} from './activity.ts';
import { RecordedPatch } from './recorded-patch.tsx';
import { StoredImage } from './stored-image.tsx';
import { getTranscriptParts } from './transcript-parts.ts';
import { usePartBody } from './part-body.ts';
import { usePartContent } from './part-content.ts';
import { FindExcerpt, useFindHighlight, useFindHydration } from './part-find.tsx';
import { OpenCallsContext, RowExpansionContext, useDisclosure } from './transcript-disclosure.ts';
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
  /** Set for the live row. */
  live?: boolean;
  /** The live row's status, when it is something other than running. */
  liveLabel?: string;
  /** An activity row continues the activity card above or below it. */
  joinPrevious?: boolean;
  joinNext?: boolean;
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
    live = false,
    liveLabel,
    joinPrevious = false,
    joinNext = false,
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
    // Messages and tool steps need no names; only a system record with content keeps its own.
    const kind = classifyEntry(entry);
    const conversational = kind === 'message' && ['assistant', 'user'].includes(entry.role);
    const label = entry.role === 'system' && kind !== 'empty' ? 'system' : '';
    // A failed tool step shows its failure on the step, not as a line between steps.
    let status = entry.isError ? 'Failed' : liveLabel;
    if (kind === 'activity' && !live) status = undefined;
    const notes = [label, status].filter(Boolean);
    const user = entry.role === 'user';
    let body = <p {...stylex.props(styles.literal)}>{entry.text}</p>;
    if (entry.role === 'assistant')
      body = (
        <Markdown
          source={entry.text || (live ? 'Working…' : '')}
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
            const renderParts = (
              activityOpen?: boolean,
              shown: readonly ChatTranscriptPart[] = group.parts,
            ) =>
              shown.map((part) => (
                <Part
                  key={part.partId}
                  source={source}
                  part={part}
                  entryId={entryId}
                  controller={controller}
                  cache={cache}
                  match={findMatch?.partId === part.partId ? findMatch : null}
                  findRevealing={findRevealing}
                  activityOpen={activityOpen}
                  {...context}
                />
              ));
            const partIds = group.parts.map((part) => part.partId);
            return group.activity ? (
              <Activity
                key={group.parts[0]!.partId}
                joinPrevious={joinPrevious}
                joinNext={joinNext}
                source={source}
                parts={group.parts}
                entryId={entryId}
                controller={controller}
                evidence={context.evidence}
                expandedIds={context.expandedIds}
                match={findMatch && partIds.includes(findMatch.partId) ? findMatch : null}
                revealing={findRevealing}>
                {renderParts}
              </Activity>
            ) : (
              renderParts()
            );
          })}
        </>
      );
    // An empty turn marker keeps its row (Find and reading positions key on it) but shows nothing.
    if (kind === 'empty' && !live && !findMatch)
      return <article data-transcript-entry={entry.id} {...stylex.props(styles.message)} />;
    return (
      <article
        data-transcript-entry={live ? undefined : entry.id}
        data-transcript-live={live ? JSON.stringify(source ?? 'legacy') : undefined}
        aria-label={live ? 'Live response' : undefined}
        {...stylex.props(stylex.defaultMarker(), styles.message, user && styles.userMessage)}>
        {notes.length > 0 && (
          <div {...stylex.props(styles.header)}>
            {label && <span {...stylex.props(styles.role)}>{label}</span>}
            {notes.slice(label ? 1 : 0).map((note) => (
              <span key={String(note)}>{note}</span>
            ))}
          </div>
        )}
        {(() => {
          const actions = source && conversational && (
            <div {...stylex.props(styles.messageActions, user && styles.userActions)}>
              {entry.createdAt && (
                <time
                  dateTime={entry.createdAt}
                  title={new Date(entry.createdAt).toLocaleString()}
                  {...stylex.props(styles.messageTime, styles.revealed)}>
                  {formatMessageTime(entry.createdAt)}
                </time>
              )}
              <Button
                aria-label="Copy message"
                title="Copy message"
                {...stylex.props(controls.button, controls.iconButton, styles.revealed)}
                disabled={!native || (source.kind === 'live' && offline)}
                onClick={copy}>
                <Icon name="copy" />
              </Button>
            </div>
          );
          // Your time and Copy sit beside the bubble; the agent's sit under its reply.
          // Time and Copy sit under the message: right-aligned under your bubble, as in T1.
          return user ? (
            <>
              <div {...stylex.props(styles.bubble)}>{body}</div>
              {actions}
            </>
          ) : (
            <>
              {body}
              {actions}
            </>
          );
        })()}
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

/** Consecutive activity parts read as a list of steps, each opening to its own recorded parts. */
function Activity({
  joinPrevious,
  joinNext,
  source,
  parts,
  children,
  ...context
}: StepContext & {
  joinPrevious: boolean;
  joinNext: boolean;
  parts: readonly ChatTranscriptPart[];
}) {
  const steps = groupActivitySteps(parts, source.kind === 'entry' ? source.entryId : undefined);
  // An output row has no line of its own: it continues its call's step above it.
  const outputOnly = steps.every(isOutputStep);
  return (
    <section
      data-transcript-activity=""
      {...stylex.props(
        styles.activity,
        joinPrevious && styles.activityJoinPrevious,
        joinNext && styles.activityJoinNext,
        outputOnly && styles.activityOutput,
      )}>
      {steps.map((step) => (
        <ActivityStepView key={step.lead.partId} step={step} source={source} {...context}>
          {children}
        </ActivityStepView>
      ))}
    </section>
  );
}

type StepContext = {
  source: ChatTranscriptSource;
  entryId: string;
  controller: ChatController;
  evidence: ActivityEvidence;
  expandedIds: readonly string[];
  match: ChatTranscriptMatch | null;
  revealing: boolean;
  /** The given parts, whether or not their step is open. */
  children: (open: boolean, parts: readonly ChatTranscriptPart[]) => ReactNode;
};

/** A step whose lead answers a call recorded in another row: the call's output, shown with it. */
const isOutputStep = (step: ActivityStep) =>
  !!step.lead.call && step.lead.pairing === 'matched' && step.lead.kind !== 'arguments';

/**
 * One step: a line saying what it did, which opens to the parts behind it. A call's output in a
 * later row opens and closes with the call.
 */
function ActivityStepView({
  step,
  source,
  entryId,
  controller,
  evidence,
  expandedIds,
  match,
  revealing,
  children,
}: StepContext & { step: ActivityStep }) {
  const parts = [step.lead, ...step.answers];
  const partIds = parts.map((part) => part.partId);
  const disclosure = useDisclosure({
    entryId,
    id: 'activity:' + step.lead.partId,
    partIds,
    source,
    expandedIds,
    match: match && partIds.includes(match.partId) ? match : null,
    revealing,
    controller,
  });
  const output = isOutputStep(step);
  const followKey = output ? `${step.lead.call!.entryId}\n${step.lead.call!.partId}` : '';
  const publishKey =
    step.lead.kind === 'arguments' && source.kind === 'entry'
      ? `${source.entryId}\n${step.lead.partId}`
      : '';
  const openCalls = useContext(OpenCallsContext);
  const following = useSyncExternalStore(
    openCalls?.subscribe ?? noSubscription,
    () => !!followKey && !!openCalls?.isOpen([followKey]),
  );
  useEffect(() => {
    if (!openCalls || !publishKey) return;
    openCalls.set([publishKey], disclosure.open);
  }, [openCalls, publishKey, disclosure.open]);
  const open = disclosure.open || following;
  const state = output ? undefined : getActivityStepState(step, { source }, evidence);
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={disclosure.onOpenChange}
      disabled={disclosure.disabled}
      render={<div data-transcript-step="" />}>
      {/* An output step draws no line; its opener stays for the keyboard, for when its call's
          row is not loaded. */}
      {output && (
        <Collapsible.Trigger
          aria-label={`Activity · ${parts.length} recorded ${parts.length === 1 ? 'part' : 'parts'}`}
          {...stylex.props(controls.button, controls.iconButton, controls.hidden)}>
          <Icon name="chevron" />
        </Collapsible.Trigger>
      )}
      {!output && (
        <div
          title={describeActivityStep(step, { source }, evidence)}
          data-glyph={(state && stepGlyphs[state]) ?? '·'}
          // The whole line opens the step, as its chevron does.
          onClick={(event) => {
            if ((event.target as Element).closest('button')) return;
            if (!window.getSelection()?.toString()) disclosure.onOpenChange();
          }}
          {...stylex.props(
            styles.activitySteps,
            styles.activityStep,
            stepStyles[state ?? 'unknown'],
            state === 'running' && spinner.glyph,
          )}>
          <ActivityHeadlineText headline={describeActivityHeadline(step, { source }, evidence)} />
          <Collapsible.Trigger
            aria-label={`Activity · ${parts.length} recorded ${parts.length === 1 ? 'part' : 'parts'}`}
            title="Show recorded parts"
            {...stylex.props(controls.button, controls.iconButton, styles.activityToggle)}>
            <Icon name="chevron" />
          </Collapsible.Trigger>
        </div>
      )}
      {disclosure.disclosureError && (
        <p role="alert" {...stylex.props(styles.small)}>
          Could not remember this activity disclosure. Its content is expanded.
        </p>
      )}
      {/* Kept mounted so Find can hydrate folded parts. */}
      <Collapsible.Panel keepMounted {...stylex.props(open && styles.activityPanel)}>
        {children(open, parts)}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

const noSubscription = () => () => {};

/** A step's verb phrase, then what it touched, quieter, then any trouble. */
function ActivityHeadlineText({ headline }: { headline: ActivityHeadline }) {
  return (
    <>
      <span {...stylex.props(styles.activityTool)}>{headline.action}</span>
      {headline.detail && <span {...stylex.props(styles.activityDetail)}> {headline.detail}</span>}
      {headline.problem && (
        <span {...stylex.props(styles.activityProblem)}> · {headline.problem}</span>
      )}
    </>
  );
}

/**
 * A run of tool rows folded behind one line, as T3 Code does it: "Worked for 1m 29s", a chevron, the
 * clock time at the far end, and a rule under it. While it works it reads "Working for 14s", and the
 * line under the rule says what it is doing now or the thought it is on.
 */
export function ActivityGroupLine({
  headlines,
  states,
  active,
  current,
  startedAt,
  endedAt,
  open,
  onToggle,
}: {
  headlines: readonly ActivityHeadline[];
  states: readonly (string | undefined)[];
  active: boolean;
  /** What the work is on now: the latest message's thought, else its latest step. */
  current?: ActivityHeadline;
  /** When the work began: the end of whatever the transcript recorded before it. */
  startedAt?: string;
  /** When its last step was recorded; a running group counts up to now instead. */
  endedAt?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const now = useNow(active && !!startedAt);
  const until = active ? now : Date.parse(endedAt ?? '');
  const elapsed = startedAt ? until - Date.parse(startedAt) : NaN;
  const duration = Number.isFinite(elapsed) && elapsed >= 0 ? formatDuration(elapsed) : null;
  const failed = states.filter((state) =>
    ['failed', 'interrupted', 'missing-result'].includes(state ?? ''),
  ).length;
  const summary = summarizeActivityHeadlines(headlines);
  let label = duration ? `Worked for ${duration}` : summary;
  if (active) label = duration ? `Working for ${duration}` : 'Working…';
  return (
    <>
      <div {...stylex.props(styles.activityFold)}>
        <button
          type="button"
          aria-expanded={open}
          data-transcript-activity-group=""
          title={failed ? `${summary} · ${failed} failed` : summary}
          onClick={onToggle}
          {...stylex.props(controls.button, controls.quietButton, styles.activityFoldButton)}>
          <span>
            {label}
            {!active && failed > 0 && (
              <span {...stylex.props(styles.activityProblem)}> · {failed} failed</span>
            )}
          </span>
          <span aria-hidden="true" {...stylex.props(styles.activityFoldChevron)}>
            <Icon name="chevron" />
          </span>
        </button>
        {!active && endedAt && (
          <time
            dateTime={endedAt}
            title={new Date(endedAt).toLocaleString()}
            {...stylex.props(styles.activityFoldTime, styles.revealed)}>
            {formatMessageTime(endedAt)}
          </time>
        )}
      </div>
      {active && !open && current && (
        <div
          data-glyph={stepGlyphs.running}
          {...stylex.props(
            styles.activitySteps,
            styles.activityStep,
            stepStyles.running,
            spinner.glyph,
          )}>
          <span {...stylex.props(styles.activityTool)}>{current.action}</span>
          {/* A command reads in full ("Running npm test"); a file is named by its action. */}
          {current.category === 'command' && current.detail && (
            <span {...stylex.props(styles.activityTool)}> {current.detail}</span>
          )}
        </div>
      )}
    </>
  );
}

type PartProps = PartContext & {
  source: ChatTranscriptSource;
  part: ChatTranscriptPart;
  entryId: string;
  /** The active Find match, when it is in this part. */
  match: ChatTranscriptMatch | null;
  /** Set inside an activity card: the part shows whenever the card is open, with no fold of its own. */
  activityOpen?: boolean;
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
    activityOpen,
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
    const grouped = activityOpen !== undefined;
    const expanded = grouped ? activityOpen : disclosure.open;
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
    if (part.kind === 'patch' || part.kind === 'diff') copyLabel = part.kind;
    // Messages copy through their row's Copy message; only folded output keeps a part copy.
    const copyButton = readable && !ordinary && (
      <Button
        aria-label={`Copy ${copyLabel}`}
        title={`Copy ${copyLabel}`}
        {...stylex.props(controls.button, controls.iconButton)}
        disabled={!native}
        {...(plain ? displayed.copyProps : {})}
        onClick={() => copy()}>
        <Icon name="copy" />
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
    const partLabel =
      // Inside a step the step's line already names the tool and what it touched.
      (part.toolName && !grouped ? `${getToolSummary(part, text)} · ` : '') +
      partLabels[part.kind] +
      (status && status !== 'completed'
        ? ` · ${status === 'missing-result' ? 'no result' : status}`
        : '') +
      (part.availability !== 'available' ? ` · ${part.availability}` : '');
    // Inside an open card a part simply shows: its label, copy, then content.
    if (grouped)
      return (
        <section data-transcript-part={part.partId}>
          <div {...stylex.props(styles.partHeader)}>
            <span {...stylex.props(styles.partLabel)}>{partLabel}</span>
            {copyButton}
          </div>
          {expanded && <div {...stylex.props(styles.disclosure)}>{body}</div>}
        </section>
      );
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
        {/* A recorded part: what it is, then its content and copy. A completed state goes unsaid. */}
        <div {...stylex.props(styles.partHeader)}>
          <Collapsible.Trigger
            {...stylex.props(
              stylex.defaultMarker(),
              controls.button,
              controls.quietButton,
              styles.partToggle,
            )}>
            <span aria-hidden="true" {...stylex.props(styles.partChevron)}>
              <Icon name="chevron" />
            </span>
            {partLabel}
          </Collapsible.Trigger>
          {copyButton}
        </div>
        <Collapsible.Panel {...stylex.props(styles.disclosure)}>{body}</Collapsible.Panel>
      </Collapsible.Root>
    );
  },
  compareProps<PartProps>({ lists: ['contents', 'findMatches', 'expandedIds'], records: ['part'] }),
);

/** The current time, ticking each second while enabled. */
function useNow(enabled: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** "12s", "4m 05s", "1h 02m". */
function formatDuration(ms: number) {
  const seconds = Math.floor(ms / 1000),
    minutes = Math.floor(seconds / 60),
    hours = Math.floor(minutes / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  if (hours) return `${hours}h ${pad(minutes % 60)}m`;
  if (minutes) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${seconds}s`;
}

/** Today's messages show their time; older ones add the date. */
function formatMessageTime(iso: string) {
  const at = new Date(iso),
    time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === new Date().toDateString()) return time;
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

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
  arguments: 'Arguments',
  'executed-arguments': 'Arguments as run',
  result: 'Output',
  details: 'Details',
  patch: 'Patch',
  diff: 'Diff',
  image: 'Stored image',
  notice: 'Notice',
};
