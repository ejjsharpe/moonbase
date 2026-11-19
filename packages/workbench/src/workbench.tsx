import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import { workbench } from '@moonbase/ui/workbench';
import { colors, space, type } from '@moonbase/ui/tokens.stylex';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import { useAtomValue } from '@effect/atom-react';
import { checkoutKey, fileKey } from '@moonbase/application/editor';
import { Deferred, Effect } from 'effect';
import { useEditorActions } from './editor-actions.ts';
import { useEditorTask } from './use-editor-task.ts';
import type { WorkbenchEditor } from './workbench-editor.ts';
import { ClosePrompt } from './close-prompt.tsx';
import { EditorArea } from './editor-area/editor-area.tsx';
import type { EditorTabsHandle } from './editor-tabs/editor-tabs.tsx';
import { RecentTabsList } from './editor-tabs/recent-tabs.tsx';
import { ChangesView } from './explorer/changes-view.tsx';
import { Explorer, type ExplorerPanel } from './explorer/explorer.tsx';
import { useExplorerPaste } from './explorer/use-explorer-paste.ts';
import { FilesTree } from './files-tree/files-tree.tsx';
import { findCreateFolder } from './files-tree/files-tree-rows.ts';
import type { FollowedFiles } from './files-tree/use-follow-active-file.ts';
import type { TreeCreateRequest } from './files-tree/use-tree-edit.ts';
import { findFocusOrigin, useFocusReturn } from './focus-return.ts';
import { readSelection, type EditorReveal, type MonacoViewHandle } from './monaco-view.tsx';
import { Mutation } from './mutation-dialog.tsx';
import { listEditorCommands } from './picker/editor-commands.ts';
import type { PickerEntry } from './picker/go-to-rows.ts';
import type { PickerMode, PickerRequest } from './picker/picker-shortcuts.ts';
import { Picker, type PickerOpenFile } from './picker/picker.tsx';
import type { Shortcut } from './shortcuts.ts';
import { SidebarLayout } from './sidebar/sidebar-layout.tsx';
import { StatusMessages } from './status-messages.tsx';
import { useWorkbenchKeys } from './workbench-keys.ts';
import { useWorkbenchMutations } from './workbench-mutations.ts';

export type WorkbenchHandle = {
  importFiles(checkout: CheckoutTarget, references: string[]): void;
  /** Opens ⌘P's picker; `find` starts from the editor's selected text. */
  openPicker(mode: PickerMode): void;
  keyDown(event: KeyboardEvent): void;
  keyUp(event: KeyboardEvent): void;
};
export type WorkbenchProps = {
  /**
   * The editor this workbench shows: its services, atoms, atom runtime and the app's platform
   * capabilities.
   */
  editor: WorkbenchEditor;
  checkout: CheckoutTarget | undefined;
  visible?: boolean;
  renderLayout?: (views: { explorer: ReactNode; editor: ReactNode }) => ReactNode;
  /** App content placed after the editor in the default layout, such as a docked panel. */
  trailing?: ReactNode;
  /** Chats, projects and app commands the picker offers beside this checkout's files, read while it is open. */
  pickerEntries?: () => PickerEntry[];
  /** Called when the picker opens a file or runs an editor command, to bring the editor into view. */
  onShowEditor?: () => void;
  /** Mentions a checkout's files in the chat beside it. */
  mentionInChat?: (checkout: CheckoutTarget, paths: string[]) => void;
  /** False when the window's title bar already names the open file. */
  showBreadcrumbs?: boolean;
  /** Hides the explorer, leaving the editor the full width. */
  sidebarHidden?: boolean;
  /** Called while `sidebarHidden` when a command needs the explorer, such as Show Files (⇧⌘E). */
  onShowSidebar?: () => void;
  /** The app's own shortcuts, listed after the editor's when no file is open. */
  shortcuts?: readonly Shortcut[];
};

