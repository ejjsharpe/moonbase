import { useContext, useMemo } from 'react';
import { Context, Effect, Exit } from 'effect';
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
import type { WorkbenchEditor } from './workbench-editor.ts';

/** What an action that was interrupted (the editor closing, say) rejects with: never reported. */
const interrupted = Symbol('interrupted');

/**
 * The editor actions the workbench's views call, each running one service Effect on the root's
 * runner, and the editor's state read where a callback needs it now. Presentation glue: the
 * services decide everything.
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
  /** Runs `effect`, rejecting with its failure, or `interrupted` when it was interrupted. */
  const call = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    editor.run(Effect.exit(effect)).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      const reason = exit.cause.reasons.find((item) => item._tag === 'Fail' || item._tag === 'Die');
      if (reason?._tag === 'Fail') throw reason.error;
      throw reason?._tag === 'Die' ? reason.defect : interrupted;
    });
  const report = (error: unknown) => {
    if (error !== interrupted) void editor.run(alerts.report(error));
  };
  /** Runs an action whose outcome only matters if it fails, which is reported. */
  const fire = <A, E>(effect: Effect.Effect<A, E>) => {
    void call(effect).catch(report);
  };
  const getSnapshot = (): EditorSnapshot => registry.get(atoms.snapshot);
  return {
    editor,
    /** This editor's identity, which drags and Monaco models carry. */
    clientId: session.clientId,
    getSnapshot,
    report,
    clearErrors: () => fire(alerts.clear),
    buffer: (target: FileTarget) =>
      getSnapshot().buffers.find((buffer) => fileKey(buffer.target) === fileKey(target)),
    open: (target: FileTarget, options?: OpenOptions) => call(tabs.open(target, options)),
    navigate: (checkout: CheckoutTarget, direction: 1 | -1) =>
      call(tabs.navigate(checkout, direction)),
    /** Sends typed text; rejects when the editor refuses it, so the view can restore its text. */
    edit: (target: FileTarget, text: string) => call(tabs.edit(target, text)),
    keepOpen: (target: FileTarget) => fire(tabs.keepOpen(target)),
    reorder: (checkout: CheckoutTarget, from: string, to: number) =>
      fire(tabs.reorder(checkout, from, to)),
    position: (
      target: FileTarget,
      mode: FileView | `${FileView}:original`,
      position: EditorPosition,
    ) => fire(tabs.position(target, mode, position)),
    tree: (checkout: CheckoutTarget, patch: Partial<CheckoutTree>) =>
      fire(tree.tree(checkout, patch)),
    resizeSidebar: (width: number) => fire(tree.resizeSidebar(width)),
    setFollowActiveFile: (follow: boolean) => fire(tree.setFollowActiveFile(follow)),
    list: (checkout: CheckoutTarget, path?: string) => call(tree.list(checkout, path)),
    reveal: (target: FileTarget, options?: RevealOptions) => call(tree.reveal(target, options)),
    refresh: (checkout: CheckoutTarget) => call(tree.refresh(checkout)),
    save: (target: FileTarget, overwrite?: boolean) => call(saves.save(target, overwrite)),
    reload: (target: FileTarget) => call(saves.reload(target)),
    cancelConflict: (target: FileTarget) => fire(saves.cancelConflict(target)),
    close: (targets: FileTarget[]) => call(preservation.close(targets)),
    closeCheckout: (checkout: CheckoutTarget) => call(preservation.closeCheckout(checkout)),
    answerClose: (promptId: string, choice: CloseChoice) =>
      fire(preservation.answerClose(promptId, choice)),
    reopen: (checkout: CheckoutTarget) => call(preservation.reopen(checkout)),
    openCheckout: (root: string) => call(checkouts.openCheckout(root)),
    selectCheckout: (target: CheckoutTarget) => call(checkouts.selectCheckout(target)),
    listWorktrees: (checkout: CheckoutTarget) => call(checkouts.listWorktrees(checkout)),
    createWorktree: (input: CommandInput<'createWorktree'>) =>
      call(checkouts.createWorktree(input)),
    initializeRepository: (checkout: CheckoutTarget) =>
      call(checkouts.initializeRepository(checkout)),
    flush: () => call(recovery.flush),
    resolveOperation: (id: string, operationClientId?: string) =>
      call(mutations.resolve(id, operationClientId)),
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
    mutate: (action: MutationAction, options: MutationOptions) =>
      call(mutations.mutate(action, options)),
    answerMutation: (promptId: string, replace: boolean) =>
      fire(mutations.answer(promptId, replace)),
    /** Runs any other editor Effect on the root's runner. */
    call,
  };
}
export type EditorActions = ReturnType<typeof makeEditorActions>;

/** The editor's actions, made once per editor and registry. */
export function useEditorActions(editor: WorkbenchEditor): EditorActions {
  const registry = useContext(RegistryContext);
  return useMemo(() => makeEditorActions(editor, registry), [editor, registry]);
}
