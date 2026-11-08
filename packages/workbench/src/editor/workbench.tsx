import {
  Picker,
  pickerCommand,
  pickerMode,
  type PickerEntry,
  type PickerMode,
  type PickerOpenFile,
  type PickerRequest,
} from './picker.tsx';
import { FilesTree, type TreeCreateRequest } from './files-tree.tsx';
import { findCreateFolder } from './files-tree-rows.ts';
import { gitStatusMarks } from './files-tree-status.ts';
import { Mutation, type Action } from './mutation.tsx';
import { useMutationRunner } from './mutation-runner.tsx';
import { useMoveUndo } from './move-undo.ts';
import { maxDraggedEntries } from './files-tree-drop.ts';
import { formatKeys } from './file-commands.ts';
import { Popup } from './popup.tsx';
import {
  forwardRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import { Tabs } from '@base-ui/react/tabs';
import { ContextMenu as Menu } from '@base-ui/react/context-menu';
import { controls } from '@moonbase/ui/controls';
import { fileTypeMark, gitStatusHues, gitStatusUI } from '@moonbase/ui/files';
import { workbench } from '@moonbase/ui/workbench';
import { overlays } from '@moonbase/ui/overlays';
import type { CheckoutTarget, FileView } from '@moonbase/contracts/workspace';
import {
  checkoutKey,
  fileKey,
  readOwn,
  type CloseChoice,
  type EditorController,
  type EditorSnapshot,
} from '@moonbase/application/editor';
import { MonacoView, readSelection, type EditorReveal } from './monaco-view.tsx';
import { WorktreeSwitcher } from './worktree-switcher.tsx';
import { ExplorerMenu, type ExplorerAction } from './explorer-menu.tsx';
import { CheatSheet, editorShortcuts, type Shortcut } from './cheat-sheet.tsx';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { styles } from './styles.ts';
import { Icon } from './icon.tsx';

type FocusOrigin = 'editor' | 'strip' | 'tree';
const focusOrigin = (element: HTMLElement): FocusOrigin => {
  if (element.closest('[role="tree"]')) return 'tree';
  if (element.closest('[aria-label="Open files"]')) return 'strip';
  return 'editor';
};

export type WorkbenchHandle = {
  importFiles(checkout: CheckoutTarget, references: string[]): void;
  /** Opens ⌘P's picker; `find` starts from the editor's selected text. */
  openPicker(mode: PickerMode): void;
  keyDown(event: KeyboardEvent): void;
  keyUp(event: KeyboardEvent): void;
};
export type WorkbenchProps = {
  controller: EditorController;
  checkout: CheckoutTarget | undefined;
  visible?: boolean;
  renderLayout?: (views: { explorer: ReactNode; editor: ReactNode }) => ReactNode;
  /** App content placed after the editor in the default layout, such as a docked panel. */
  trailing?: ReactNode;
  /** Chats, projects and app commands the picker offers beside this checkout's files, read while it is open. */
  pickerEntries?: () => PickerEntry[];
  /** Called when the picker opens a file or runs an editor command, to bring the editor into view. */
  onShowEditor?: () => void;
  /** Native/user-authorized selection belongs to the shell. A renderer path alone grants no access. */
  selectNativeImports?: (checkout: CheckoutTarget) => Promise<string[]>;
  selectClipboardImports?: (checkout: CheckoutTarget) => Promise<string[]>;
  /**
   * Approves files dropped from the OS onto the files tree, one reference per file in order, for
   * importing into the folder dropped on. Without it, such drops pass through to the app.
   */
  selectDroppedImports?: (checkout: CheckoutTarget, files: File[]) => Promise<string[]>;
  /** Copies a checkout's paths to the clipboard, joined by newlines: absolute, or as `relative`. */
  copyPaths?: (checkout: CheckoutTarget, paths: string[], relative: boolean) => Promise<void>;
  /** Shows a checkout's file or folder in the OS file manager. */
  revealPath?: (checkout: CheckoutTarget, path: string) => Promise<void>;
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
// A conflicted path opens as its file, where its conflict markers are resolved; one both sides
// deleted has no file to open, and is resolved in Git.
const changeAreas = [
  { area: 'conflicted', label: 'Conflicts', view: 'file' },
  { area: 'staged', label: 'Staged', view: 'staged' },
  { area: 'unstaged', label: 'Changes', view: 'unstaged' },
  { area: 'untracked', label: 'Untracked', view: 'untracked' },
] as const;

export const Workbench = forwardRef<WorkbenchHandle, WorkbenchProps>(function Workbench(
  {
    controller,
    checkout: project,
    visible = true,
    renderLayout,
    trailing,
    pickerEntries,
    onShowEditor,
    selectNativeImports,
    selectClipboardImports,
    selectDroppedImports,
    copyPaths,
    revealPath,
    mentionInChat,
    showBreadcrumbs = true,
    sidebarHidden = false,
    onShowSidebar,
    shortcuts = [],
  },
  ref,
) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const openCheckouts = state.recovery.checkouts.filter((target) =>
    state.recovery.openCheckoutIds.includes(target.checkoutId),
  );
  const checkout =
    project && openCheckouts.find((target) => checkoutKey(target) === checkoutKey(project));
  const selected = checkout && readOwn(state.recovery.views, checkout.checkoutId),
    target = checkout && selected?.active ? { checkout, path: selected.active } : undefined;
  const buffer =
    target && state.buffers.find((buffer) => fileKey(buffer.target) === fileKey(target));
  const mode = (target && readOwn(selected?.fileViews, target.path)) || 'file';
  const changes = (checkout && state.git[checkoutKey(checkout)]?.changes) || [];
  // Git lists a file once per area it changed in (staged and unstaged, say); count it once.
  const changedFiles = new Set(changes.map((change) => change.path)).size;
  const breadcrumbs =
    checkout && selected?.active
      ? [
          checkout.root.split('/').filter(Boolean).at(-1) || checkout.root,
          ...selected.active.split('/'),
        ]
      : [];
  const [anchorReset, setAnchorReset] = useState(0);
  const [picker, setPicker] = useState<PickerRequest | null>(null),
    [reveal, setReveal] = useState<EditorReveal>(),
    [panel, setPanel] = useState('files'),
    [action, updateAction] = useState<Action | null>(null);
  const lookup = !!picker;
  const actionRef = useRef<Action | null>(null),
    lookupRef = useRef(lookup),
    projectRef = useRef(project);
  const [mutationFinalFocus, setMutationFinalFocus] = useState<
    (() => boolean | HTMLElement | null) | undefined
  >(undefined);
  // The explorer's "…" New File/Folder, started by the files tree.
  const [createRequest, setCreateRequest] = useState<TreeCreateRequest | null>(null),
    createRequests = useRef(0);
  useLayoutEffect(() => {
    lookupRef.current = lookup;
    projectRef.current = project;
  }, [lookup, project]);
  function setAction(value: Action | null, finalFocus?: () => boolean | HTMLElement | null) {
    if (value) setMutationFinalFocus(() => finalFocus);
    actionRef.current = value;
    updateAction(value);
  }
  // Rename, Duplicate and New File/Folder run directly from the tree, asking only to replace.
  const mutations = useMutationRunner(controller, (value) =>
    canRequestMutation(value, controller.getSnapshot(), !!(actionRef.current || lookupRef.current)),
  );
  function canRequestMutation(
    value: Action,
    snapshot: EditorSnapshot = state,
    blocked = !!(action || lookup || mutations.running),
  ) {
    return (
      snapshot.ready &&
      !snapshot.disposed &&
      !snapshot.preserving &&
      !snapshot.closePrompt &&
      !blocked &&
      snapshot.recovery.openCheckoutIds.includes(value.checkout.checkoutId) &&
      snapshot.recovery.checkouts.some(
        (target) => checkoutKey(target) === checkoutKey(value.checkout),
      ) &&
      // Several entries move or copy into one folder, as a drag from the tree does.
      (!(value.kind === 'move' || value.kind === 'copy') ||
        (value.paths.length >= 1 && value.paths.length <= maxDraggedEntries)) &&
      (value.kind !== 'trash' || value.paths.length > 0)
    );
  }
  // Moves and renames made from the tree, one per checkout, for Undo; any other file operation
  // from the tree or a dialog forgets the checkout's.
  const moveUndo = useMoveUndo(controller, mutations.runMutation, openCheckouts);
  function requestMutation(value: Action, finalFocus?: () => boolean | HTMLElement | null) {
    if (
      !canRequestMutation(
        value,
        controller.getSnapshot(),
        !!(actionRef.current || lookupRef.current || mutations.isRunning()),
      )
    ) {
      controller.report(
        new Error(
          'File action unavailable. Check the selection and finish the current editor dialog or preservation.',
        ),
      );
      return;
    }
    setAction({ ...value, checkout: { ...value.checkout }, paths: [...value.paths] }, finalFocus);
  }
  const choice = state.closePrompt;
  const [recent, setRecent] = useState<{
      paths: string[];
      index: number;
      origin: FocusOrigin;
    } | null>(null),
    dragged = useRef<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{
    checkout: CheckoutTarget;
    path: string;
    origin: FocusOrigin;
    from: Element | null;
    interaction: number;
  } | null>(null);
  const focusInteraction = useRef(0);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const sidebarElement = useRef<HTMLElement>(null),
    focusInSidebar = useRef(false);
  // Hiding the explorer while focus is in it hands focus to the editor rather than the page.
  useLayoutEffect(() => {
    if (!sidebarHidden || !focusInSidebar.current) return;
    focusInSidebar.current = false;
    (
      root.current?.querySelector<HTMLElement>(
        'section[aria-label="Main editor"] .monaco-editor textarea[role="textbox"]',
      ) ?? root.current
    )?.focus();
  }, [sidebarHidden]);
  // Buffer tabs slide open and shut; the rest slide along to close the gap.
  const reducedMotion = useReducedMotion();
  const tabMotion = { duration: reducedMotion ? 0 : 0.18, ease: [0.2, 0.8, 0.2, 1] as const };
  const menuCapture = useRef<string[]>([]),
    menuKeyboard = useRef(false),
    root = useRef<HTMLDivElement>(null),
    explorerActionsButton = useRef<HTMLButtonElement>(null);
  const targetIdentity = target && fileKey(target);
  const targetPath = target?.path;
  const checkoutIdentity = checkout && checkoutKey(checkout);
  useLayoutEffect(() => {
    if (!focusRequest || choice || lookup || action || state.preserving) return;
    const focused = document.activeElement;
    const focusMoved =
      focused !== null &&
      focused !== document.body &&
      focused !== focusRequest.from &&
      !root.current?.contains(focused);
    if (
      !focusMoved &&
      focusRequest.interaction === focusInteraction.current &&
      root.current?.getClientRects().length &&
      checkoutIdentity &&
      checkoutIdentity === checkoutKey(focusRequest.checkout) &&
      selected?.active === focusRequest.path
    ) {
      let element: HTMLElement | undefined | null;
      if (focusRequest.origin === 'tree')
        element = root.current.querySelector<HTMLElement>('[role="tree"][aria-label="Files"]');
      else if (targetIdentity) {
        const strip = focusRequest.origin === 'strip';
        const elements = root.current.querySelectorAll<HTMLElement>(
          strip
            ? '[aria-label="Open files"] [role="tab"]'
            : '.monaco-editor textarea[role="textbox"]',
        );
        element = Array.from(elements).find(
          (element) => element.getAttribute('aria-label') === targetPath + (strip ? '' : ' editor'),
        );
      }
      (element ?? (sidebarHidden ? null : explorerActionsButton.current) ?? root.current)?.focus();
    }
    // oxlint-disable-next-line react/set-state-in-effect -- Consume this one-shot DOM focus request after the target has rendered.
    setFocusRequest(null);
  }, [
    focusRequest,
    sidebarHidden,
    targetIdentity,
    targetPath,
    checkoutIdentity,
    selected?.active,
    choice,
    lookup,
    action,
    state.preserving,
  ]);
  const withFocus = (opening: Promise<boolean>, origin: FocusOrigin, restore = false) => {
    const from = document.activeElement;
    const interaction = focusInteraction.current;
    const focus = () => {
      const next = controller.getSnapshot().recovery;
      if (checkout && next.openCheckoutIds.includes(checkout.checkoutId))
        setFocusRequest({
          checkout,
          path: readOwn(next.views, checkout.checkoutId)!.active,
          origin,
          from,
          interaction,
        });
    };
    return opening.then(
      (success) => {
        if (success || restore) focus();
      },
      (error) => {
        if (restore) focus();
        throw error;
      },
    );
  };
  function answer(value: CloseChoice) {
    if (choice) controller.answerClose(choice.id, value);
  }
  useEffect(
    () => () => {
      const prompt = controller.getSnapshot().closePrompt;
      if (prompt) controller.answerClose(prompt.id, 'cancel');
    },
    [controller],
  );
  const importFiles = useCallback(
    (checkout: CheckoutTarget, references: string[]) => {
      if (!references.length) return;
      const snapshot = controller.getSnapshot();
      if (snapshot.preserving || actionRef.current || snapshot.closePrompt || lookupRef.current) {
        controller.report(
          new Error('Finish the current editor dialog or preservation before importing files.'),
        );
        return;
      }
      if (
        !snapshot.recovery.openCheckoutIds.includes(checkout.checkoutId) ||
        !snapshot.recovery.checkouts.some((item) => checkoutKey(item) === checkoutKey(checkout))
      ) {
        controller.report(new Error('Open the exact import checkout before importing files.'));
        return;
      }
      setAction({
        checkout: { ...checkout },
        kind: 'import',
        paths: [],
        nativeReferences: [...references],
      });
    },
    [controller],
  );
  const run = (work: Promise<unknown>) => {
    void work.catch(controller.report);
  };
  const closeFiles = async (paths: string[]) => {
    if (!checkout) return false;
    const closed = await controller.close(paths.map((path) => ({ checkout, path })));
    const next = controller.getSnapshot().recovery;
    const path = readOwn(next.views, checkout.checkoutId)?.active;
    const current = () =>
      !!root.current &&
      !!projectRef.current &&
      checkoutKey(projectRef.current) === checkoutKey(checkout);
    if (closed && path && next.openCheckoutIds.includes(checkout.checkoutId) && current())
      await controller.open({ checkout, path }, { current });
    return closed;
  };
  const reveals = useRef(0);
  function openPicker(mode: PickerMode) {
    if (state.preserving || actionRef.current) return;
    setPicker({ mode, text: mode === 'find' ? readSelection(root.current) : '' });
  }
  const openPickedFile: PickerOpenFile = async (target, at, current) => {
    const opened = await controller.open(target, {
      view: 'file',
      intent: 'keep',
      current: () =>
        current() &&
        controller.getSnapshot().recovery.openCheckoutIds.includes(target.checkout.checkoutId) &&
        controller
          .getSnapshot()
          .recovery.checkouts.some((item) => checkoutKey(item) === checkoutKey(target.checkout)),
    });
    if (opened) {
      if (at) setReveal({ id: ++reveals.current, key: fileKey(target), ...at });
      onShowEditor?.();
    }
    return opened;
  };
  const editorCommand = (
    id: string,
    label: string,
    shortcut: string | undefined,
    run: () => void,
  ) => ({
    id,
    kind: 'command' as const,
    label,
    shortcut,
    run: () => {
      onShowEditor?.();
      run();
    },
  });
  const entries = (): PickerEntry[] => [
    ...(pickerEntries?.() ?? []),
    ...(checkout
      ? [
          editorCommand('show-files', 'Show Files', '⌘⇧E', () => showPanel('files')),
          editorCommand('show-changes', 'Show Changes', '⌘⇧G', () => showPanel('git')),
          ...(target
            ? [editorCommand('reveal-active-file', 'Reveal Active File', undefined, revealActive)]
            : []),
          editorCommand('reopen-file', 'Reopen closed file', '⌘⇧T', () =>
            run(controller.reopen(checkout)),
          ),
          editorCommand('refresh-files', 'Refresh files', undefined, () =>
            run(controller.refresh(checkout)),
          ),
        ]
      : []),
  ];
  const actions: WorkbenchHandle = {
    importFiles,
    openPicker,
    keyDown(event: KeyboardEvent) {
      captureFocusInteraction();
      const element = event.target as HTMLElement;
      if (
        element.closest('[role="dialog"], [role="menu"]') ||
        (element.closest('input,textarea,select,[contenteditable=true]') &&
          !element.closest('.monaco-editor'))
      )
        return;
      if (!checkout || !selected || state.preserving) return;
      const key = event.key.toLowerCase(),
        command = event.metaKey || event.ctrlKey,
        picking = pickerMode(event, pickerCommand(event));
      if (command && key === 's' && !event.altKey && !(event.ctrlKey && event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        if (target) run(controller.save(target));
      } else if (picking) {
        event.preventDefault();
        event.stopPropagation();
        openPicker(picking);
      } else if (
        event.metaKey &&
        event.shiftKey &&
        (key === 'e' || (key === 'g' && !element.closest('.monaco-editor')))
      ) {
        // ⇧⌘G is Find Previous in the editor and its find widget, so it switches views only from
        // elsewhere; the editor has no ⇧⌘E of its own.
        event.preventDefault();
        event.stopPropagation();
        showPanel(key === 'e' ? 'files' : 'git');
      } else if (event.metaKey && key === 'w' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        if (target) run(withFocus(closeFiles([target.path]), focusOrigin(element), true));
      } else if (event.metaKey && event.shiftKey && key === 't') {
        event.preventDefault();
        event.stopPropagation();
        run(withFocus(controller.reopen(checkout), focusOrigin(element), true));
      } else if (event.metaKey && event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        run(
          withFocus(
            controller.navigate(checkout, event.key === 'ArrowRight' ? 1 : -1),
            focusOrigin(element),
          ),
        );
      } else if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        const paths =
          recent?.paths ??
          [
            ...new Set([
              selected.active,
              ...state.recovery.recentFiles
                .filter((file) => checkoutKey(file.checkout) === checkoutKey(checkout))
                .map((file) => file.path),
              ...selected.openFiles,
            ]),
          ].filter((path) => selected.openFiles.includes(path));
        if (paths.length)
          setRecent({
            paths,
            index: ((recent?.index ?? 0) + (event.shiftKey ? paths.length - 1 : 1)) % paths.length,
            origin: recent?.origin ?? focusOrigin(element),
          });
      } else if (event.key === 'Escape' && recent) {
        event.preventDefault();
        setRecent(null);
      }
    },
    keyUp(event: KeyboardEvent) {
      if (event.key === 'Control' && recent && checkout) {
        event.stopPropagation();
        const path = recent.paths[recent.index];
        setRecent(null);
        run(withFocus(controller.open({ checkout, path }), recent.origin));
      }
    },
  };
  useImperativeHandle(ref, () => actions);
  function captureFocusInteraction() {
    if (!controller.getSnapshot().closePrompt) focusInteraction.current++;
  }
  useEffect(() => {
    const document = root.current?.ownerDocument;
    const onExternalTab = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === 'Tab' &&
        !root.current?.contains(event.target as Node) &&
        !controller.getSnapshot().closePrompt
      )
        focusInteraction.current++;
    };
    document?.addEventListener('keydown', onExternalTab, true);
    return () => document?.removeEventListener('keydown', onExternalTab, true);
  }, [controller]);
  function pasteFiles(event: React.ClipboardEvent | React.KeyboardEvent) {
    if (
      !checkout ||
      !selectClipboardImports ||
      !event.currentTarget.contains(event.target as Node) ||
      (event.target as HTMLElement).closest('[role="menu"], [role="dialog"]') ||
      (event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const captured = { ...checkout };
    run(selectClipboardImports(captured).then((references) => importFiles(captured, references)));
  }
  function revealActive() {
    if (!checkout || !target) return;
    showPanel('files');
    run(
      controller.reveal(target).then(() => {
        const current = controller.getSnapshot().recovery;
        if (
          current.openCheckoutIds.includes(checkout.checkoutId) &&
          current.checkouts.some((item) => checkoutKey(item) === checkoutKey(checkout))
        )
          setAnchorReset((value) => value + 1);
      }),
    );
  }
  /** Switches the explorer's view, asking the app to show the explorer when it is hidden. */
  function showPanel(next: 'files' | 'git') {
    setPanel(next);
    if (sidebarHidden) onShowSidebar?.();
  }
  /** Types a new entry's name in the focused folder, the focused file's folder, or the root. */
  const requestCreate = (kind: TreeCreateRequest['kind']) => {
    if (!checkout || !selected) return;
    showPanel('files');
    setCreateRequest({
      checkout: { ...checkout },
      kind,
      parent: findCreateFolder(state.listings, checkoutKey(checkout), selected.tree.focus),
      id: ++createRequests.current,
    });
  };
  const explorerActions: ExplorerAction[] = checkout
    ? [
        {
          label: 'New File…',
          icon: 'newFile',
          disabled: !canRequestMutation({ checkout, kind: 'create-file', paths: [] }),
          movesFocus: true,
          run: () => requestCreate('create-file'),
        },
        {
          label: 'New Folder…',
          icon: 'newFolder',
          disabled: !canRequestMutation({ checkout, kind: 'create-directory', paths: [] }),
          movesFocus: true,
          run: () => requestCreate('create-directory'),
        },
        ...(selectNativeImports
          ? [
              {
                label: 'Import Files…',
                icon: 'import',
                disabled: state.preserving,
                run: () =>
                  run(
                    (async () => {
                      const target = { ...checkout };
                      importFiles(target, await selectNativeImports(target));
                    })(),
                  ),
              } satisfies ExplorerAction,
            ]
          : []),
        {
          label: moveUndo.labelFor(checkout) ?? 'Undo Move',
          icon: 'undo',
          keys: formatKeys('Meta+Z'),
          disabled:
            !moveUndo.labelFor(checkout) ||
            !canRequestMutation({ checkout, kind: 'move', paths: moveUndo.movedPaths(checkout) }),
          run: () => void moveUndo.undo(checkout, () => explorerActionsButton.current ?? false),
        },
        'separator',
        {
          label: 'Collapse All Folders',
          icon: 'collapseAll',
          run: () => controller.tree(checkout, { expanded: [] }),
        },
        { label: 'Reveal Active File', icon: 'reveal', disabled: !target, run: revealActive },
        'separator',
        { label: 'Go to File…', icon: 'search', keys: '⌘P', run: () => openPicker('goto') },
        { label: 'Refresh', icon: 'refresh', run: () => run(controller.refresh(checkout)) },
      ]
    : [];
  const explorer =
    checkout && selected ? (
      <div
        {...stylex.props(styles.panel)}
        onPaste={pasteFiles}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v')
            pasteFiles(event);
        }}>
        <div {...stylex.props(workbench.pane, workbench.explorerPane)}>
          <div {...stylex.props(workbench.explorerHeader)}>
            <WorktreeSwitcher controller={controller} checkout={checkout} run={run} />
            <ExplorerMenu actions={explorerActions} triggerRef={explorerActionsButton} />
          </div>
          <div {...stylex.props(workbench.viewNav)}>
            <div role="group" aria-label="Sidebar view" {...stylex.props(workbench.viewSwitch)}>
              <Button
                title="Files · ⇧⌘E"
                {...stylex.props(
                  controls.button,
                  workbench.viewButton,
                  panel === 'files' && workbench.activeView,
                )}
                aria-pressed={panel === 'files'}
                onClick={() => setPanel('files')}>
                Files
              </Button>
              <Button
                title={`${changedFiles} changed · ⇧⌘G`}
                {...stylex.props(
                  controls.button,
                  workbench.viewButton,
                  panel === 'git' && workbench.activeView,
                )}
                aria-pressed={panel === 'git'}
                onClick={() => setPanel('git')}>
                Changes
                {changedFiles > 0 && (
                  <span aria-hidden="true" {...stylex.props(workbench.changeCount)}>
                    {changedFiles}
                  </span>
                )}
              </Button>
            </div>
          </div>
          {panel === 'files' ? (
            <>
              <FilesTree
                key={checkoutKey(checkout)}
                controller={controller}
                state={state}
                checkout={checkout}
                active={selected.active}
                anchorReset={anchorReset}
                visible={visible}
                dialogOpen={!!(action || choice || lookup || mutations.running)}
                canRequestMutation={canRequestMutation}
                requestMutation={requestMutation}
                runMutation={moveUndo.run}
                undoLabel={moveUndo.labelFor(checkout)}
                onMoved={(moves) => moveUndo.record(checkout, moves)}
                onUndo={(finalFocus) => moveUndo.undo(checkout, finalFocus)}
                createRequest={createRequest}
                onCreateRequestTaken={() => setCreateRequest(null)}
                copyPaths={copyPaths}
                revealPath={revealPath}
                mentionInChat={mentionInChat}
                selectDroppedImports={selectDroppedImports}
              />
            </>
          ) : (
            <>
              {state.git[checkoutKey(checkout)]?.error && (
                <p role="status" {...stylex.props(controls.alert)}>
                  {state.git[checkoutKey(checkout)].error}
                </p>
              )}
              {state.git[checkoutKey(checkout)] && !changes.length && (
                <p role="status" {...stylex.props(workbench.noChanges)}>
                  No changes
                </p>
              )}
              {changeAreas.map(({ area, label, view }) => {
                const listed = changes.filter((change) => change.area === area);
                if (!listed.length) return null;
                return (
                  <section key={area} aria-label={label}>
                    <h2 {...stylex.props(workbench.changeHeading)}>
                      {label}
                      <span {...stylex.props(workbench.changeHeadingCount)}>{listed.length}</span>
                    </h2>
                    <ul {...stylex.props(controls.list)}>
                      {listed.map((change) => {
                        const active = target?.path === change.path && mode === view;
                        const mark = gitStatusMarks[change.kind];
                        const description = change.missing
                          ? mark.label + ', deleted on both sides'
                          : mark.label;
                        const folder = change.path.slice(0, change.path.lastIndexOf('/') + 1);
                        return (
                          <li key={change.path}>
                            <Button
                              aria-label={change.path}
                              aria-description={description}
                              aria-current={active || undefined}
                              disabled={change.missing}
                              title={
                                change.missing
                                  ? `${change.path} (deleted on both sides)`
                                  : change.path
                              }
                              {...stylex.props(
                                controls.button,
                                controls.listButton,
                                workbench.changeRow,
                                active && workbench.activeChange,
                              )}
                              onClick={() =>
                                run(
                                  controller.open(
                                    { checkout, path: change.path },
                                    { view, intent: 'preview' },
                                  ),
                                )
                              }>
                              <span
                                {...stylex.props(workbench.changeName, gitStatusHues[change.kind])}>
                                {change.path.slice(folder.length)}
                              </span>
                              {folder && (
                                <span {...stylex.props(workbench.changeFolder)}>{folder}</span>
                              )}
                              <span aria-hidden="true" {...stylex.props(gitStatusUI.slot)}>
                                <span
                                  data-git-status={change.kind}
                                  {...stylex.props(gitStatusUI.letter, gitStatusHues[change.kind])}>
                                  {mark.letter}
                                </span>
                              </span>
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </>
          )}
        </div>
      </div>
    ) : null;
  const editor =
    checkout && selected ? (
      <section
        data-title-anchor=""
        {...stylex.props(workbench.content, styles.panel)}
        aria-label="Main editor">
        <Tabs.Root
          value={selected.active}
          onValueChange={(value) => run(controller.open({ checkout, path: String(value) }))}
          {...stylex.props(styles.panel)}>
          <Tabs.List aria-label="Open files" {...stylex.props(workbench.fileTabs)}>
            {/* One group per checkout: switching swaps the list outright, since a tab's value is its
                path and an outgoing tab must never share it with an incoming one. */}
            <AnimatePresence key={checkoutKey(checkout)} initial={false}>
              {selected.openFiles.map((path) => {
                const file = { checkout, path },
                  current = state.buffers.find(
                    (buffer) => fileKey(buffer.target) === fileKey(file),
                  ),
                  dirty = current && current.text !== current.disk.text;
                const fileView = readOwn(selected.fileViews, path) || 'file';
                // The file's name, then as much of its folder as tells it from other open tabs.
                const parts = path.split('/');
                const label = parts.at(-1)!;
                let hint = '';
                for (let count = 1; count <= parts.length; count++) {
                  const tail = parts.slice(-count).join('/');
                  if (
                    !selected.openFiles.some(
                      (other) =>
                        other !== path && other.split('/').slice(-count).join('/') === tail,
                    )
                  ) {
                    hint = parts.slice(-count, -1).join('/');
                    break;
                  }
                }
                const mark = fileTypeMark(path);
                return (
                  <Menu.Root
                    key={fileKey(file)}
                    disabled={state.preserving}
                    onOpenChange={(open) => {
                      if (open) menuCapture.current = [...selected.openFiles];
                      else menuKeyboard.current = false;
                    }}>
                    <Menu.Trigger
                      render={
                        <motion.span
                          layout="position"
                          initial={{ opacity: 0, width: 0 }}
                          animate={{ opacity: 1, width: 'auto' }}
                          exit={{ opacity: 0, width: 0, pointerEvents: 'none' }}
                          transition={tabMotion}
                        />
                      }
                      onKeyDown={(event) => {
                        if (
                          event.key === 'ContextMenu' ||
                          (event.shiftKey && event.key === 'F10')
                        ) {
                          event.preventDefault();
                          menuKeyboard.current = true;
                          const bounds = event.currentTarget.getBoundingClientRect();
                          event.currentTarget.dispatchEvent(
                            new MouseEvent('contextmenu', {
                              bubbles: true,
                              cancelable: true,
                              clientX: bounds.left,
                              clientY: bounds.bottom,
                            }),
                          );
                        }
                      }}
                      {...stylex.props(
                        stylex.defaultMarker(),
                        workbench.fileTab,
                        selected.active === path && workbench.activeFileTab,
                      )}
                      onDragOver={(event) => {
                        if (dragged.current) event.preventDefault();
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (dragged.current)
                          controller.reorder(
                            checkout,
                            dragged.current,
                            selected.openFiles.indexOf(path),
                          );
                        dragged.current = null;
                      }}>
                      <Tabs.Tab
                        value={path}
                        aria-label={path}
                        title={`${checkout.hostId} · ${checkout.root}/${path}`}
                        aria-description={
                          [selected.preview === path && 'Preview', dirty && 'Unsaved']
                            .filter(Boolean)
                            .join(', ') || undefined
                        }
                        draggable={!state.preserving}
                        onDragStart={(event) => {
                          dragged.current = path;
                          event.dataTransfer.setData('text/plain', path);
                        }}
                        onDragEnd={() => {
                          dragged.current = null;
                        }}
                        onDoubleClick={() => controller.keepOpen(file)}
                        {...stylex.props(
                          controls.button,
                          workbench.tabButton,
                          workbench.fileTabButton,
                          selected.preview === path && workbench.preview,
                        )}>
                        {mark ? (
                          <span aria-hidden="true" {...stylex.props(mark.style)}>
                            {mark.label}
                          </span>
                        ) : (
                          <span {...stylex.props(controls.icon)}>
                            <Icon name="file" />
                          </span>
                        )}
                        <span {...stylex.props(controls.truncate)}>{label}</span>
                        {hint && (
                          <span aria-hidden="true" {...stylex.props(workbench.fileTabHint)}>
                            {hint}
                          </span>
                        )}
                      </Tabs.Tab>
                      <Button
                        {...stylex.props(
                          controls.button,
                          controls.iconButton,
                          workbench.tabClose,
                          workbench.fileTabClose,
                          workbench.revealTabClose,
                          (selected.active === path || dirty) && workbench.visibleTabClose,
                        )}
                        aria-label={`Close ${path}`}
                        disabled={state.preserving}
                        onClick={() => run(closeFiles([path]))}>
                        {dirty ? (
                          <>
                            <span aria-hidden="true" {...stylex.props(workbench.unsavedDot)} />
                            <span {...stylex.props(workbench.unsavedClose)}>
                              <Icon name="close" />
                            </span>
                          </>
                        ) : (
                          <Icon name="close" />
                        )}
                      </Button>
                    </Menu.Trigger>
                    <Menu.Portal>
                      <Menu.Positioner {...stylex.props(overlays.positioner)}>
                        <Menu.Popup
                          onFocus={(event) => {
                            if (menuKeyboard.current) {
                              menuKeyboard.current = false;
                              event.currentTarget
                                .querySelector<HTMLElement>('[role="menuitem"]')
                                ?.focus();
                            }
                          }}
                          {...stylex.props(overlays.popup, overlays.options)}>
                          <Menu.Item
                            {...stylex.props(overlays.option)}
                            onClick={() => controller.keepOpen(file)}>
                            Keep Open
                          </Menu.Item>
                          {(
                            ['Close', 'Close Others', 'Close to the Right', 'Close All'] as const
                          ).map((label) => (
                            <Menu.Item
                              key={label}
                              {...stylex.props(overlays.option)}
                              onClick={() => {
                                let paths;
                                if (label === 'Close') {
                                  paths = [file.path];
                                } else if (label === 'Close Others') {
                                  paths = menuCapture.current.filter((path) => path !== file.path);
                                } else if (label === 'Close to the Right') {
                                  paths = menuCapture.current.slice(
                                    menuCapture.current.indexOf(file.path) + 1,
                                  );
                                } else {
                                  paths = menuCapture.current;
                                }
                                run(withFocus(closeFiles(paths), 'strip', true));
                              }}>
                              {label}
                            </Menu.Item>
                          ))}
                          <Menu.Item
                            {...stylex.props(overlays.option)}
                            onClick={() =>
                              controller.reorder(
                                checkout,
                                file.path,
                                selected.openFiles.indexOf(file.path) - 1,
                              )
                            }>
                            Move tab left
                          </Menu.Item>
                          <Menu.Item
                            {...stylex.props(overlays.option)}
                            onClick={() =>
                              controller.reorder(
                                checkout,
                                file.path,
                                selected.openFiles.indexOf(file.path) + 1,
                              )
                            }>
                            Move tab right
                          </Menu.Item>
                          <Menu.Item
                            {...stylex.props(overlays.option)}
                            disabled={!current || current.saving || state.preserving}
                            onClick={() => run(controller.save(file))}>
                            {current?.pendingSave ? 'Retry Save' : 'Save'}
                          </Menu.Item>
                          <Menu.SubmenuRoot>
                            <Menu.SubmenuTrigger {...stylex.props(overlays.option)}>
                              File view <Icon name="chevronRight" />
                            </Menu.SubmenuTrigger>
                            <Menu.Portal>
                              <Menu.Positioner {...stylex.props(overlays.positioner)}>
                                <Menu.Popup {...stylex.props(overlays.popup, overlays.options)}>
                                  <Menu.RadioGroup
                                    aria-label="File view"
                                    value={fileView}
                                    onValueChange={(view: FileView) =>
                                      run(controller.open(file, { view }))
                                    }>
                                    {(['file', 'staged', 'unstaged', 'untracked'] as const).map(
                                      (view) => (
                                        <Menu.RadioItem
                                          key={view}
                                          value={view}
                                          closeOnClick
                                          {...stylex.props(
                                            overlays.option,
                                            fileView === view && workbench.fileSelected,
                                          )}>
                                          {view === 'file' ? 'File' : view}
                                        </Menu.RadioItem>
                                      ),
                                    )}
                                    {(current?.conflict || fileView === 'conflict') && (
                                      <Menu.RadioItem
                                        value="conflict"
                                        closeOnClick
                                        {...stylex.props(
                                          overlays.option,
                                          fileView === 'conflict' && workbench.fileSelected,
                                        )}>
                                        Save conflict
                                      </Menu.RadioItem>
                                    )}
                                  </Menu.RadioGroup>
                                </Menu.Popup>
                              </Menu.Positioner>
                            </Menu.Portal>
                          </Menu.SubmenuRoot>
                          <Menu.Item
                            {...stylex.props(overlays.option)}
                            onClick={() => run(controller.reopen(checkout))}>
                            Reopen Closed Files
                          </Menu.Item>
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.Root>
                );
              })}
            </AnimatePresence>
          </Tabs.List>
          <div {...stylex.props(workbench.pane, workbench.canvasPane)}>
            {showBreadcrumbs && !!breadcrumbs.length && (
              <nav
                aria-label="File breadcrumbs"
                title={`${checkout.root}/${selected.active}`}
                {...stylex.props(workbench.breadcrumbs)}>
                <ol {...stylex.props(workbench.breadcrumbList)}>
                  {breadcrumbs.map((part, index) => (
                    <li
                      key={index}
                      aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
                      {...stylex.props(
                        workbench.breadcrumb,
                        index === breadcrumbs.length - 1 && workbench.currentBreadcrumb,
                      )}>
                      {index > 0 && (
                        <span aria-hidden="true" {...stylex.props(workbench.breadcrumbSeparator)}>
                          /
                        </span>
                      )}
                      <span {...stylex.props(controls.truncate)} title={part}>
                        {part}
                        {index === breadcrumbs.length - 1 &&
                        buffer &&
                        buffer.text !== buffer.disk.text
                          ? ' · Unsaved'
                          : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            {buffer?.pendingSave && !buffer.saving && target && (
              <p role="status" {...stylex.props(controls.status)}>
                Save result unconfirmed. Your edits are retained.{' '}
                <Button
                  {...stylex.props(controls.button)}
                  disabled={state.preserving}
                  onClick={() => run(controller.save(target))}>
                  Retry Save
                </Button>
              </p>
            )}
            {buffer?.conflict && target && (
              <div role="alert" {...stylex.props(controls.alert, workbench.conflict)}>
                <p>{target.path} changed on disk. Your edits are retained.</p>
                <div {...stylex.props(styles.toolbar)}>
                  <Button
                    {...stylex.props(controls.button)}
                    onClick={() => run(controller.open(target, { view: 'conflict' }))}>
                    Compare
                  </Button>
                  <Button
                    {...stylex.props(controls.button)}
                    onClick={() => run(controller.save(target, true))}>
                    Overwrite observed version
                  </Button>
                  <Button
                    {...stylex.props(controls.button)}
                    onClick={() => run(controller.reload(target))}>
                    Reload
                  </Button>
                  <Button
                    {...stylex.props(controls.button)}
                    onClick={() => controller.cancelConflict(target)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {!target && <CheatSheet shortcuts={[...editorShortcuts, ...shortcuts]} />}
            {target && !buffer && !state.comparisons[fileKey(target)] && (
              <p role="status" {...stylex.props(controls.alert)}>
                File unavailable; retained tab and recovery references remain.{' '}
                <Button
                  {...stylex.props(controls.button)}
                  onClick={() => run(controller.open(target))}>
                  Retry file
                </Button>
              </p>
            )}
            <MonacoView
              controller={controller}
              state={state}
              target={target}
              mode={mode}
              visible={visible}
              reveal={reveal}
              onRevealed={() => setReveal(undefined)}
            />
          </div>
        </Tabs.Root>
      </section>
    ) : null;
  return (
    <div
      ref={root}
      {...stylex.props(workbench.document, styles.root)}
      aria-label="Moonbase editor"
      tabIndex={-1}
      onPointerDownCapture={captureFocusInteraction}
      onKeyDownCapture={actions.keyDown}
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
          captureFocusInteraction();
      }}
      onKeyUp={actions.keyUp}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setRecent(null);
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
          selected &&
          (renderLayout ? (
            renderLayout({ explorer, editor })
          ) : (
            <div {...stylex.props(styles.tabPanel, !!trailing && workbench.withTrailing)}>
              <div {...stylex.props(workbench.sidebarLayout(state.recovery.sidebarWidth))}>
                <div
                  {...stylex.props(
                    workbench.workspace,
                    sidebarHidden && workbench.workspaceSolo,
                    resizingSidebar && workbench.workspaceStill,
                  )}>
                  {!sidebarHidden && (
                    <div
                      role="separator"
                      tabIndex={0}
                      aria-label="Resize sidebar"
                      aria-orientation="vertical"
                      aria-valuemin={190}
                      aria-valuemax={380}
                      aria-valuenow={state.recovery.sidebarWidth}
                      {...stylex.props(workbench.sidebarResize)}
                      onKeyDown={(event) => {
                        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                          event.preventDefault();
                          let width =
                            state.recovery.sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10);
                          if (event.key === 'Home') width = 190;
                          else if (event.key === 'End') width = 380;
                          controller.resizeSidebar(width);
                        }
                      }}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setResizingSidebar(true);
                      }}
                      onLostPointerCapture={() => setResizingSidebar(false)}
                      onPointerMove={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId))
                          controller.resizeSidebar(
                            event.clientX -
                              event.currentTarget.parentElement!.getBoundingClientRect().left,
                          );
                      }}
                      onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId))
                          event.currentTarget.releasePointerCapture(event.pointerId);
                      }}
                    />
                  )}
                  {/* Kept while hidden, so it slides closed with its contents. */}
                  <aside
                    ref={sidebarElement}
                    onFocusCapture={() => (focusInSidebar.current = true)}
                    onBlurCapture={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget))
                        focusInSidebar.current = false;
                    }}
                    inert={sidebarHidden}
                    {...stylex.props(workbench.sidebar, sidebarHidden && workbench.sidebarClosed)}
                    aria-label="Editor sidebar">
                    {explorer}
                  </aside>
                  {editor}
                </div>
              </div>
              {trailing}
            </div>
          ))}
      </div>
      {!!state.errors.length && (
        <div role="alert" {...stylex.props(controls.status, controls.alert)}>
          {state.errors.at(-1)}{' '}
          <Button {...stylex.props(controls.button)} onClick={() => controller.clearErrors()}>
            Dismiss error
          </Button>
        </div>
      )}
      {state.publication && (
        <p role="status" {...stylex.props(controls.status)}>
          Recovery publication PENDING/UNCERTAIN ({state.publication.kind}):{' '}
          {state.publication.requestId}. Live work is retained.
          <Button
            {...stylex.props(controls.button)}
            onClick={() =>
              run(
                withFocus(
                  controller.resolveRecoveryPublication(),
                  focusRequest?.origin ?? 'editor',
                  true,
                ),
              )
            }>
            Resolve recovery publication
          </Button>
        </p>
      )}
      {state.operations.map((operation) => (
        <p
          key={JSON.stringify([operation.clientId, operation.id])}
          role="status"
          {...stylex.props(controls.status)}>
          {operation.kind}: {operation.outcome}. {operation.message}
          <Button
            {...stylex.props(controls.button)}
            onClick={() => run(controller.resolveOperation(operation.id, operation.clientId))}>
            Resolve operation status
          </Button>
        </p>
      ))}
      {picker && (
        <Picker
          controller={controller}
          checkout={checkout}
          discoveryRevision={state.discoveryRevision}
          entries={entries}
          request={picker}
          openFile={openPickedFile}
          close={() => setPicker(null)}
          editorFocus={() =>
            root.current?.querySelector<HTMLElement>('.monaco-editor textarea[role="textbox"]') ??
            null
          }
        />
      )}
      {action && (
        <Mutation
          controller={controller}
          action={action}
          close={() => setAction(null)}
          finalFocus={mutationFinalFocus}
          onApplied={() => moveUndo.clear(action.checkout)}
        />
      )}
      {mutations.confirmation}
      {choice && (
        <Popup title="Save changes before closing?" onClose={() => answer('cancel')}>
          <Dialog.Description>{choice.buffer.target.path} has unsaved changes.</Dialog.Description>
          <div {...stylex.props(styles.dialogActions)}>
            {(['save', 'discard', 'cancel'] as const).map((value) => (
              <Button key={value} {...stylex.props(controls.button)} onClick={() => answer(value)}>
                {value[0].toUpperCase() + value.slice(1)}
              </Button>
            ))}
          </div>
        </Popup>
      )}
      {recent && (
        <div role="listbox" aria-label="Recent tabs" {...stylex.props(overlays.recent)}>
          {recent.paths.map((path, index) => (
            <div
              key={path}
              role="option"
              aria-selected={recent.index === index}
              {...stylex.props(
                overlays.recentOption,
                recent.index === index && workbench.fileSelected,
              )}>
              {path}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
