import { Effect } from 'effect';
import { memo, useMemo, useRef, type MouseEvent } from 'react';
import { Button } from '@base-ui/react/button';
import { Collapsible } from '@base-ui/react/collapsible';
import * as stylex from '@stylexjs/stylex';
import { useAtomValue } from '@effect/atom-react';
import { controls } from '@moonbase/ui/controls';
import { Icon } from '@moonbase/ui/icons';
import { colors, radius, space, type } from '@moonbase/ui/tokens.stylex';
import * as Atom from 'effect/reactivity/Atom';
import type { ResultsByCall, TranscriptRowState } from '@moonbase/application/chat';
import type {
  ChatTranscriptMatch,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { Markdown } from '../markdown/markdown.tsx';
import { describeActivityState, getActivityState, getToolSummary } from '../activity/activity.ts';
import { useDisclosure } from '../disclosure/disclosure.ts';
import { RowExpansionContext } from '../disclosure/remembered-fold.ts';
import { StoredImage } from '../stored-image.tsx';
import { useTranscript } from '../transcript-context.ts';
import { Note } from '../transcript-note.tsx';
import { textStyles } from '../transcript-text.ts';
import { usePartBody } from './part-body.ts';
import { usePartContent } from './part-content.ts';
import { FindExcerpt, useFindHighlight, useFindHydration } from './part-find.tsx';
import { PartNotes } from './part-notes.tsx';
import { RecordedPatch } from './recorded-patch.tsx';

const noResults = Atom.make<ResultsByCall>(new Map());
/** Pixels a scrolling output grows before it scrolls. */
const outputMaxHeight = 320;

/**
 * One recorded part of a row: a message's text, or a tool's arguments, output, patch or image,
 * folded behind its label unless it is inside a step, which opens it.
 */
export const Part = memo(function Part({
  source,
  part,
  entryId,
  row,
  match,
  activityOpen,
}: {
  source: ChatTranscriptSource;
  part: ChatTranscriptPart;
  entryId: string;
  /** The row's own state. */
  row: TranscriptRowState;
  /** The active Find match, when it is in this part. */
  match: ChatTranscriptMatch | null;
  /** Set inside a step: the part shows whenever the step is open, with no fold of its own. */
  activityOpen?: boolean;
}) {
  const { view, backendId, cache, native, actions } = useTranscript();
  const { findRevealing: revealing, findQuery: query, findMatches, contents, expanded } = row;
  const identity = JSON.stringify([source, part.partId]);
  const disclosure = useDisclosure({ entryId, id: part.partId, expanded, match, revealing });
  const grouped = activityOpen !== undefined;
  const open = grouped ? activityOpen : disclosure.open;
  /** Code blocks remember their unfolding with this part's other disclosures. */
  const expansions = useMemo(
    () => ({ entryId, partId: part.partId, expanded }),
    [entryId, part.partId, expanded],
  );
  const ordinary = part.kind === 'text' && ['user', 'assistant'].includes(part.role);
  const readable =
    part.kind !== 'image' && part.availability === 'available' && part.encoding === 'utf8';
  const { content, load, base, original } = usePartContent({
    source,
    part,
    contents,
    wanted: readable && (ordinary || open),
  });
  const { text, frozen, matchVisible, matchedText, complete } = useFindHydration({
    part,
    match,
    revealing,
    content,
    base,
    original,
    readable,
    shown: open || ordinary,
    holdsGrowth: ordinary,
    findHandOff:
      source.kind === 'entry' ? () => cache.findLiveSource(part.text, part.bytes) : undefined,
    load,
  });
  const plain = !match && readable && !ordinary && !['patch', 'diff', 'image'].includes(part.kind);
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
    JSON.stringify([backendId, source, part.partId]),
    currentBody,
    plain && open,
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
    expanded: open,
  });
  /** Copies the displayed body (as it was when Copy was pressed), or one of its code blocks. */
  const copy = (codeStart?: number) => {
    const body = displayed.takeCopyBody();
    if (native)
      actions.run(
        body
          ? native.copy({
              source: body.source,
              selection: {
                partId: body.part.partId,
                bytes: body.part.bytes,
                revision: body.part.revision,
              },
              ...(codeStart !== undefined ? { code: { start: codeStart } } : {}),
            })
          : Effect.fail(Error('The displayed output changed. Try Copy again.')),
        'copy',
      );
  };
  // A code block's Copy carries its offset; the part handles it, so the message's blocks never
  // re-render for a new Copy as its text streams.
  const copyCode = (event: MouseEvent) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-copy-code]');
    if (button && !button.matches(':disabled')) copy(Number(button.dataset.copyCode));
  };
  // Only a tool part's label reads its call's results.
  const results = useAtomValue(ordinary ? noResults : view.rows.resultsByCall);
  let presentation = <Note>{part.availability} content</Note>;
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
        {...stylex.props(ordinary ? textStyles.literal : styles.output)}>
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
            copyCode={content?.retainedFrom === 0 || (!content && !part.truncated)}
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
  const body = (
    <>
      <div ref={rendered} onClick={copyCode} {...stylex.props(styles.findable)}>
        {presentation}
      </div>
      <PartNotes
        part={part}
        content={content}
        readable={readable}
        held={displayed.held}
        retainedFrom={plain ? displayed.body.retainedFrom : (content?.retainedFrom ?? 0)}
        excerpt={
          excerpt &&
          match && (
            <FindExcerpt
              original={original}
              base={base}
              match={match}
              matchedText={matchedText}
              mark={mark}
            />
          )
        }
        matchDiffers={!!match && !matchVisible && content?.status === 'complete'}
        load={load}
      />
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
  const status = getActivityState(part, { source }, results);
  const partLabel =
    // Inside a step the step's line already names the tool and what it touched.
    (part.toolName && !grouped ? `${getToolSummary(part, text)} · ` : '') +
    partLabels[part.kind] +
    (status && status !== 'completed' ? ` · ${describeActivityState(status) ?? status}` : '') +
    (part.availability !== 'available' ? ` · ${part.availability}` : '');
  // Inside an open step a part simply shows: its label, copy, then content.
  if (grouped)
    return (
      <section data-transcript-part={part.partId}>
        <div {...stylex.props(styles.header)}>
          <span {...stylex.props(styles.label)}>{partLabel}</span>
          {copyButton}
        </div>
        {open && <div {...stylex.props(styles.disclosure)}>{body}</div>}
      </section>
    );
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={disclosure.onOpenChange}
      disabled={disclosure.disabled}
      render={<section data-transcript-part={part.partId} />}>
      {disclosure.disclosureError && (
        <Note role="alert">Could not remember this disclosure. Its content is expanded.</Note>
      )}
      {/* A recorded part: what it is, then its content and copy. A completed state goes unsaid. */}
      <div {...stylex.props(styles.header)}>
        <Collapsible.Trigger
          {...stylex.props(
            stylex.defaultMarker(),
            controls.button,
            controls.quietButton,
            styles.toggle,
          )}>
          <span aria-hidden="true" {...stylex.props(styles.chevron)}>
            <Icon name="chevron" />
          </span>
          {partLabel}
        </Collapsible.Trigger>
        {copyButton}
      </div>
      <Collapsible.Panel {...stylex.props(styles.disclosure)}>{body}</Collapsible.Panel>
    </Collapsible.Root>
  );
});

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

