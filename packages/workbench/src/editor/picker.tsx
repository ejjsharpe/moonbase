import * as stylex from '@stylexjs/stylex';
import { Dialog } from '@base-ui/react/dialog';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CheckoutTarget, FileTarget, TextMatch } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  fileKey,
  type EditorController,
  type EditorLookup,
  type EditorTextSearch,
  type LookupSnapshot,
  type TextSearchOptions,
  type TextSearchSnapshot,
} from '@moonbase/application/editor';
import { controls } from '@moonbase/ui/controls';
import { checkoutName, projectHue, projectInitials, projectTiles } from '@moonbase/ui/projects';
import { colors, radius, shadow, space, type } from '@moonbase/ui/tokens.stylex';
import { workbench } from '@moonbase/ui/workbench';
import { Icon } from './icon.tsx';

/** Something besides a file that Go to can jump to, supplied by the workbench or its app. */
export type PickerEntry = {
  id: string;
  kind: 'chat' | 'project' | 'command';
  label: string;
  detail?: string;
  shortcut?: string;
  /** Chats listed under Recent before anything is typed. */
  recent?: boolean;
  /** A project's tile identity: every checkout of one repository shares its hue. */
  projectId?: string;
  run: () => void;
};
/** `commands` is Go to with `>` already typed. */
export type PickerMode = 'goto' | 'commands' | 'find';
export type PickerRequest = { mode: PickerMode; text: string };

/** Chromium reports MacIntel on Apple silicon too. */
const mac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac');
/** The picker's modifier: ⌘ on a Mac, where ⌃P moves up a line in text, and Ctrl elsewhere. */
export const pickerCommand = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  mac ? event.metaKey : event.ctrlKey;
/** ⌘P is Go to, ⌘⇧P its commands and ⌘⇧F Find; `command` says which modifier counts. */
export function pickerMode(
  event: { key: string; shiftKey: boolean; altKey: boolean },
  command: boolean,
): PickerMode | undefined {
  if (!command || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'p') return event.shiftKey ? 'commands' : 'goto';
  if (key === 'f' && event.shiftKey) return 'find';
}
/** Opens a file, at a line when Find picked a match; resolves false when it was not opened. */
export type PickerOpenFile = (
  target: FileTarget,
  at: { line: number; column: number; length: number } | undefined,
  current: () => boolean,
) => Promise<boolean>;

type Matched = { positions: number[]; score: number };
type GoToRow = {
  key: string;
  group: string;
  kind: 'file' | 'chat' | 'project' | 'command';
  label: string;
  positions: number[];
  detail?: string;
  shortcut?: string;
  projectId?: string;
  activate: () => void;
};

const rowIcons = { file: 'file', chat: 'agents', command: 'chevronRight' } as const;
const emptyLookup: LookupSnapshot = { rows: [], message: '', busy: false };
const emptySearch: TextSearchSnapshot = { files: [], message: '', busy: false };
const noSubscription = () => () => {};
const matchKey = (path: string, match: TextMatch) => path + ':' + match.line;

/** Case-insensitive: a contiguous run scores above letters scattered through the label. */
export function matchLabel(label: string, query: string): Matched | null {
  const text = label.toLowerCase(),
    wanted = query.trim().toLowerCase();
  if (!wanted) return { positions: [], score: 0 };
  const at = text.indexOf(wanted);
  if (at >= 0) {
    const boundary = at === 0 || /[^a-z0-9]/.test(text[at - 1]);
    return {
      positions: Array.from({ length: wanted.length }, (_, i) => at + i),
      score: 1000 + (boundary ? 200 : 0) - at,
    };
  }
  const letters = wanted.replace(/\s+/g, ''),
    positions: number[] = [];
  for (let i = 0, j = 0; i < text.length && j < letters.length; i++)
    if (text[i] === letters[j]) {
      positions.push(i);
      j++;
    }
  if (positions.length < letters.length) return null;
  return { positions, score: 500 - (positions.at(-1)! - positions[0]) };
}

