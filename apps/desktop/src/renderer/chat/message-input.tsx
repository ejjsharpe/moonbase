import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';
import { colors, radius, space, syntax, type } from '@moonbase/ui/tokens.stylex';
import type { ChatMention } from '@moonbase/contracts/chat';
import type {
  ChatController,
  ChatFileSearch,
  ChatFileSearchSnapshot,
} from '@moonbase/application/chat';
import {
  findMentionQuery,
  findMentionRanges,
  insertMention,
  removeMentionBefore,
  type MentionQuery,
} from './mention-text.ts';
import { Icon } from '../icon.tsx';

/**
 * The message textarea. Typing `@` searches the chat's working folder on its host; a picked file is
 * inserted as a mention, highlighted like a chip and carried with the draft.
 */
export function MessageInput({
  controller,
  draft,
  mentions,
  searchable,
  cwd,
  placeholder,
  starter,
}: {
  controller: ChatController;
  draft: string;
  mentions: ChatMention[];
  /** Whether `@` can search: the host supports it and the chat has a working folder. */
  searchable: boolean;
  /** A new local chat's chosen folder; an open chat or a remote host uses its own. */
  cwd?: string;
  placeholder: string;
  starter: boolean;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null),
    mirror = useRef<HTMLDivElement>(null),
    caretAfter = useRef<number | null>(null);
  const [caret, setCaret] = useState(0),
    [active, setActive] = useState(0),
    [dismissed, setDismissed] = useState<number | null>(null),
    [search, setSearch] = useState<ChatFileSearch | null>(null);
  const id = useId();
  useEffect(() => {
    const acquired = controller.createFileSearch();
    // oxlint-disable-next-line react/set-state-in-effect -- React owns this picker's attachment; the search owns its async work.
    setSearch(acquired);
    return () => acquired.dispose();
  }, [controller]);
  const results = useSyncExternalStore(
    search?.subscribe ?? noSubscription,
    search?.getSnapshot ?? noResults,
  );
  const typed = searchable ? findMentionQuery(draft, caret, mentions) : null;
  const query: MentionQuery | null = typed && typed.start !== dismissed ? typed : null;
  const queryKey = query && JSON.stringify([query.start, query.query, cwd]);
  useEffect(() => {
    if (!search) return;
    if (queryKey) {
      const [, text, folder] = JSON.parse(queryKey) as [number, string, string | undefined];
      search.search(text, folder ?? undefined);
    } else search.clear();
    // oxlint-disable-next-line react/set-state-in-effect -- A new query starts at its first match.
    setActive(0);
  }, [search, queryKey]);
  useEffect(() => {
    // Restores the caret after a programmatic edit, once React has rendered the new text.
    if (caretAfter.current === null || !textarea.current) return;
    textarea.current.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [draft]);
  const open = !!query && (results.matches.length > 0 || !!results.error || results.busy);
  const matches = query ? results.matches : [];
  const optionId = (index: number) => `${id}-file-${index}`;
  function edit(text: string, next: ChatMention[] | undefined, at: number) {
    caretAfter.current = at;
    setCaret(at);
    controller.setDraft(text, next);
  }
  function pick(path: string) {
    if (!query) return;
    const inserted = insertMention(draft, query, caret, path);
    edit(
      inserted.text,
      [...mentions.filter((mention) => mention.path !== path), { path }],
      inserted.caret,
    );
  }
  const ranges = findMentionRanges(draft, mentions);
  const segments: { text: string; mention: boolean }[] = [];
  let at = 0;
  for (const range of ranges) {
    segments.push({ text: draft.slice(at, range.start), mention: false });
    segments.push({ text: draft.slice(range.start, range.end), mention: true });
    at = range.end;
  }
  segments.push({ text: draft.slice(at) + '\n', mention: false });
  return (
    <div {...stylex.props(styles.field)}>
      <div
        ref={mirror}
        aria-hidden="true"
        {...stylex.props(styles.text, styles.mirror, starter && styles.starterText)}>
        {segments.map((segment, index) =>
          segment.mention ? (
            <mark key={index} {...stylex.props(styles.mention)}>
              {segment.text}
            </mark>
          ) : (
            segment.text
          ),
        )}
      </div>
      <label htmlFor="message" {...stylex.props(controls.hidden)}>
        Message
      </label>
      <textarea
        ref={textarea}
        id="message"
        aria-autocomplete={searchable ? 'list' : undefined}
        aria-controls={open ? `${id}-files` : undefined}
        aria-activedescendant={open && matches.length ? optionId(active) : undefined}
        {...stylex.props(
          controls.field,
          styles.text,
          styles.textarea,
          starter && styles.starterText,
          starter && styles.starterTextarea,
        )}
        placeholder={placeholder}
        value={draft}
        onChange={(event) => {
          setCaret(event.currentTarget.selectionStart);
          setDismissed(null);
          controller.setDraft(event.currentTarget.value);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onScroll={(event) => {
          if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onBlur={() => setDismissed(query?.start ?? null)}
        onFocus={() => setDismissed(null)}
        onKeyDown={(event) => {
          const element = event.currentTarget;
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            element.form?.requestSubmit();
            return;
          }
          if (open && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(query.start);
            return;
          }
          if (open && matches.length) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((active + step + matches.length) % matches.length);
              return;
            }
            if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
              event.preventDefault();
              pick(matches[Math.min(active, matches.length - 1)]!.path);
              return;
            }
          }
          if (
            event.key === 'Backspace' &&
            element.selectionStart === element.selectionEnd &&
            !event.metaKey &&
            !event.altKey
          ) {
            const removed = removeMentionBefore(draft, element.selectionStart, mentions);
            if (removed) {
              event.preventDefault();
              edit(removed.text, undefined, removed.caret);
            }
          }
        }}
      />
      {open && (
        <div {...stylex.props(overlays.popup, styles.picker, starter && styles.pickerBelow)}>
          <div id={`${id}-files`} role="listbox" aria-label="Files" {...stylex.props(styles.files)}>
            {matches.map((match, index) => {
              const slash = match.path.lastIndexOf('/');
              return (
                <div
                  key={match.path}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  title={match.path}
                  {...stylex.props(styles.file, index === active && styles.activeFile)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(match.path)}>
                  <Icon name="file" />
                  <span {...stylex.props(styles.fileName, controls.truncate)}>
                    <Highlighted
                      text={match.path.slice(slash + 1)}
                      offset={slash + 1}
                      positions={match.positions}
                    />
                  </span>
                  {slash > 0 && (
                    <span {...stylex.props(styles.fileFolder, controls.truncate)}>
                      <Highlighted
                        text={match.path.slice(0, slash)}
                        offset={0}
                        positions={match.positions}
                      />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {(results.error ||
            (!results.busy && results.partial) ||
            (!matches.length && results.busy)) && (
            <p role="status" {...stylex.props(styles.status)}>
              {results.error ??
                (results.busy ? 'Searching files…' : 'More files match; keep typing to narrow.')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
function Highlighted({
  text,
  offset,
  positions,
}: {
  text: string;
  offset: number;
  positions: number[];
}) {
  const marked = new Set(positions.map((position) => position - offset));
  const parts: { text: string; marked: boolean }[] = [];
  for (let n = 0; n < text.length; n++) {
    const last = parts.at(-1);
    if (last && last.marked === marked.has(n)) last.text += text[n];
    else parts.push({ text: text[n]!, marked: marked.has(n) });
  }
  return parts.map((part, index) =>
    part.marked ? (
      <b key={index} {...stylex.props(styles.matched)}>
        {part.text}
      </b>
    ) : (
      part.text
    ),
  );
}
const noSubscription = () => () => {};
const emptyResults: ChatFileSearchSnapshot = {
  query: null,
  matches: [],
  partial: false,
  busy: false,
  error: null,
};
const noResults = () => emptyResults;
const styles = stylex.create({
  field: { position: 'relative', flex: 1, minWidth: 0, display: 'flex' },
  // The mirror and the textarea share every metric, so highlights sit under the typed mentions.
  text: {
    fontFamily: type.ui,
    fontSize: type.message,
    lineHeight: 1.6,
    letterSpacing: 'normal',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    padding: 0,
    margin: 0,
  },
  starterText: { fontSize: 14 },
  mirror: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    color: 'transparent',
    pointerEvents: 'none',
    scrollbarGutter: 'stable',
  },
  textarea: {
    position: 'relative',
    width: '100%',
    resize: 'none',
    minHeight: 48,
    maxHeight: '25vh',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    scrollbarGutter: 'stable',
    ':focus-visible': { outline: 'none' },
  },
  starterTextarea: { minHeight: 90 },
  // A mention reads as a reference: the selection surface with a faint keyword-hue ring.
  mention: {
    color: 'transparent',
    backgroundColor: colors.selection,
    borderRadius: radius.control,
    boxShadow: `0 0 0 1px ${syntax.keyword}66`,
  },
  picker: {
    position: 'absolute',
    left: -8,
    bottom: 'calc(100% + 10px)',
    zIndex: 20,
    width: 'min(440px, calc(100vw - 32px))',
    boxShadow: '0 12px 32px #0008',
  },
  // The centred new-chat composer has room below it, and its heading above.
  pickerBelow: { bottom: 'auto', top: 'calc(100% + 10px)' },
  files: { maxHeight: 'min(280px, 40vh)', overflowY: 'auto', padding: space.xs },
  file: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    minWidth: 0,
    padding: '6px 8px',
    borderRadius: radius.row,
    cursor: 'default',
    color: colors.secondary,
    fontSize: type.small,
  },
  activeFile: { backgroundColor: colors.hover, color: colors.text },
  fileName: { flexShrink: 0, maxWidth: '60%', color: colors.text },
  fileFolder: { minWidth: 0, color: colors.muted },
  matched: { fontWeight: 700, color: colors.link },
  status: {
    margin: 0,
    padding: '6px 12px 8px',
    color: colors.muted,
    fontSize: type.caption,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
  },
});
