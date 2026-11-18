import { memo, useEffect, useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Effect, SubscriptionRef } from 'effect';
import { useAtomValue } from '@effect/atom-react';
import { colors, space, type } from '@moonbase/ui/tokens.stylex';
import {
  getTranscriptParts,
  getTranscriptSourceKey,
  type LiveEntry,
} from '@moonbase/application/chat';
import type { ChatTranscriptPart } from '@moonbase/contracts/chat';
import { Markdown } from '../markdown/markdown.tsx';
import {
  classifyEntry,
  findAnsweredThoughts,
  groupTranscriptParts,
  isEmptyThought,
} from '../activity/activity.ts';
import { Activity } from '../activity/activity-card.tsx';
import { Part } from '../part/part.tsx';
import { useTranscript } from '../transcript-context.ts';
import { textStyles } from '../transcript-text.ts';
import { MessageActions } from './message-actions.tsx';
import { PartsStatus } from './parts-status.tsx';

/**
 * One row's entry: a stored entry, or the live response, which has no transcript while its task
 * completes. It reads its own source's state, so it re-renders only when that or its props change.
 */
export const Entry = memo(function Entry({
  entry,
  live = false,
  liveLabel,
  joinPrevious = false,
  joinNext = false,
}: {
  entry: LiveEntry;
  /** Set for the live row. */
  live?: boolean;
  /** The live row's status, when it is something other than running. */
  liveLabel?: string;
  /** An activity row continues the run of activity rows above or below it. */
  joinPrevious?: boolean;
  joinNext?: boolean;
}) {
  const { view, act, selection, native, actions, cache } = useTranscript();
  const transcript = entry.transcript;
  // The application keeps an unchanged source's identity, so parts memoize on it.
  const source = transcript?.source;
  const row = useAtomValue(view.rows.row(getTranscriptSourceKey(source)));
  const { manifest, findMatch, findRevealing } = row;
  const parts = useMemo(
    () => (transcript ? getTranscriptParts(transcript, manifest) : []),
    [transcript, manifest],
  );
  // A thought gives way to the text that answers it, and an empty one never shows; a Find match
  // keeps its part shown.
  const shownParts = useMemo(() => {
    const answered = findAnsweredThoughts(parts);
    return parts.filter(
      (part) =>
        part.partId === findMatch?.partId || !(isEmptyThought(part) || answered.has(part.partId)),
    );
  }, [parts, findMatch?.partId]);
  const partGroups = useMemo(() => groupTranscriptParts(shownParts), [shownParts]);
  const matchedPart = findRevealing && findMatch ? findMatch.partId : undefined;
  // A revealed match whose part isn't loaded reads the manifest for it, restarting once when its
  // early descriptions were released; `done` once that restart read for this match.
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
    if (manifest && !manifest.nextCursor && !restart) return;
    void act(
      Effect.gen(function* () {
        yield* selection.loadTranscriptManifest(source, restart);
        const { find } = (yield* SubscriptionRef.get(selection.state)).transcript;
        if (restart && find.active === findMatch)
          setReplay((current) => (current === replay ? { ...current, done: true } : current));
      }),
    );
  }, [matchedPart, findMatch, source, parts, manifest, act, selection, replay]);
  const copy = () => {
    if (native && source) actions.run((signal) => native.copy({ source }, signal), 'copy');
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
  let body = <p {...stylex.props(textStyles.literal)}>{entry.text}</p>;
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
        {partGroups.map((group) => {
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
                row={row}
                match={findMatch?.partId === part.partId ? findMatch : null}
                activityOpen={activityOpen}
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
              expanded={row.expanded}
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
  const liveKey = source ? JSON.stringify(source) : '';
  const messageActions = source && conversational && (
    <MessageActions
      createdAt={entry.createdAt}
      user={user}
      disabled={!native || (source.kind === 'live' && row.offline)}
      onCopy={copy}
    />
  );
  return (
    <article
      data-transcript-entry={live ? undefined : entry.id}
      data-transcript-live={live ? liveKey : undefined}
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
      {/* Your time and Copy sit under your bubble; the agent's sit under its reply. */}
      {user ? <div {...stylex.props(styles.bubble)}>{body}</div> : body}
      {messageActions}
      <PartsStatus
        source={source}
        transcript={transcript}
        manifest={manifest}
        parts={parts}
        missingMatch={
          !!matchedPart &&
          manifest?.status === 'complete' &&
          (replay.done || !manifest.omittedParts) &&
          !parts.some((part) => part.partId === matchedPart)
        }
      />
    </article>
  );
});

const styles = stylex.create({
  /** Rows are spaced by the list; a row has no outer margin. */
  message: { margin: 0, minWidth: 0 },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 28,
    fontSize: type.small,
    color: colors.secondary,
    flexWrap: 'wrap',
  },
  /** Only roles other than you and the agent are named, such as a standalone tool entry. */
  role: { fontFamily: type.mono, fontWeight: 700, color: colors.text },
  /** Your messages sit on the right in bubbles; the agent's replies keep the full width. */
  userMessage: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
  bubble: {
    maxWidth: '82%',
    minWidth: 0,
    paddingBlock: space.sm,
    paddingInline: 14,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.border,
    borderRadius: '14px 14px 4px 14px',
  },
});
