import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import * as stylex from '@stylexjs/stylex';
import { controls } from '@moonbase/ui/controls';
import { overlays } from '@moonbase/ui/overlays';
import { colors, radius, space, syntax, type } from '@moonbase/ui/tokens.stylex';
import { maximumChatMentions, type ChatMention } from '@moonbase/contracts/chat';
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
import {
  filterCommands,
  filterOptions,
  findCommandQuery,
  removeCommandLine,
  type ChatCommand,
  type ChatCommandOption,
} from './commands.ts';
import { Icon } from '../icon.tsx';

/**
 * The message textarea. Typing `@` searches the chat's working folder on its host; a picked file is
 * inserted as a mention, highlighted like a chip and carried with the draft. Typing `/` at the start
 * lists the composer's commands, and a command's choices once its name is typed.
 */
export function MessageInput({
  controller,
  draft,
  mentions,
  searchable,
  cwd,
  placeholder,
  starter,
  commands,
  onCommand,
  onMention,
  refuseMention,
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
  commands: readonly ChatCommand[];
  onCommand(command: ChatCommand, option?: ChatCommandOption): void;
  /** Told of each file picked, once the draft mentions it. */
  onMention?(path: string): void;
  /** Why a file can't be picked, if it can't; the picker shows it and leaves the draft alone. */
  refuseMention?(path: string): string | null;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null),
    mirror = useRef<HTMLDivElement>(null),
    caretAfter = useRef<{ text: string; caret: number } | null>(null);
  // The caret belongs to the text it was read from; a draft replaced from outside (another chat's,
  // a sent message's) has no caret until the user places one.
  const [selection, setSelection] = useState({ text: draft, caret: 0 }),
    [active, setActive] = useState(0),
    [dismissed, setDismissed] = useState<string | null>(null),
    [search, setSearch] = useState<ChatFileSearch | null>(null),
    // The query (`queryKey`) the search last started; its answer belongs to no other.
    [searched, setSearched] = useState<string | null>(null),
    // Why the query (`queryKey`) couldn't pick a file, shown while it is typed.
    [refusal, setRefusal] = useState<{ key: string; message: string } | null>(null);
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
  const caret = selection.text === draft ? selection.caret : null;
  const typedCommand = caret === null ? null : findCommandQuery(draft, caret, commands);
  const commandKey =
    typedCommand && (typedCommand.kind === 'command' ? '/' : `/${typedCommand.command.name} `);
  const commandQuery = commandKey !== dismissed ? typedCommand : null;
  const typed =
    !typedCommand && searchable && caret !== null ? findMentionQuery(draft, caret, mentions) : null;
  const query: MentionQuery | null = typed && `@${typed.start}` !== dismissed ? typed : null;
  const queryKey = query && JSON.stringify([query.start, query.query, cwd]);
  const commandRows =
    commandQuery?.kind === 'command' ? filterCommands(commands, commandQuery.query) : [];
  const optionRows =
    commandQuery?.kind === 'option'
      ? filterOptions(commandQuery.command.options ?? [], commandQuery.query)
      : [];
  const commandText = commandQuery && JSON.stringify([commandKey, commandQuery.query]);
  useEffect(() => {
    if (!search) return;
    if (queryKey) {
      const [, text, folder] = JSON.parse(queryKey) as [number, string, string | undefined];
      search.search(text, folder ?? undefined);
    } else search.clear();
    // oxlint-disable-next-line react/set-state-in-effect -- A new query starts at its first match.
    setActive(0);
    setSearched(queryKey);
  }, [search, queryKey, commandText]);
  useEffect(() => {
    // Restores the caret after a programmatic edit, once React has rendered the edited text.
    const restored = caretAfter.current;
    caretAfter.current = null;
    if (restored?.text === draft)
      textarea.current?.setSelectionRange(restored.caret, restored.caret);
  }, [draft]);
  const fileOpen = !!query && (results.matches.length > 0 || !!results.error || results.busy);
  const matches = query ? results.matches : [];
  // Earlier matches stay listed while a newer search runs, but only the current query's are picked.
  const fresh = !!query && searched === queryKey && !results.busy && results.query === query.query;
  const full = mentions.length >= maximumChatMentions;
  const commandOpen =
    commandQuery?.kind === 'option' || (commandQuery?.kind === 'command' && !!commandRows.length);
  const open = fileOpen || commandOpen;
  const count = commandQuery ? commandRows.length || optionRows.length : matches.length;
  const pickerKey = commandKey ?? (query ? `@${query.start}` : null);
  const optionId = (index: number) => `${id}-option-${index}`;
  function edit(text: string, next: ChatMention[] | undefined, at: number) {
    setSelection({ text, caret: at });
    // Unchanged text renders nothing new, so its caret moves now rather than after the render.
    if (text === draft) textarea.current?.setSelectionRange(at, at);
    else caretAfter.current = { text, caret: at };
    controller.setDraft(text, next);
  }
  function pickActive() {
    const index = Math.min(active, count - 1);
    if (commandRows.length) pickCommand(commandRows[index]!);
    else if (optionRows.length && commandQuery?.kind === 'option')
      onCommand(commandQuery.command, optionRows[index]!);
    else pick(matches[index]!.path);
  }
  function pickCommand(command: ChatCommand) {
    if (!command.options) return onCommand(command);
    // A command with choices lists them next, as its argument.
    const rest = removeCommandLine(draft),
      head = `/${command.name} `;
    edit(draft.includes('\n') ? `${head}\n${rest}` : head, undefined, head.length);
  }
  function pick(path: string) {
    if (!query || !fresh || (full && !mentions.some((mention) => mention.path === path))) return;
    const refused = refuseMention?.(path);
    if (refused) return setRefusal({ key: queryKey!, message: refused });
    const inserted = insertMention(draft, query, selection.caret, path);
    edit(
      inserted.text,
      [...mentions.filter((mention) => mention.path !== path), { path }],
      inserted.caret,
    );
    onMention?.(path);
  }
  let status = refusal?.key === queryKey ? refusal.message : results.error;
  if (!status && full) status = `A message can mention at most ${maximumChatMentions} files.`;
  else if (!status && !matches.length && results.busy) status = 'Searching files…';
  else if (!status && !results.busy && results.partial)
    status = 'More files match; keep typing to narrow.';
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
        aria-autocomplete="list"
        aria-controls={open ? `${id}-picker` : undefined}
        aria-activedescendant={open && count ? optionId(active) : undefined}
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
          const element = event.currentTarget;
          setSelection({ text: element.value, caret: element.selectionStart });
          setDismissed(null);
          controller.setDraft(element.value);
        }}
        onSelect={(event) =>
          setSelection({
            text: event.currentTarget.value,
            caret: event.currentTarget.selectionStart,
          })
        }
        onScroll={(event) => {
          if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onBlur={() => setDismissed(pickerKey)}
        onFocus={() => setDismissed(null)}
        onKeyDown={(event) => {
          // Keys that compose text with an input method belong to it, not to the picker or Send.
          if (event.nativeEvent.isComposing) return;
          const element = event.currentTarget;
          // Enter sends and Shift+Enter adds a line; an open picker takes plain Enter.
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            (event.metaKey || event.ctrlKey || !(open && count))
          ) {
            event.preventDefault();
            if (draft.trim()) element.form?.requestSubmit();
            return;
          }
          if (open && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(pickerKey);
            return;
          }
          if (open && count) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((active + step + count) % count);
              return;
            }
            if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
              event.preventDefault();
              pickActive();
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
      {commandOpen && commandQuery && (
        <div {...stylex.props(overlays.popup, styles.picker, starter && styles.pickerBelow)}>
          <div
            id={`${id}-picker`}
            role="listbox"
            aria-label={
              commandQuery.kind === 'option'
                ? (commandQuery.command.optionsLabel ?? 'Options')
                : 'Commands'
            }
            {...stylex.props(styles.files)}>
            {commandRows.map((command, index) => (
              <div
                key={command.name}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                {...stylex.props(styles.file, index === active && styles.activeFile)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pickCommand(command)}>
                <span {...stylex.props(styles.fileName, styles.commandName)}>/{command.name}</span>
                <span {...stylex.props(styles.fileFolder, controls.truncate)}>
                  {command.description}
                </span>
              </div>
            ))}
            {commandQuery.kind === 'option' &&
              optionRows.map((option, index) => (
                <div
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  {...stylex.props(styles.file, index === active && styles.activeFile)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => onCommand(commandQuery.command, option)}>
                  <span {...stylex.props(styles.fileName, controls.truncate)}>{option.label}</span>
                  {option.current && (
                    <span {...stylex.props(styles.fileFolder, styles.current)}>Current</span>
                  )}
                </div>
              ))}
          </div>
          {commandQuery.kind === 'option' && !optionRows.length && (
            <p role="status" {...stylex.props(styles.status)}>
              Nothing matches “{commandQuery.query.trim()}”.
            </p>
          )}
        </div>
      )}
      {fileOpen && (
        <div {...stylex.props(overlays.popup, styles.picker, starter && styles.pickerBelow)}>
          <div
            id={`${id}-picker`}
            role="listbox"
            aria-label="Files"
            {...stylex.props(styles.files)}>
            {matches.map((match, index) => {
              const slash = match.path.lastIndexOf('/');
              return (
                <div
                  key={match.path}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  aria-disabled={!fresh || undefined}
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
          {status && (
            <p role="status" {...stylex.props(styles.status)}>
              {status}
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
  commandName: { fontFamily: type.mono, minWidth: 72 },
  current: { marginLeft: 'auto', flexShrink: 0 },
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