/** One checkout's explorer beside its editor, with the dialogs and keys they share. */
export const Workbench = forwardRef<WorkbenchHandle, WorkbenchProps>(function Workbench(
  {
    editor: workbenchEditor,
    checkout: project,
    visible = true,
    renderLayout,
    trailing,
    pickerEntries,
    onShowEditor,
    mentionInChat,
    showBreadcrumbs = true,
    sidebarHidden = false,
    onShowSidebar,
    shortcuts = [],
  },
  ref,
) {
  const actions = useEditorActions(workbenchEditor);
  const state = useAtomValue(workbenchEditor.atoms.snapshot);
  const openCheckouts = state.recovery.checkouts.filter((target) =>
    state.recovery.openCheckoutIds.includes(target.checkoutId),
  );
  const checkout =
    project && openCheckouts.find((target) => checkoutKey(target) === checkoutKey(project));
  const view = checkout && state.recovery.views.get(checkout.checkoutId),
    target = checkout && view?.active ? { checkout, path: view.active } : undefined;
  const buffer =
    target && state.buffers.find((buffer) => fileKey(buffer.target) === fileKey(target));
  const mode = (target && view?.fileViews?.get(target.path)) || 'file';
  const projectIdentity = project ? checkoutKey(project) : null;
  // Ends once this workbench stops showing the checkout, abandoning a close's open of the file
  // left active: the checkout shown need not be the editor's selected one.
  const shown = useRef<Deferred.Deferred<void>>(null);
  useEffect(() => {
    const left = Deferred.makeUnsafe<void>();
    shown.current = left;
    return () => {
      Deferred.doneUnsafe(left, Effect.void);
    };
  }, [projectIdentity]);
  // A plain folder has no Git changes, comparisons or Changes view.
  const git = checkout?.vcs === 'git';
  // Git lists a file once per area it changed in (staged and unstaged, say); count it once.
  const changedFiles = new Set(
    ((checkout && state.git[checkoutKey(checkout)]?.changes) || []).map((change) => change.path),
  ).size;
  const following = state.recovery.followActiveFile ?? true;
  const choice = state.closePrompt;
  const [anchorReset, setAnchorReset] = useState(0);
  const [picker, setPicker] = useState<PickerRequest | null>(null),
    [reveal, setReveal] = useState<EditorReveal>(),
    [chosenPanel, setPanel] = useState<ExplorerPanel>('files');
  const panel = git ? chosenPanel : 'files';
  // The explorer's "…" New File/Folder, started by the files tree.
  const [createRequest, setCreateRequest] = useState<TreeCreateRequest | null>(null),
    createRequests = useRef(0),
    reveals = useRef(0);
  // Per checkout, the active file its tree last followed, kept while the tree is unmounted.
  const [followedFiles] = useState<FollowedFiles>(() => new Map());
  const root = useRef<HTMLDivElement>(null),
    explorerElement = useRef<HTMLDivElement>(null),
    explorerActionsButton = useRef<HTMLButtonElement>(null),
    treeElement = useRef<HTMLDivElement>(null),
    tabs = useRef<EditorTabsHandle>(null),
    monaco = useRef<MonacoViewHandle>(null);
  const run = useEditorTask(actions);

  const mutations = useWorkbenchMutations({
    actions,
    state,
    openCheckouts,
    pickerOpen: !!picker,
  });
  const { dialog, dialogOpen, canRequestMutation, importFiles, moveUndo, fileClipboard } =
    mutations;

  const focus = useFocusReturn({
    actions,
    root,
    checkout,
    active: view?.active,
    blocked: !!choice || dialogOpen || state.preserving,
    findTarget: (origin) => {
      if (origin === 'tree') return treeElement.current;
      if (!target) return undefined;
      return origin === 'strip'
        ? tabs.current?.findTab(target.path)
        : monaco.current?.focusTarget();
    },
    fallback: () => (sidebarHidden ? null : explorerActionsButton.current) ?? root.current,
  });
  useEffect(
    () => () => {
      const prompt = actions.getSnapshot().closePrompt;
      if (prompt) actions.answerClose(prompt.id, 'cancel');
    },
    [actions],
  );
  /** Closes a checkout's tabs, then opens the file left active, unless the app moved on. */
  const closeFiles = (paths: string[]) =>
    Effect.gen(function* () {
      const left = shown.current;
      if (!checkout) return false;
      const closed = yield* actions.close(paths.map((path) => ({ checkout, path })));
      const next = actions.getSnapshot().recovery;
      const path = next.views.get(checkout.checkoutId)?.active;
      const shownStill = left && !(yield* Deferred.isDone(left));
      if (closed && path && next.openCheckoutIds.includes(checkout.checkoutId) && shownStill)
        yield* actions
          .open({ checkout, path })
          .pipe(Effect.raceFirst(Effect.as(Deferred.await(left), false)));
      return closed;
    });
  function openPicker(mode: PickerMode) {
    if (state.preserving || dialog) return;
    setPicker({ mode, text: mode === 'find' ? readSelection(root.current) : '' });
  }
  const openPickedFile: PickerOpenFile = (target, at) =>
    Effect.tap(actions.open(target, { view: 'file', intent: 'keep' }), (opened) =>
      Effect.sync(() => {
        if (!opened) return;
        if (at) setReveal({ id: ++reveals.current, key: fileKey(target), ...at });
        onShowEditor?.();
      }),
    );
  /** Switches the explorer's view, asking the app to show the explorer when it is hidden. */
  function showPanel(next: ExplorerPanel) {
    setPanel(next);
    if (sidebarHidden) onShowSidebar?.();
  }
  function revealActive() {
    if (!checkout || !target) return;
    showPanel('files');
    run(
      Effect.andThen(
        actions.reveal(target),
        Effect.sync(() => {
          const current = actions.getSnapshot().recovery;
          if (
            current.openCheckoutIds.includes(checkout.checkoutId) &&
            current.checkouts.some((item) => checkoutKey(item) === checkoutKey(checkout))
          )
            setAnchorReset((value) => value + 1);
        }),
      ),
    );
  }
  /** Types a new entry's name in the focused folder, the focused file's folder, or the root. */
  function requestCreate(kind: TreeCreateRequest['kind']) {
    if (!checkout || !view) return;
    showPanel('files');
    setCreateRequest({
      checkout: { ...checkout },
      kind,
      parent: findCreateFolder(state.listings, checkoutKey(checkout), view.tree.focus),
      id: ++createRequests.current,
    });
  }
  const entries = (): PickerEntry[] => [
    ...(pickerEntries?.() ?? []),
    ...(checkout
      ? listEditorCommands({
          git,
          hasActiveFile: !!target,
          onShowEditor,
          showFiles: () => showPanel('files'),
          showChanges: () => showPanel('git'),
          revealActive,
          reopen: () => run(actions.reopen(checkout)),
          refresh: () => run(actions.refresh(checkout)),
        })
      : []),
  ];
  const keys = useWorkbenchKeys({
    actions,
    state,
    checkout,
    view,
    target,
    focus,
    findOrigin: (element) => findFocusOrigin(element, tabs.current?.element() ?? null),
    openPicker,
    showPanel,
    closeFiles,
  });
  useImperativeHandle(ref, () => ({
    importFiles,
    openPicker,
    keyDown: keys.keyDown,
    keyUp: keys.keyUp,
  }));
  const paste = useExplorerPaste({
    actions,
    checkout,
    focus: view?.tree.focus,
    panel,
    listings: state.listings,
    fileClipboard,
    importFiles,
    explorerElement,
    treeElement,
    onPasted: () => setAnchorReset((value) => value + 1),
  });
  const explorer =
    checkout && view ? (
      <Explorer
        ref={explorerElement}
        actionsButtonRef={explorerActionsButton}
        actions={actions}
        checkout={checkout}
        menu={{
          actions,
          checkout,
          preserving: state.preserving,
          hasActiveFile: !!target,
          hideIgnoredFiles: !!view.tree.hideIgnoredFiles,
          following,
          followed: followedFiles,
          moveUndo,
          canRequestMutation,
          requestCreate,
          importFiles,
          revealActive,
          openGoTo: () => openPicker('goto'),
          menuButton: explorerActionsButton,
        }}
        git={git}
        panel={panel}
        onPanel={setPanel}
        changedFiles={changedFiles}
        onPaste={paste.pasteFiles}>
        {panel === 'files' ? (
          <FilesTree
            ref={treeElement}
            key={checkoutKey(checkout)}
            actions={actions}
            state={state}
            checkout={checkout}
            active={view.active}
            anchorReset={anchorReset}
            visible={visible}
            follow={following && !sidebarHidden && visible}
            followed={followedFiles}
            dialogOpen={!!(dialogOpen || choice || state.mutating)}
            canRequestMutation={canRequestMutation}
            requestMutation={mutations.requestMutation}
            runMutation={moveUndo.run}
            undoLabel={moveUndo.labelFor(checkout)}
            onMoved={(moves) => moveUndo.record(checkout, moves)}
            onUndo={(finalFocus) => moveUndo.undo(checkout, finalFocus)}
            createRequest={createRequest}
            onCreateRequestTaken={() => setCreateRequest(null)}
            mentionInChat={mentionInChat}
            clipboard={fileClipboard.clipboard}
            onClipboard={(paths, mode) => fileClipboard.put(checkout, paths, mode)}
            onCancelCut={() => fileClipboard.cancelCut(checkout)}
            canPasteInto={(folder) => fileClipboard.canPaste(checkout, folder)}
            onPaste={(folder) => paste.pasteInto(checkout, folder)}
          />
        ) : (
          <ChangesView
            actions={actions}
            state={state}
            checkout={checkout}
            target={target}
            mode={mode}
          />
        )}
      </Explorer>
    ) : null;
  const editor =
    checkout && view ? (
      <EditorArea
        actions={actions}
        state={state}
        checkout={checkout}
        view={view}
        target={target}
        buffer={buffer}
        mode={mode}
        git={git}
        visible={visible}
        showBreadcrumbs={showBreadcrumbs}
        shortcuts={shortcuts}
        reveal={reveal}
        onRevealed={() => setReveal(undefined)}
        tabsRef={tabs}
        monacoRef={monaco}
        closeFiles={closeFiles}
        withFocus={focus.withFocus}
      />
    ) : null;
  return (
    <div
      ref={root}
      {...stylex.props(workbench.document, styles.root)}
      aria-label="Moonbase editor"
      tabIndex={-1}
      onPointerDownCapture={focus.captureInteraction}
      onKeyDownCapture={keys.keyDown}
      onFocusCapture={(event) => {
        const from = event.relatedTarget;
        // Programmatic entry from outside chrome is newer input; keep automatic menu/dialog return eligible.
        if (
          from instanceof Element &&
          from.isConnected &&
          from !== document.body &&
          !event.currentTarget.contains(from) &&
          !from.closest('[role="menu"], [role="dialog"]')
        )
          focus.captureInteraction();
      }}
      onKeyUp={keys.keyUp}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) keys.dismissRecent();
      }}>
      <div {...stylex.props(styles.panel)}>
        {!state.ready && (
          <p role="status" {...stylex.props(styles.empty)}>
            Load editor recovery before opening a checkout.
          </p>
        )}
        {!checkout && state.ready && (
          <p {...stylex.props(styles.empty)}>
            Open a checkout to browse files and edit. Unsaved changes belong to this editor
            instance.
          </p>
        )}
        {checkout &&
          view &&
          (renderLayout ? (
            renderLayout({ explorer, editor })
          ) : (
            <SidebarLayout
              width={state.recovery.sidebarWidth}
              hidden={sidebarHidden}
              resize={(width) => actions.resizeSidebar(width)}
              // Hiding the explorer while focus is in it hands focus to the editor.
              onHiddenWithFocus={() => (monaco.current?.focusTarget() ?? root.current)?.focus()}
              explorer={explorer}
              editor={editor}
              trailing={trailing}
            />
          ))}
      </div>
      <StatusMessages
        actions={actions}
        state={state}
        retryRecovery={() =>
          run(
            focus.withFocus(
              Effect.as(actions.flush(), true),
              focus.pendingOrigin ?? 'editor',
              true,
            ),
          )
        }
      />
      {picker && (
        <Picker
          actions={actions}
          checkout={checkout}
          entries={entries}
          request={picker}
          openFile={openPickedFile}
          close={() => setPicker(null)}
          editorFocus={() => monaco.current?.focusTarget() ?? null}
        />
      )}
      {dialog && (
        <Mutation
          actions={actions}
          action={dialog.action}
          close={mutations.closeDialog}
          finalFocus={dialog.finalFocus}
          onApplied={() => moveUndo.clear(dialog.action.checkout)}
        />
      )}
      {mutations.confirmation}
      {choice && (
        <ClosePrompt prompt={choice} answer={(value) => actions.answerClose(choice.id, value)} />
      )}
      {keys.recent && <RecentTabsList recent={keys.recent} />}
    </div>
  );
});

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 200,
    height: '100%',
    minWidth: 0,
    overflow: 'hidden',
  },
  panel: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  empty: { margin: space.xl, maxWidth: 540, color: colors.secondary, fontSize: type.body },
});