function Marked({
  text,
  positions,
  offset = 0,
}: {
  text: string;
  positions: number[];
  offset?: number;
}) {
  if (!positions.length) return text;
  const marked = new Set(positions);
  return [...text].map((character, i) =>
    marked.has(i + offset) ? (
      <mark key={i} {...stylex.props(styles.mark)}>
        {character}
      </mark>
    ) : (
      character
    ),
  );
}

/** A line with its matches marked; `trim` drops leading indentation for the results list. */
function Ranged({
  text,
  ranges,
  trim = false,
}: {
  text: string;
  ranges: TextMatch['ranges'];
  trim?: boolean;
}) {
  const pieces = [];
  let from = trim ? Math.min(text.length - text.trimStart().length, ranges[0]?.start ?? 0) : 0;
  for (const [i, range] of ranges.entries()) {
    if (range.start < from) continue;
    pieces.push(text.slice(from, range.start));
    pieces.push(
      <mark key={i} {...stylex.props(styles.mark, styles.found)}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    from = range.end;
  }
  pieces.push(text.slice(from));
  return pieces;
}

function useQuery<T extends EditorLookup | EditorTextSearch>(
  create: () => T,
  report: (error: unknown) => void,
) {
  const [query, setQuery] = useState<T | null>(null);
  useEffect(() => {
    const acquired = create();
    setQuery(acquired);
    return () => {
      void acquired.dispose().catch(report);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- one query model per popup.
  }, []);
  return query;
}

/**
 * ⌘P: Go to a file, chat, project or (after `>`) a command; ⇥ switches to Find, which searches
 * the checkout's file contents and previews each match in its surrounding lines.
 */
export function Picker({
  controller,
  checkout,
  discoveryRevision,
  entries: readEntries,
  request,
  openFile,
  close,
  editorFocus,
}: {
  controller: EditorController;
  checkout: CheckoutTarget | undefined;
  discoveryRevision: number;
  entries: () => PickerEntry[];
  request: PickerRequest;
  openFile: PickerOpenFile;
  close: () => void;
  editorFocus: () => HTMLElement | null;
}) {
  // An opened file takes focus; otherwise focus returns where it was, and an entry that changes
  // view moves it from there.
  const openedFile = useRef(false);
  const [mode, setMode] = useState<'goto' | 'find'>(request.mode === 'find' ? 'find' : 'goto');
  const [query, setQuery] = useState(request.mode === 'commands' ? '>' : request.text);
  const [options, setOptions] = useState<TextSearchOptions>({
    matchCase: false,
    wholeWord: false,
    regex: false,
  });
  const [selection, setSelection] = useState<{ at: number; key?: string }>({ at: 0 });
  const lookup = useQuery(() => controller.createLookup(), controller.report);
  const search = useQuery(() => controller.createTextSearch(), controller.report);
  const files = useSyncExternalStore(
    lookup?.subscribe ?? noSubscription,
    lookup?.getSnapshot ?? (() => emptyLookup),
  );
  const found = useSyncExternalStore(
    search?.subscribe ?? noSubscription,
    search?.getSnapshot ?? (() => emptySearch),
  );
  const id = useId(),
    selectedRow = useRef<HTMLDivElement>(null);
  const commands = mode === 'goto' && query.startsWith('>');
  const scope = checkout ? checkoutKey(checkout) : '';
  useEffect(() => {
    if (!lookup || !checkout || mode !== 'goto' || commands) return;
    lookup.query(query, [checkout]);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the checkout is keyed by `scope`.
  }, [lookup, scope, mode, commands, query, discoveryRevision]);
  useEffect(() => {
    if (!search || !checkout || mode !== 'find') return;
    search.query(query, options, checkout);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the checkout is keyed by `scope`.
  }, [search, scope, mode, query, options, discoveryRevision]);
  // A new query or mode starts at the top. Results that refresh because the checkout changed on
  // disk keep the row the reader moved to (by key), so the selection follows it if it moves.
  useEffect(() => setSelection({ at: 0 }), [mode, query, options]);
  // Scroll methods may return a promise in current Chromium; an effect must return nothing.
  useLayoutEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  });

  /** Opens through the query model, which serializes opens and reports a file that is gone. */
  function pickFile(
    model: EditorLookup | EditorTextSearch | null,
    target: FileTarget,
    at?: Parameters<PickerOpenFile>[1],
  ) {
    void model
      ?.open((current) => openFile(target, at, current))
      .then((opened) => {
        if (!opened) return;
        openedFile.current = true;
        close();
      });
  }
  // Cheap enough per render: a few dozen rows at most.
  function buildGoTo(): GoToRow[] {
    if (mode !== 'goto') return [];
    const entries = readEntries();
    const rows: GoToRow[] = [];
    const entry = (item: PickerEntry, group: string, matched: Matched): GoToRow => ({
      key: item.kind + ':' + item.id,
      group,
      kind: item.kind,
      label: item.label,
      positions: matched.positions,
      detail: item.detail,
      shortcut: item.shortcut,
      projectId: item.projectId,
      activate: () => {
        close();
        item.run();
      },
    });
    const ranked = (kind: PickerEntry['kind'], text: string) =>
      entries
        .filter((item) => item.kind === kind)
        .map((item) => ({ item, matched: matchLabel(item.label, text) }))
        .filter((row): row is { item: PickerEntry; matched: Matched } => !!row.matched)
        .sort((a, b) => b.matched.score - a.matched.score);
    if (commands) {
      for (const { item, matched } of ranked('command', query.slice(1)))
        rows.push(entry(item, '', matched));
      return rows;
    }
    const fileRows = (group: string, limit: number) => {
      if (!checkout) return;
      for (const row of files.rows
        .filter((row) => checkoutKey(row.checkout) === scope)
        .slice(0, limit)) {
        const target = { checkout: row.checkout, path: row.path };
        rows.push({
          key: 'file:' + fileKey(target),
          group,
          kind: 'file',
          label: row.path,
          positions: row.positions,
          activate: () => pickFile(lookup, target),
        });
      }
    };
    if (!query.trim()) {
      fileRows('Recent', 5);
      for (const item of entries.filter((item) => item.kind === 'chat' && item.recent).slice(0, 3))
        rows.push(entry(item, 'Recent', { positions: [], score: 0 }));
      for (const { item, matched } of ranked('project', ''))
        rows.push(entry(item, 'Projects', matched));
      return rows;
    }
    fileRows(checkout ? 'Files · ' + checkoutName(checkout) : '', 8);
    for (const { item, matched } of ranked('chat', query).slice(0, 5))
      rows.push(entry(item, 'Chats', matched));
    for (const { item, matched } of ranked('project', query).slice(0, 5))
      rows.push(entry(item, 'Projects', matched));
    for (const { item, matched } of ranked('command', query).slice(0, 3))
      rows.push(entry(item, 'Commands', matched));
    return rows;
  }
  const goTo = buildGoTo();

  const matches = useMemo(
    () =>
      mode === 'find' && found.checkout && checkoutKey(found.checkout) === scope
        ? found.files.flatMap((file) => file.matches.map((match) => ({ path: file.path, match })))
        : [],
    [mode, found, scope],
  );
  const rowKeys =
    mode === 'goto'
      ? goTo.map((row) => row.key)
      : matches.map((hit) => matchKey(hit.path, hit.match));
  const count = rowKeys.length;
  const kept = selection.key === undefined ? -1 : rowKeys.indexOf(selection.key);
  const selected = kept >= 0 ? kept : Math.min(selection.at, Math.max(0, count - 1));
  const select = (at: number) => setSelection({ at, key: rowKeys[at] });
  const preview = mode === 'find' ? matches[selected] : undefined;

  // Results stay on screen while a newly typed query runs, so Enter waits for that query to settle
  // and then opens the row the reader moved to if the new results still hold it, or else the top
  // one: never a row in its place they have not seen. A refresh after a change on disk reports no
  // search, so Enter never waits on one.
  const searching =
    mode === 'goto'
      ? !commands && !!checkout && !!query.trim() && files.message === 'Searching…'
      : !!checkout && !!query && found.message === 'Searching…';
  const pendingEnter = useRef(false);
  useEffect(() => {
    if (!pendingEnter.current || searching) return;
    pendingEnter.current = false;
    activate(Math.max(kept, 0));
  });
  function activate(at = selected) {
    if (mode === 'goto') {
      const row = goTo[at];
      if (row) row.activate();
      else if (checkout && !commands && query.trim()) {
        // An exact relative path opens even when discovery excludes it, as before.
        pickFile(lookup, { checkout, path: query.trim() });
      }
    } else {
      const hit = matches[at];
      if (!hit || !checkout || !search) return;
      const target = { checkout, path: hit.path },
        [range] = hit.match.ranges,
        position = {
          line: hit.match.line,
          column: (range?.start ?? 0) + 1,
          length: range ? range.end - range.start : 0,
        };
      pickFile(search, target, position);
    }
  }
  /** Keeps what was typed, minus a command prefix; Find falls back to the editor's selection. */
  function showMode(next: PickerMode) {
    const plain = (text: string) => (text.startsWith('>') ? '' : text);
    setMode(next === 'find' ? 'find' : 'goto');
    if (next === 'commands') setQuery('>');
    else if (next === 'goto') setQuery(plain);
    else setQuery((text) => (plain(text) || request.text).slice(0, 256));
  }

  let status = '';
  if (mode === 'find') {
    if (!checkout) status = 'Open a project to search its files.';
    else if (query) status = found.message;
  } else if (commands) {
    if (!goTo.length) status = 'No commands match.';
  } else if (!checkout) {
    if (!goTo.length) status = 'Open a project to find its files.';
  } else if (
    !['Searching…', 'Type a filename or path.', ''].includes(files.message) &&
    !/^\d+ results$/.test(files.message)
  )
    // A failed open, a capped listing or a discovery error.
    status = files.message;
  else if (query.trim() && !goTo.length && files.message !== 'Searching…') status = 'No results.';

  const placeholder =
    mode === 'find'
      ? 'Search text in ' + (checkout ? checkoutName(checkout) : 'files')
      : 'Search files, chats and projects · > for commands';
  /** `name` is the option's accessible name: a file's whole path, not its split display. */
  const option = (
    key: string,
    at: number,
    name: string,
    children: React.ReactNode,
    extra?: stylex.StyleXStyles,
  ) => (
    <div
      key={key}
      id={`${id}-${at}`}
      role="option"
      aria-label={name}
      aria-selected={at === selected}
      ref={at === selected ? selectedRow : undefined}
      {...stylex.props(styles.row, extra, at === selected && styles.selected)}
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => at !== selected && select(at)}
      onClick={() => activate(at)}>
      {children}
    </div>
  );

  let list: React.ReactNode;
  if (mode === 'goto') {
    let group: string | undefined;
    list = goTo.map((row, at) => {
      const heading =
        row.group !== group && row.group ? (
          <div key={'group:' + row.group} role="presentation" {...stylex.props(styles.heading)}>
            {row.group}
          </div>
        ) : null;
      group = row.group;
      const slash = row.kind === 'file' ? row.label.lastIndexOf('/') : -1;
      let leading: React.ReactNode;
      if (row.kind === 'project')
        leading = (
          <span
            aria-hidden="true"
            data-initials={projectInitials(row.label)}
            {...stylex.props(
              projectTiles.tile,
              styles.tile,
              projectHue(row.projectId ?? row.label),
            )}
          />
        );
      else
        leading = (
          <span {...stylex.props(styles.icon)}>
            <Icon name={rowIcons[row.kind]} />
          </span>
        );
      return [
        heading,
        option(
          row.key,
          at,
          row.label,
          <>
            {leading}
            <span {...stylex.props(styles.label)}>
              <Marked
                text={row.label.slice(slash + 1)}
                positions={row.positions}
                offset={slash + 1}
              />
            </span>
            {slash > 0 && (
              <span {...stylex.props(styles.detail, styles.path)}>
                <Marked text={row.label.slice(0, slash)} positions={row.positions} />
              </span>
            )}
            {(row.detail || row.shortcut) && (
              <span {...stylex.props(styles.detail, styles.trailing)}>
                {row.shortcut ?? row.detail}
              </span>
            )}
          </>,
        ),
      ];
    });
  } else {
    let at = 0;
    list = found.files.map((file) => (
      <div key={file.path} role="group" aria-label={file.path}>
        <div role="presentation" {...stylex.props(styles.fileHeading)}>
          <span {...stylex.props(styles.icon)}>
            <Icon name="file" />
          </span>
          <span {...stylex.props(styles.label)}>{file.path.split('/').at(-1)}</span>
          <span {...stylex.props(styles.detail, styles.trailing)}>{file.matches.length}</span>
        </div>
        {file.matches.map((match) =>
          option(
            matchKey(file.path, match),
            at++,
            `Line ${match.line}: ${match.text.trim()}`,
            <>
              <span {...stylex.props(styles.lineNumber)}>{match.line}</span>
              <span {...stylex.props(styles.label, styles.code)}>
                <Ranged text={match.text} ranges={match.ranges} trim />
              </span>
            </>,
            styles.matchRow,
          ),
        )}
      </div>
    ));
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}>
      <Dialog.Portal>
        <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
        <Dialog.Popup
          finalFocus={() => (openedFile.current ? (editorFocus() ?? false) : true)}
          data-picker=""
          {...stylex.props(workbench.document, styles.popup)}>
          <Dialog.Title {...stylex.props(controls.hidden)}>
            {mode === 'find' ? 'Find in files' : 'Go to'}
          </Dialog.Title>
          <div role="tablist" aria-label="Picker mode" {...stylex.props(styles.tabs)}>
            {(['goto', 'find'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                tabIndex={-1}
                aria-selected={mode === tab}
                {...stylex.props(styles.tab, mode === tab && styles.activeTab)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => mode !== tab && showMode(tab)}>
                {tab === 'goto' ? 'Go to' : 'Find'}
              </button>
            ))}
            <span aria-hidden="true" {...stylex.props(styles.hint, styles.trailing)}>
              ⇥ switch
            </span>
          </div>
          <label {...stylex.props(styles.field)}>
            <span {...stylex.props(styles.icon)}>
              <Icon name="search" />
            </span>
            <span {...stylex.props(controls.hidden)}>{placeholder}</span>
            <input
              value={query}
              placeholder={placeholder}
              maxLength={mode === 'find' ? 256 : 4096}
              spellCheck={false}
              role="combobox"
              aria-controls={id}
              aria-expanded={count > 0}
              aria-activedescendant={count ? `${id}-${selected}` : undefined}
              {...stylex.props(styles.input)}
              onChange={(event) => setQuery(event.target.value.replace(/[\n\r]/g, ''))}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                const shortcut = pickerMode(event, pickerCommand(event));
                if (shortcut) {
                  // The picker is modal, so its own shortcuts switch it rather than reopen it.
                  event.preventDefault();
                  event.stopPropagation();
                  showMode(shortcut);
                } else if (event.key === 'Tab') {
                  event.preventDefault();
                  showMode(mode === 'goto' ? 'find' : 'goto');
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  if (searching) pendingEnter.current = true;
                  else activate();
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (count)
                    select((selected + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
                } else if (mode === 'find' && event.altKey) {
                  const option = { KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'regex' }[
                    event.code
                  ] as keyof TextSearchOptions | undefined;
                  if (!option) return;
                  event.preventDefault();
                  setOptions((value) => ({ ...value, [option]: !value[option] }));
                }
              }}
            />
            {mode === 'find' && (
              <span {...stylex.props(styles.toggles)}>
                {(
                  [
                    ['matchCase', 'Aa', 'Match case · ⌥C'],
                    ['wholeWord', 'ab', 'Whole word · ⌥W'],
                    ['regex', '.*', 'Regular expression · ⌥R'],
                  ] as const
                ).map(([option, text, label]) => (
                  <button
                    key={option}
                    type="button"
                    tabIndex={-1}
                    aria-label={label.split(' · ')[0]}
                    title={label}
                    aria-pressed={options[option]}
                    {...stylex.props(styles.toggle, options[option] && styles.toggleOn)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setOptions((value) => ({ ...value, [option]: !value[option] }))}>
                    {text}
                  </button>
                ))}
              </span>
            )}
          </label>
          <div {...stylex.props(styles.body)}>
            <div
              id={id}
              role="listbox"
              aria-label={mode === 'find' ? 'Matches' : 'Results'}
              {...stylex.props(styles.list, mode === 'find' && styles.matchList)}>
              {mode === 'find' && checkout && found.files.length > 0 && (
                <div role="presentation" {...stylex.props(styles.count)}>
                  {found.message}
                </div>
              )}
              {list}
              {status && (mode === 'goto' || !found.files.length) && (
                <p role="status" {...stylex.props(styles.status)}>
                  {status}
                </p>
              )}
            </div>
            {mode === 'find' && (
              <div aria-label="Preview" role="region" {...stylex.props(styles.preview)}>
                {preview && (
                  <>
                    <div {...stylex.props(styles.previewHeading)}>
                      <span {...stylex.props(styles.label)}>{preview.path.split('/').at(-1)}</span>
                      <span {...stylex.props(styles.detail)}>line {preview.match.line}</span>
                    </div>
                    <div {...stylex.props(styles.previewCode)}>
                      {[
                        ...preview.match.before.map((text, i, all) => ({
                          line: preview.match.line - all.length + i,
                          text,
                        })),
                        { line: preview.match.line, text: preview.match.text },
                        ...preview.match.after.map((text, i) => ({
                          line: preview.match.line + 1 + i,
                          text,
                        })),
                      ].map((row) => (
                        <div
                          key={row.line}
                          {...stylex.props(
                            styles.previewLine,
                            row.line === preview.match.line && styles.previewMatch,
                          )}>
                          <span {...stylex.props(styles.lineNumber)}>{row.line}</span>
                          <span>
                            {row.line === preview.match.line ? (
                              <Ranged text={row.text} ranges={preview.match.ranges} />
                            ) : (
                              row.text
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <div aria-hidden="true" {...stylex.props(styles.footer)}>
            <span>↑↓ move</span>
            <span>{mode === 'find' ? '⏎ open at line' : '⏎ open'}</span>
            {mode === 'goto' && !commands && <span>&gt; commands</span>}
            <span>{mode === 'find' ? '⇥ go to' : '⇥ find'}</span>
            <span {...stylex.props(styles.trailing)}>esc close</span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const styles = stylex.create({
  backdrop: { position: 'fixed', inset: 0, backgroundColor: colors.backdrop, zIndex: 50 },
  popup: {
    position: 'fixed',
    top: 72,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 51,
    width: 'min(700px, calc(100vw - 40px))',
    height: 'min(384px, calc(100vh - 96px))',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxSizing: 'border-box',
    color: colors.text,
    fontSize: type.body,
    backgroundColor: colors.elevated,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    borderRadius: radius.panel,
    boxShadow: shadow.raised,
    outline: 'none',
  },
  tabs: { display: 'flex', alignItems: 'center', gap: space.xs, padding: '8px 10px 0' },
  tab: {
    height: 26,
    paddingInline: 10,
    borderWidth: 0,
    borderRadius: 6,
    backgroundColor: 'transparent',
    color: colors.muted,
    font: 'inherit',
    fontSize: type.small,
    cursor: 'pointer',
    ':hover': { color: colors.text },
  },
  activeTab: { backgroundColor: colors.selected, color: colors.text },
  hint: { color: colors.muted, fontSize: type.caption },
  field: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    height: 44,
    flexShrink: 0,
    paddingInline: 14,
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
    color: colors.muted,
  },
  input: {
    flex: 1,
    minWidth: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.text,
    font: 'inherit',
    outline: 'none',
    '::placeholder': { color: colors.muted },
  },
  toggles: { display: 'flex', gap: space.xs },
  toggle: {
    height: 24,
    minWidth: 26,
    paddingInline: 5,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: colors.controlBorder,
    borderRadius: 6,
    backgroundColor: 'transparent',
    color: colors.secondary,
    font: 'inherit',
    fontSize: type.caption,
    cursor: 'pointer',
  },
  toggleOn: { borderColor: colors.accent, backgroundColor: colors.selected, color: colors.text },
  body: { flex: 1, minHeight: 0, display: 'flex' },
  list: {
    flex: 1,
    minWidth: 0,
    overflowY: 'auto',
    padding: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
  },
  matchList: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 280,
    borderRightWidth: 1,
    borderRightStyle: 'solid',
    borderRightColor: colors.border,
  },
  heading: {
    padding: '6px 8px 3px',
    color: colors.muted,
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  count: { padding: '4px 8px 3px', color: colors.muted, fontSize: type.caption },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
    height: 30,
    paddingInline: 8,
    borderRadius: radius.row,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    cursor: 'pointer',
  },
  selected: {
    backgroundColor: colors.selected,
    outline: `1px solid ${colors.accent}`,
    outlineOffset: -1,
  },
  matchRow: { height: 26, gap: space.sm, paddingLeft: 24, fontSize: type.small },
  fileHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    height: 26,
    paddingInline: 8,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    fontSize: type.small,
  },
  icon: { display: 'inline-flex', flexShrink: 0, color: colors.secondary },
  tile: { width: 18, height: 18, borderRadius: 5, fontSize: 9 },
  label: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flexShrink: 0,
    maxWidth: '100%',
  },
  code: { flexShrink: 1, color: colors.secondary },
  detail: { color: colors.muted, fontSize: type.small },
  path: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  trailing: { marginLeft: 'auto', flexShrink: 0 },
  lineNumber: {
    flexShrink: 0,
    width: 28,
    textAlign: 'right',
    color: colors.muted,
    fontVariantNumeric: 'tabular-nums',
  },
  mark: {
    backgroundColor: 'transparent',
    color: 'inherit',
    fontWeight: 700,
    textDecoration: 'underline',
  },
  found: { color: colors.text },
  status: { margin: 0, padding: '8px', color: colors.muted, fontSize: type.small },
  preview: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: colors.surface,
  },
  previewHeading: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space.sm,
    padding: '8px 12px',
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: colors.border,
    fontSize: type.small,
    whiteSpace: 'nowrap',
    backgroundColor: colors.elevated,
  },
  previewCode: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    paddingBlock: space.sm,
    fontSize: 11.5,
    lineHeight: 1.7,
  },
  previewLine: { display: 'flex', gap: space.md, paddingInline: space.md, whiteSpace: 'pre' },
  previewMatch: { backgroundColor: colors.selected },
  footer: {
    display: 'flex',
    gap: space.lg,
    flexShrink: 0,
    padding: '7px 14px',
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.border,
    color: colors.muted,
    fontSize: type.caption,
  },
});
