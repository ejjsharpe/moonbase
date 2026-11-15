import * as stylex from '@stylexjs/stylex';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { Dialog } from '@base-ui/react/dialog';
import { Tabs } from '@base-ui/react/tabs';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CheckoutTarget, FileTarget } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  type EditorController,
  type EditorLookup,
  type EditorTextSearch,
  type LookupSnapshot,
  type TextSearchOptions,
  type TextSearchSnapshot,
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
import { useQueryModel } from './use-query-model.ts';
import { styles } from './picker-styles.ts';

/** Opens a file, at a line when Find picked a match; resolves false when it was not opened. */
export type PickerOpenFile = (
  target: FileTarget,
  at: { line: number; column: number; length: number } | undefined,
  current: () => boolean,
) => Promise<boolean>;

const emptyLookup: LookupSnapshot = { rows: [], message: '', busy: false };
const emptySearch: TextSearchSnapshot = { files: [], message: '', busy: false };
const noSubscription = () => () => {};

/**
 * ⌘P: Go to a file, chat, project or (after `>`) a command; ⇥ switches to Find, which searches
 * the checkout's file contents and previews each match in its surrounding lines.
 *
 * Base UI owns the combobox: the field, the listbox, the highlighted row and arrow keys. The
 * picker decides what Enter opens, since it can wait for a query that is still running.
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
  const input = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'goto' | 'find'>(request.mode === 'find' ? 'find' : 'goto');
  const [query, setQuery] = useState(request.mode === 'commands' ? '>' : request.text);
  const [options, setOptions] = useState<TextSearchOptions>({
    matchCase: false,
    wholeWord: false,
    regex: false,
  });
  // A switch of mode or options remounts the combobox, so the highlight starts at the top as it
  // does for a newly typed query. A refresh after a change on disk keeps it where it is.
  const [generation, setGeneration] = useState(0);
  const [highlighted, setHighlighted] = useState<string>();
  // The row the reader moved to with the keys or pointer; Enter opens it while the results still
  // hold it. Base UI's own highlight of the top row, which can still belong to the previous
  // query's results, is not a choice, and a new query or mode forgets it.
  const chosen = useRef<string>(undefined);
  const lookup = useQueryModel(() => controller.createLookup(), controller.report);
  const search = useQueryModel(() => controller.createTextSearch(), controller.report);
  const files = useSyncExternalStore(
    lookup?.subscribe ?? noSubscription,
    lookup?.getSnapshot ?? (() => emptyLookup),
  );
  const found = useSyncExternalStore(
    search?.subscribe ?? noSubscription,
    search?.getSnapshot ?? (() => emptySearch),
  );
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
          finalFocus={() => (openedFile.current ? (editorFocus() ?? false) : true)}
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
                if (details.reason !== 'none') chosen.current = value;
              }}>
              <Tabs.Panel value={mode} tabIndex={-1} {...stylex.props(styles.fill)}>
                <Autocomplete.InputGroup {...stylex.props(styles.field)}>
                  <span {...stylex.props(styles.icon)}>
                    <Icon name="search" />
                  </span>
                  <Autocomplete.Input
                    ref={input}
                    autoFocus={generation > 0}
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
