import * as stylex from '@stylexjs/stylex';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { Dialog } from '@base-ui/react/dialog';
import { Tabs } from '@base-ui/react/tabs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from '@effect/atom-react';
import { Effect } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import type { CheckoutTarget, FileTarget } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  type Lookup,
  type LookupSnapshot,
  type TextSearch,
  type TextSearchOptions,
  type TextSearchSnapshot,
  type EditorFailure,
} from '@moonbase/application/editor';
import { controls } from '@moonbase/ui/controls';
import { checkoutName } from '@moonbase/ui/projects';
import { workbench } from '@moonbase/ui/workbench';
import { Icon } from '@moonbase/ui/icons';
import { listGoToRows, type GoToRow, type PickerEntry } from './go-to-rows.ts';
import { findMatchPosition, listFindMatches, type FindMatch } from './find-matches.ts';
import { GoToList } from './go-to-list.tsx';
import { FindList } from './find-list.tsx';
import { MatchPreview } from './match-preview.tsx';
import { SearchOptions, findSearchOption } from './search-options.tsx';
import { describePickerStatus, isPickerSearching } from './picker-status.ts';
import {
  pickerCommand,
  pickerMode,
  type PickerMode,
  type PickerRequest,
} from './picker-shortcuts.ts';
import { styles } from './picker-styles.ts';
import type { EditorActions } from '../editor-actions.ts';
import { useEditorTask } from '../use-editor-task.ts';

/**
 * Opens a file, at a line when Find picked a match; succeeds false when it was not opened. A newer
 * query or closing the picker interrupts it.
 */
export type PickerOpenFile = (
  target: FileTarget,
  at: { line: number; column: number; length: number } | undefined,
) => Effect.Effect<boolean, EditorFailure>;

const emptyLookup = Atom.make<LookupSnapshot>({ rows: [], message: '', busy: false });
const emptySearch = Atom.make<TextSearchSnapshot>({ files: [], message: '', busy: false });
const valueOf = <A,>(result: AsyncResult.AsyncResult<A, unknown>) =>
  AsyncResult.isSuccess(result) ? result.value : null;

/**
 * ⌘P: Go to a file, chat, project or (after `>`) a command; ⇥ switches to Find, which searches
 * the checkout's file contents and previews each match in its surrounding lines.
 *
 * Base UI owns the combobox: the field, the listbox, the highlighted row and arrow keys. The
 * picker decides what Enter opens, since it can wait for a query that is still running.
 */
