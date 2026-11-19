import { useContext, useMemo } from 'react';
import { Context } from 'effect';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { RegistryContext } from '@effect/atom-react';
import type {
  CheckoutTarget,
  CheckoutTree,
  CommandInput,
  EditorPosition,
  FileTarget,
  FileView,
} from '@moonbase/contracts/workspace';
import {
  EditorAlerts,
  EditorCheckouts,
  EditorMutations,
  EditorPreservation,
  EditorSaves,
  EditorTabs,
  EditorTree,
  RecoverySync,
  EditorSession,
  admitsMutation,
  fileKey,
  type CloseChoice,
  type EditorSnapshot,
  type MutationAction,
  type MutationOptions,
  type OpenOptions,
  type RevealOptions,
} from '@moonbase/application/editor';
import type { WorkbenchEditor, WorkbenchWork } from './workbench-editor.ts';

/**
 * The editor actions the workbench's views call: each returns its service Effect, for the view to
 * run through an atom function (`useEditorTask`) or start as the editor's own work (`start`).
 * Actions whose outcome only matters if it fails start themselves. Presentation glue: the services
 * decide everything.
 */
export function makeEditorActions(editor: WorkbenchEditor, registry: AtomRegistry.AtomRegistry) {
  const { context, atoms } = editor;
  const tabs = Context.get(context, EditorTabs),
    tree = Context.get(context, EditorTree),
    saves = Context.get(context, EditorSaves),
    preservation = Context.get(context, EditorPreservation),
    checkouts = Context.get(context, EditorCheckouts),
    mutations = Context.get(context, EditorMutations),
    recovery = Context.get(context, RecoverySync),
    alerts = Context.get(context, EditorAlerts),
    session = Context.get(context, EditorSession);
  /**
   * Starts work the editor owns, which outlives the view that asked for it, reporting its
   * failure.
   */
  const start = (work: WorkbenchWork) => registry.set(editor.work, work);
  const getSnapshot = (): EditorSnapshot => registry.get(atoms.snapshot);
  return {
    editor,
    /** This editor's identity, which drags and Monaco models carry. */
    clientId: session.clientId,
    getSnapshot,
    /** The app's platform capabilities, which views offer only when supplied. */
    platform: editor.platform,
    start,
    /** Shows a failure, or Moonbase's own note, in the editor's alerts. */
    report: (error: unknown) => start(alerts.report(error)),
    clearErrors: () => start(alerts.clear),
    buffer: (target: FileTarget) =>
      getSnapshot().buffers.find((buffer) => fileKey(buffer.target) === fileKey(target)),
    open: (target: FileTarget, options?: OpenOptions) => tabs.open(target, options),
    navigate: (checkout: CheckoutTarget, direction: 1 | -1) => tabs.navigate(checkout, direction),
    /** Sends typed text; fails when the editor refuses it, so the view can restore its text. */
    edit: (target: FileTarget, text: string) => tabs.edit(target, text),
    keepOpen: (target: FileTarget) => start(tabs.keepOpen(target)),
    reorder: (checkout: CheckoutTarget, from: string, to: number) =>
      start(tabs.reorder(checkout, from, to)),
    position: (
      target: FileTarget,
      mode: FileView | `${FileView}:original`,
      position: EditorPosition,
    ) => start(tabs.position(target, mode, position)),
    tree: (checkout: CheckoutTarget, patch: Partial<CheckoutTree>) =>
      start(tree.tree(checkout, patch)),
    resizeSidebar: (width: number) => start(tree.resizeSidebar(width)),
    setFollowActiveFile: (follow: boolean) => start(tree.setFollowActiveFile(follow)),
    list: (checkout: CheckoutTarget, path?: string) => tree.list(checkout, path),
    reveal: (target: FileTarget, options?: RevealOptions) => tree.reveal(target, options),
    refresh: (checkout: CheckoutTarget) => tree.refresh(checkout),
    save: (target: FileTarget, overwrite?: boolean) => saves.save(target, overwrite),
    reload: (target: FileTarget) => saves.reload(target),
    cancelConflict: (target: FileTarget) => start(saves.cancelConflict(target)),
    close: (targets: FileTarget[]) => preservation.close(targets),
    closeCheckout: (checkout: CheckoutTarget) => preservation.closeCheckout(checkout),
    answerClose: (promptId: string, choice: CloseChoice) =>
      start(preservation.answerClose(promptId, choice)),
    reopen: (checkout: CheckoutTarget) => preservation.reopen(checkout),
    openCheckout: (root: string) => checkouts.openCheckout(root),
    selectCheckout: (target: CheckoutTarget) => checkouts.selectCheckout(target),
    listWorktrees: (checkout: CheckoutTarget) => checkouts.listWorktrees(checkout),
    createWorktree: (input: CommandInput<'createWorktree'>) => checkouts.createWorktree(input),
    initializeRepository: (checkout: CheckoutTarget) => checkouts.initializeRepository(checkout),
    flush: () => recovery.flush,
    resolveOperation: (id: string, operationClientId?: string) =>
      mutations.resolve(id, operationClientId),
    /** The mutation gate, read now: whether `mutate` would admit `action`. */
    admitsMutation: (action: MutationAction) =>
      admitsMutation(
        {
          ...registry.get(atoms.session),
          prompting: false,
          mutating: registry.get(atoms.mutation).mutating,
          recovery: registry.get(atoms.views).recovery,
        },
        action,
      ),
    mutate: (action: MutationAction, options: MutationOptions) => mutations.mutate(action, options),
    answerMutation: (promptId: string, replace: boolean) =>
      start(mutations.answer(promptId, replace)),
  };
}
export type EditorActions = ReturnType<typeof makeEditorActions>;

/** The editor's actions, made once per editor and registry. */
export function useEditorActions(editor: WorkbenchEditor): EditorActions {
  const registry = useContext(RegistryContext);
  return useMemo(() => makeEditorActions(editor, registry), [editor, registry]);
}
