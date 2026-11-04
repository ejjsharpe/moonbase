import { FileLookup } from './file-lookup.tsx';
import { FilesTree } from './files-tree.tsx';
import { Mutation, type Action } from './mutation.tsx';
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
import { Menu } from '@base-ui/react/menu';
import { controls } from '@moonbase/ui/controls';
import { filesUI } from '@moonbase/ui/files';
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
import { MonacoView } from './monaco-view.tsx';
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
  keyDown(event: KeyboardEvent): void;
  keyUp(event: KeyboardEvent): void;
};
export type WorkbenchProps = {
  controller: EditorController;
  checkout: CheckoutTarget | undefined;
  visible?: boolean;
  renderLayout?: (views: { explorer: ReactNode; editor: ReactNode }) => ReactNode;
  /** Native/user-authorized selection belongs to the shell. A renderer path alone grants no access. */
  selectNativeImports?: (checkout: CheckoutTarget) => Promise<string[]>;
  selectClipboardImports?: (checkout: CheckoutTarget) => Promise<string[]>;
};
export const Workbench = forwardRef<WorkbenchHandle, WorkbenchProps>(function Workbench(
  {
    controller,
    checkout: project,
    visible = true,
    renderLayout,
    selectNativeImports,
    selectClipboardImports,
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
  const [anchorReset, setAnchorReset] = useState(0);
  const [lookup, setLookup] = useState(false),
    [panel, setPanel] = useState('files'),
    [action, updateAction] = useState<Action | null>(null);
  const actionRef = useRef<Action | null>(null),
    lookupRef = useRef(lookup),
    projectRef = useRef(project);
  const [mutationFinalFocus, setMutationFinalFocus] = useState<
    (() => boolean | HTMLElement | null) | undefined
  >(undefined);
  useLayoutEffect(() => {
    lookupRef.current = lookup;
    projectRef.current = project;
  }, [lookup, project]);
  function setAction(value: Action | null, finalFocus?: () => boolean | HTMLElement | null) {
    if (value) setMutationFinalFocus(() => finalFocus);
    actionRef.current = value;
    updateAction(value);
  }
  function canRequestMutation(
    value: Action,
    snapshot: EditorSnapshot = state,
    blocked = !!(action || lookup),
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
      (!(value.kind === 'move' || value.kind === 'copy') || value.paths.length === 1) &&
      (value.kind !== 'trash' || value.paths.length > 0)
    );
  }
  function requestMutation(value: Action, finalFocus?: () => boolean | HTMLElement | null) {
    if (
      !canRequestMutation(
        value,
        controller.getSnapshot(),
        !!(actionRef.current || lookupRef.current),
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
  } | null>(null);
  const menuCapture = useRef<string[]>([]),
    root = useRef<HTMLDivElement>(null),
    findFile = useRef<HTMLButtonElement>(null);
  const targetIdentity = target && fileKey(target);
  const targetPath = target?.path;
  const checkoutIdentity = checkout && checkoutKey(checkout);
  useLayoutEffect(() => {
    if (!focusRequest || choice || lookup || action || state.preserving) return;
    if (
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
      (element ?? findFile.current ?? root.current)?.focus();
    }
    // oxlint-disable-next-line react/set-state-in-effect -- Consume this one-shot DOM focus request after the target has rendered.
    setFocusRequest(null);
  }, [
    focusRequest,
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
    const focus = () => {
      const next = controller.getSnapshot().recovery;
      if (checkout && next.openCheckoutIds.includes(checkout.checkoutId))
        setFocusRequest({
          checkout,
          path: readOwn(next.views, checkout.checkoutId)!.active,
          origin,
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
  const actions: WorkbenchHandle = {
    importFiles,
    keyDown(event: KeyboardEvent) {
      const element = event.target as HTMLElement;
      if (
        element.closest('[role="dialog"], [role="menu"]') ||
        (element.closest('input,textarea,select,[contenteditable=true]') &&
          !element.closest('.monaco-editor'))
      )
        return;
      if (!checkout || !selected || state.preserving) return;
      const key = event.key.toLowerCase(),
        command = event.metaKey || event.ctrlKey;
      if (command && key === 's') {
        event.preventDefault();
        event.stopPropagation();
        if (target) run(controller.save(target));
      } else if (command && key === 'p' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        setLookup(true);
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
  const explorer =
    checkout && selected ? (
      <div
        {...stylex.props(styles.panel)}
        onPaste={pasteFiles}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v')
            pasteFiles(event);
        }}>
        <div {...stylex.props(workbench.viewNav)}>
          <Button
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
            {...stylex.props(
              controls.button,
              workbench.viewButton,
              panel === 'git' && workbench.activeView,
            )}
            aria-pressed={panel === 'git'}
            onClick={() => setPanel('git')}>
            Diff
          </Button>
          <Button
            ref={findFile}
            aria-label="Find file"
            title="Find file · ⌘P"
            {...stylex.props(controls.button, filesUI.iconButton)}
            onClick={() => setLookup(true)}>
            <Icon name="search" />
          </Button>
          <Button
            aria-label="Refresh"
            title="Refresh"
            {...stylex.props(controls.button, filesUI.iconButton)}
            onClick={() => run(controller.refresh(checkout))}>
            <Icon name="refresh" />
          </Button>
        </div>
        <p title={checkout.root} {...stylex.props(workbench.directory, styles.directory)}>
          {checkout.branch} · {checkout.root}
        </p>
        {panel === 'files' ? (
          <>
            <div {...stylex.props(filesUI.tools)}>
              {(['create-file', 'create-directory'] as const).map((kind) => (
                <Button
                  key={kind}
                  {...stylex.props(controls.button, filesUI.iconButton)}
                  aria-label={kind === 'create-file' ? 'New File' : 'New Folder'}
                  title={kind === 'create-file' ? 'New file' : 'New folder'}
                  disabled={!canRequestMutation({ checkout, kind, paths: [] })}
                  onClick={() => requestMutation({ checkout, kind, paths: [] })}>
                  <Icon name={kind === 'create-file' ? 'newFile' : 'newFolder'} />
                </Button>
              ))}

              {selectNativeImports && (
                <Button
                  {...stylex.props(controls.button, filesUI.iconButton)}
                  aria-label="Import files"
                  title="Import files"
                  disabled={state.preserving}
                  onClick={() =>
                    run(
                      (async () => {
                        const target = { ...checkout };
                        importFiles(target, await selectNativeImports(target));
                      })(),
                    )
                  }>
                  <Icon name="import" />
                </Button>
              )}
              <Button
                {...stylex.props(controls.button, filesUI.iconButton)}
                aria-label="Reveal Active File"
                title="Reveal active file"
                disabled={!target}
                onClick={() => {
                  if (target)
                    run(
                      controller.reveal(target).then(() => {
                        const current = controller.getSnapshot().recovery;
                        if (
                          current.openCheckoutIds.includes(checkout.checkoutId) &&
                          current.checkouts.some(
                            (item) => checkoutKey(item) === checkoutKey(checkout),
                          )
                        )
                          setAnchorReset((value) => value + 1);
                      }),
                    );
                }}>
                <Icon name="reveal" />
              </Button>
            </div>
            <FilesTree
              key={checkoutKey(checkout)}
              controller={controller}
              state={state}
              checkout={checkout}
              active={selected.active}
              anchorReset={anchorReset}
              visible={visible}
              dialogOpen={!!(action || choice || lookup)}
              canRequestMutation={canRequestMutation}
              requestMutation={requestMutation}
            />
          </>
        ) : (
          <>
            {state.git[checkoutKey(checkout)]?.error && (
              <p role="status" {...stylex.props(controls.alert)}>
                {state.git[checkoutKey(checkout)].error}
              </p>
            )}
            {(['staged', 'unstaged', 'untracked'] as const).map((area) => (
              <section key={area}>
                <h2 {...stylex.props(controls.heading)}>{area}</h2>
                <ul {...stylex.props(controls.list)}>
                  {state.git[checkoutKey(checkout)]?.changes
                    .filter((change) => change.area === area)
                    .map((change) => (
                      <li key={change.path}>
                        <Button
                          {...stylex.props(controls.button, controls.listButton)}
                          onClick={() =>
                            run(
                              controller.open(
                                { checkout, path: change.path },
                                { view: area, intent: 'preview' },
                              ),
                            )
                          }>
                          {change.path}
                        </Button>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    ) : null;
  const editor =
    checkout && selected ? (
      <section {...stylex.props(workbench.content, styles.panel)} aria-label="Main editor">
        <Tabs.Root
          value={selected.active}
          onValueChange={(value) => run(controller.open({ checkout, path: String(value) }))}
          {...stylex.props(styles.panel)}>
          <Tabs.List aria-label="Open files" {...stylex.props(workbench.fileTabs)}>
            {selected.openFiles.map((path) => {
              const file = { checkout, path },
                current = state.buffers.find((buffer) => fileKey(buffer.target) === fileKey(file)),
                dirty = current && current.text !== current.disk.text;
              const parts = path.split('/');
              let label = parts.at(-1)!;
              for (let count = 1; count <= parts.length; count++) {
                label = parts.slice(-count).join('/');
                if (
                  !selected.openFiles.some(
                    (other) => other !== path && other.split('/').slice(-count).join('/') === label,
                  )
                )
                  break;
              }
              return (
                <span
                  key={path}
                  {...stylex.props(workbench.fileTab)}
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
                      selected.active === path && workbench.fileSelected,
                      selected.preview === path && workbench.preview,
                      dirty && workbench.unsaved,
                    )}>
                    {label}
                  </Tabs.Tab>
                  <Button
                    {...stylex.props(controls.button, controls.iconButton)}
                    aria-label={`Close ${path}`}
                    disabled={state.preserving}
                    onClick={() => run(closeFiles([path]))}>
                    <Icon name="close" />
                  </Button>
                </span>
              );
            })}
          </Tabs.List>
          <div {...stylex.props(workbench.toolbar)}>
            <span {...stylex.props(workbench.toolbarLabel)}>
              {selected.active || 'No file selected'}
              {buffer && buffer.text !== buffer.disk.text ? ' · Unsaved' : ''}
            </span>
            {target && (
              <>
                <label>
                  File view{' '}
                  <select
                    aria-label="File view"
                    {...stylex.props(controls.field)}
                    value={mode}
                    onChange={(event) =>
                      run(
                        controller.open(target, {
                          view: event.target.value as FileView,
                        }),
                      )
                    }>
                    <option value="file">File</option>
                    {(['staged', 'unstaged', 'untracked'] as const).map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                    {(buffer?.conflict || mode === 'conflict') && (
                      <option value="conflict">Save conflict</option>
                    )}
                  </select>
                </label>
                <Button
                  {...stylex.props(controls.button)}
                  disabled={!buffer || buffer.saving || state.preserving}
                  onClick={() => run(controller.save(target))}>
                  {buffer?.pendingSave ? 'Retry Save' : 'Save'}
                </Button>
                {selected.preview === target.path && (
                  <Button
                    {...stylex.props(controls.button)}
                    onClick={() => controller.keepOpen(target)}>
                    Keep Open
                  </Button>
                )}
              </>
            )}
            <Menu.Root
              onOpenChange={(open) => {
                if (open) menuCapture.current = [...selected.openFiles];
              }}>
              <Menu.Trigger {...stylex.props(controls.button)}>Tab actions</Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner>
                  <Menu.Popup {...stylex.props(overlays.popup, overlays.options)}>
                    {target && (
                      <>
                        <Menu.Item
                          {...stylex.props(overlays.option)}
                          onClick={() => controller.keepOpen(target)}>
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
                                paths = [target.path];
                              } else if (label === 'Close Others') {
                                paths = menuCapture.current.filter((path) => path !== target.path);
                              } else if (label === 'Close to the Right') {
                                paths = menuCapture.current.slice(
                                  menuCapture.current.indexOf(target.path) + 1,
                                );
                              } else {
                                paths = menuCapture.current;
                              }
                              run(closeFiles(paths));
                            }}>
                            {label}
                          </Menu.Item>
                        ))}
                        <Menu.Item
                          {...stylex.props(overlays.option)}
                          onClick={() =>
                            controller.reorder(
                              checkout,
                              target.path,
                              selected.openFiles.indexOf(target.path) - 1,
                            )
                          }>
                          Move tab left
                        </Menu.Item>
                        <Menu.Item
                          {...stylex.props(overlays.option)}
                          onClick={() =>
                            controller.reorder(
                              checkout,
                              target.path,
                              selected.openFiles.indexOf(target.path) + 1,
                            )
                          }>
                          Move tab right
                        </Menu.Item>
                      </>
                    )}
                    <Menu.Item
                      {...stylex.props(overlays.option)}
                      onClick={() => run(controller.reopen(checkout))}>
                      Reopen Closed Files
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
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
          {!target && (
            <p {...stylex.props(styles.empty)}>
              Choose a file from Files or Find file. Save writes explicitly; typing retains a
              recovery draft.
            </p>
          )}
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
          />
        </Tabs.Root>
      </section>
    ) : null;
  return (
    <div
      ref={root}
      {...stylex.props(workbench.document, styles.root)}
      aria-label="Moonbase editor"
      tabIndex={-1}
      onKeyDownCapture={actions.keyDown}
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
            <div {...stylex.props(styles.tabPanel)}>
              <div {...stylex.props(workbench.sidebarLayout(state.recovery.sidebarWidth))}>
                <div {...stylex.props(workbench.workspace)}>
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
                      if (event.button === 0)
                        event.currentTarget.setPointerCapture(event.pointerId);
                    }}
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
                  <aside {...stylex.props(workbench.sidebar)} aria-label="Editor sidebar">
                    {explorer}
                  </aside>
                  {editor}
                </div>
              </div>
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
      {lookup && checkout && (
        <FileLookup
          controller={controller}
          state={state}
          checkout={checkout}
          close={() => setLookup(false)}
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
        />
      )}
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