const styles = stylex.create({
  output: {
    fontFamily: type.mono,
    fontSize: type.body,
    lineHeight: 1.6,
    maxHeight: outputMaxHeight,
    overflow: 'auto',
    whiteSpace: 'pre',
    marginBlock: space.sm,
    marginInline: 0,
    padding: space.md,
    backgroundColor: colors.surface,
    borderRadius: radius.panel,
  },
  findable: {
    '::highlight(find-match)': { backgroundColor: colors.selection, color: colors.text },
    '::highlight(find-active)': { backgroundColor: colors.accent, color: colors.onAccent },
  },
  disclosure: { minWidth: 0, paddingInline: 10 },
  /** An opened step's recorded parts: a quiet label that folds, with copy on the right. */
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    minWidth: 0,
    paddingInline: '14px 6px',
  },
  toggle: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'flex-start',
    gap: 6,
    color: colors.muted,
    fontSize: type.caption,
    textAlign: 'left',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  label: {
    flex: 1,
    minWidth: 0,
    paddingBlock: 4,
    color: colors.muted,
    fontSize: type.caption,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  chevron: {
    display: 'inline-flex',
    flexShrink: 0,
    transform: {
      default: 'rotate(-90deg)',
      [stylex.when.ancestor('[data-panel-open]')]: 'none',
    },
  },
});