export function Picker({
  actions,
  checkout,
  entries: readEntries,
  request,
  openFile,
  close,
  editorFocus,
}: {
  actions: EditorActions;
  checkout: CheckoutTarget | undefined;
  entries: () => PickerEntry[];
  request: PickerRequest;
  openFile: PickerOpenFile;
  close: () => void;
  editorFocus: () => HTMLElement | null;
}) {
  // An opened file takes focus; otherwise focus returns where it was, and an entry that changes
  // view moves it from there. The picker closes once the opened file has rendered, so its editor
  // is there to take focus.
  const [openedFile, setOpenedFile] = useState(false);
  useEffect(() => {
    if (openedFile) close();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Closes once, when a file opened.
  }, [openedFile]);
  // Where focus was before the field took it as it mounted, which the dialog would see instead.
  const [opener] = useState(() => document.activeElement);
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'goto' | 'find'>(request.mode === 'find' ? 'find' : 'goto');
  const [query, setQuery] = useState(request.mode === 'commands' ? '>' : request.text);
  const [options, setOptions] = useState<TextSearchOptions>({
    matchCase: false,
    wholeWord: false,
    regex: false,
  });
  // A switch of mode or options remounts the combobox, so the highlight starts at the top as it
  // does for a newly typed query. A refresh after a change on disk keeps the highlight at the same
  // position (Base UI tracks it by index), so it lands on whichever row is now there.
  const [generation, setGeneration] = useState(0);
  const [highlighted, setHighlighted] = useState<string>();
  // The row the reader moved to with the keys or pointer, which a refresh moves with the
  // highlight; Enter opens it while the results still hold it. Base UI's own highlight of the top
  // row, which can still belong to the previous query's results, is not a choice, and a new query,
  // mode or options forget it.
  const chosen = useRef<string>(undefined);
  // The popup's own queries, for as long as it is open; each refreshes its last query when the
  // checkout changes on disk.
  const { atoms } = actions.editor;
  const lookup = valueOf(useAtomValue(atoms.lookup.lookup));
  const search = valueOf(useAtomValue(atoms.textSearch.search));
  const files = useAtomValue(lookup ? atoms.lookup.state(lookup) : emptyLookup);
  const found = useAtomValue(search ? atoms.textSearch.state(search) : emptySearch);
  const commands = mode === 'goto' && query.startsWith('>');
  // The picker's own work, which closing it interrupts.
  const run = useEditorTask(actions);
  const scope = checkout ? checkoutKey(checkout) : '';
  useEffect(() => {
    if (!lookup || !checkout || mode !== 'goto' || commands) return;
    run(lookup.query(query, [checkout]));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the checkout is keyed by `scope`.
  }, [lookup, scope, mode, commands, query]);
  useEffect(() => {
    if (!search || !checkout || mode !== 'find') return;
    run(search.query(query, options, checkout));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the checkout is keyed by `scope`.
  }, [search, scope, mode, query, options]);

  // Cheap enough per render: a few dozen rows at most.
  const goTo =
    mode === 'goto' ? listGoToRows({ query, entries: readEntries(), files, checkout }) : [];
  const findFiles = useMemo(
    () =>
      mode === 'find' && found.checkout && checkoutKey(found.checkout) === scope
        ? listFindMatches(found.files)
        : [],
    [mode, found, scope],
  );
  const matches = findFiles.flatMap((file) => file.matches);
  const rowKeys = mode === 'goto' ? goTo.map((row) => row.key) : matches.map((hit) => hit.key);
  const preview = matches.find((hit) => hit.key === highlighted);

  /** Opens through the query model, which serializes opens and reports a file that is gone. */
  function pickFile(
    model: Lookup | TextSearch | null,
    target: FileTarget,
    at?: Parameters<PickerOpenFile>[1],
  ) {
    if (!model) return;
    // A newer query or closing the picker interrupts the open: it is then no longer wanted.
    run(
      Effect.tap(model.open(openFile(target, at)), (opened) =>
        Effect.sync(() => {
          if (opened) setOpenedFile(true);
        }),
      ),
    );
  }
  function activateGoTo(row: GoToRow) {
    if (row.file) return pickFile(lookup, row.file);
    close();
    row.entry.run();
  }
  function activateFind(hit: FindMatch) {
    if (checkout) pickFile(search, { checkout, path: hit.path }, findMatchPosition(hit));
  }
  /** Opens the row with `key`, else the top row: never one in its place the reader hasn't seen. */
  function activate(key: string | undefined) {
    const at = Math.max(key === undefined ? -1 : rowKeys.indexOf(key), 0);
    if (mode === 'find') {
      const hit = matches[at];
      if (hit) activateFind(hit);
    } else if (goTo[at]) activateGoTo(goTo[at]);
    else if (checkout && !commands && query.trim()) {
      // An exact relative path opens even when discovery excludes it, as before.
      pickFile(lookup, { checkout, path: query.trim() });
    }
  }

  // Results stay on screen while a newly typed query runs, so Enter waits for that query to settle
  // and then opens the row the reader moved to if the new results still hold it.
  const searching = isPickerSearching({ mode, query, hasCheckout: !!checkout, files, found });
  const pendingEnter = useRef<{ key: string | undefined }>(undefined);
  useEffect(() => {
    if (!pendingEnter.current || searching) return;
    const { key } = pendingEnter.current;
    pendingEnter.current = undefined;
    activate(key);
  });

  /** Keeps what was typed, minus a command prefix; Find falls back to the editor's selection. */
  function showMode(next: PickerMode) {
    const plain = (text: string) => (text.startsWith('>') ? '' : text);
    setMode(next === 'find' ? 'find' : 'goto');
    setGeneration((value) => value + 1);
    chosen.current = undefined;
    if (next === 'commands') setQuery('>');
    else if (next === 'goto') setQuery(plain);
    else setQuery((text) => (plain(text) || request.text).slice(0, 256));
  }
  function changeOptions(next: TextSearchOptions) {
    setOptions(next);
    setGeneration((value) => value + 1);
    chosen.current = undefined;
  }

  const status = describePickerStatus({
    mode,
    query,
    hasCheckout: !!checkout,
    files,
    found,
    rowCount: rowKeys.length,
  });
  const placeholder =
    mode === 'find'
      ? 'Search text in ' + (checkout ? checkoutName(checkout) : 'files')
      : 'Search files, chats and projects · > for commands';

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}>
      <Dialog.Portal>
        <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
        <Dialog.Popup
          initialFocus={input}
          finalFocus={() => {
            if (openedFile) return editorFocus() ?? false;
            return opener instanceof HTMLElement && opener.isConnected ? opener : true;
          }}
          data-picker=""
          {...stylex.props(workbench.document, styles.popup)}>
          <Dialog.Title {...stylex.props(controls.hidden)}>
            {mode === 'find' ? 'Find in files' : 'Go to'}
          </Dialog.Title>
          <Tabs.Root
            value={mode}
            onValueChange={(next: 'goto' | 'find') => next !== mode && showMode(next)}
            {...stylex.props(styles.fill)}>
            <Tabs.List aria-label="Picker mode" {...stylex.props(styles.tabs)}>
              {(['goto', 'find'] as const).map((tab) => (
                <Tabs.Tab
                  key={tab}
                  value={tab}
                  {...stylex.props(styles.tab)}
                  // ⇥ in the field switches tabs, so the field keeps focus.
                  onMouseDown={(event) => event.preventDefault()}>
                  {tab === 'goto' ? 'Go to' : 'Find'}
                </Tabs.Tab>
              ))}
              <span aria-hidden="true" {...stylex.props(styles.hint, styles.trailing)}>
                ⇥ switch
              </span>
            </Tabs.List>
            <Autocomplete.Root
              key={generation}
              inline
              open
              mode="none"
              items={rowKeys}
              autoHighlight="always"
              keepHighlight
              value={query}
              onValueChange={(value) => {
                chosen.current = undefined;
                setQuery(value.replace(/[\n\r]/g, ''));
              }}
              onItemHighlighted={(value: string | undefined, details) => {
                setHighlighted(value);
                // A refresh moves a chosen highlight to the row now at its position; Enter then
                // opens what is shown.
                if (details.reason !== 'none' || chosen.current !== undefined)
                  chosen.current = value;
              }}>
              <Tabs.Panel value={mode} tabIndex={-1} {...stylex.props(styles.fill)}>
                <Autocomplete.InputGroup {...stylex.props(styles.field)}>
                  <span {...stylex.props(styles.icon)}>
                    <Icon name="search" />
                  </span>
                  <Autocomplete.Input
                    ref={input}
                    // Focused as it mounts: the dialog's initial focus waits a frame, and keys typed
                    // straight after the shortcut would reach the editor behind it.
                    autoFocus
                    aria-label={placeholder}
                    placeholder={placeholder}
                    maxLength={mode === 'find' ? 256 : 4096}
                    spellCheck={false}
                    {...stylex.props(styles.input)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      const shortcut = pickerMode(event, pickerCommand(event));
                      const option = mode === 'find' ? findSearchOption(event) : undefined;
                      if (shortcut) {
                        // The picker is modal, so its own shortcuts switch it rather than reopen it.
                        event.preventBaseUIHandler();
                        event.preventDefault();
                        event.stopPropagation();
                        showMode(shortcut);
                      } else if (event.key === 'Tab') {
                        event.preventBaseUIHandler();
                        event.preventDefault();
                        showMode(mode === 'goto' ? 'find' : 'goto');
                      } else if (event.key === 'Enter') {
                        event.preventBaseUIHandler();
                        event.preventDefault();
                        if (searching) pendingEnter.current = { key: chosen.current };
                        else activate(chosen.current);
                      } else if (event.key === 'Escape') {
                        // Escape closes the picker, not just the list inside it.
                        event.preventBaseUIHandler();
                      } else if (option) {
                        event.preventDefault();
                        changeOptions({ ...options, [option]: !options[option] });
                      }
                    }}
                  />
                  {mode === 'find' && <SearchOptions options={options} change={changeOptions} />}
                </Autocomplete.InputGroup>
                <div {...stylex.props(styles.body)}>
                  <div {...stylex.props(styles.list, mode === 'find' && styles.matchList)}>
                    <Autocomplete.List
                      aria-label={mode === 'find' ? 'Matches' : 'Results'}
                      {...stylex.props(styles.group)}>
                      {mode === 'find' && findFiles.length > 0 && (
                        <div {...stylex.props(styles.count)}>{found.message}</div>
                      )}
                      {mode === 'find' ? (
                        <FindList files={findFiles} activate={activateFind} />
                      ) : (
                        <GoToList rows={goTo} activate={activateGoTo} />
                      )}
                    </Autocomplete.List>
                    <Autocomplete.Status {...stylex.props(styles.status)}>
                      {(mode === 'goto' || !findFiles.length) && status}
                    </Autocomplete.Status>
                  </div>
                  {mode === 'find' && <MatchPreview hit={preview} />}
                </div>
              </Tabs.Panel>
            </Autocomplete.Root>
            <div aria-hidden="true" {...stylex.props(styles.footer)}>
              <span>↑↓ move</span>
              <span>{mode === 'find' ? '⏎ open at line' : '⏎ open'}</span>
              {mode === 'goto' && !commands && <span>&gt; commands</span>}
              <span>{mode === 'find' ? '⇥ go to' : '⇥ find'}</span>
              <span {...stylex.props(styles.trailing)}>esc close</span>
            </div>
          </Tabs.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
