import type {
  CheckoutTarget,
  CheckoutView,
  FileTarget,
  FileView,
  EditorPosition,
  DirectoryListing,
  CommandInput,
  CommandOutput,
  OperationResult,
  WorkspaceOperation,
} from '@moonbase/contracts/workspace';
import type {
  EditorSnapshot,
  EditorLookup,
  EditorMutation,
  MutationAction,
} from '@moonbase/application/editor';
import { Effect, Exit, Scope, type ManagedRuntime } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import {
  makeEditorController,
  makeEditorModel,
  type EditorDependencies,
  type EditorController,
  type EditorBuffer,
  type CloseChoice,
} from '@moonbase/application/editor';

/** A test composition owns its acquisition scope and injected runtime. */
export async function acquireEditor<R, E extends ApplicationError>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
  dependencies: EditorDependencies,
) {
  const scope = Scope.makeUnsafe();
  const model = await runApplicationEffect(
    runtime,
    makeEditorModel(dependencies).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  const controller = makeEditorController(runtime, model);
  const dispose = controller.dispose.bind(controller);
  let completion: Promise<void> | undefined;
  controller.dispose = () =>
    (completion ??= dispose().finally(() =>
      runApplicationEffect(runtime, Scope.close(scope, Exit.void)),
    ));
  return controller;
}

/** Drive the same exact-prompt snapshot/action contract as the workbench. */
export function answering<A>(
  controller: EditorController,
  action: () => Promise<A>,
  choose: (buffer: Readonly<EditorBuffer>) => Promise<CloseChoice>,
) {
  const answered = new Set<string>();
  const off = controller.subscribe(() => {
    const prompt = controller.getSnapshot().closePrompt;
    if (!prompt || answered.has(prompt.id)) return;
    answered.add(prompt.id);
    void choose(prompt.buffer).then((choice) => controller.answerClose(prompt.id, choice));
  });
  return action().finally(off);
}

// Frozen public consumer from the pre-extraction controller declaration.
type ExpectedEditorController = {
  readonly clientId: string;
  readonly instanceId: `${string}-${string}-${string}-${string}-${string}`;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => EditorSnapshot;
  report: (error: unknown) => void;
  clearErrors(): void;
  load(): Promise<void>;
  openCheckout(root: string): Promise<CheckoutTarget>;
  listWorktrees(checkout: CheckoutTarget): Promise<CommandOutput<'listWorktrees'>>;
  createWorktree(input: CommandInput<'createWorktree'>): Promise<CheckoutTarget>;
  selectCheckout(target: CheckoutTarget): Promise<boolean>;
  resolveRecoveryPublication(): Promise<boolean>;
  flush(): Promise<void>;
  buffer(target: FileTarget): Readonly<EditorBuffer> | undefined;
  edit(target: FileTarget, text: string): void;
  keepOpen(target: FileTarget): void;
  open(
    target: FileTarget,
    options?: { view?: FileView; intent?: 'preview' | 'keep'; current?: () => boolean },
  ): Promise<boolean>;
  save(target: FileTarget, overwrite?: boolean): Promise<boolean>;
  reload(target: FileTarget): Promise<boolean>;
  cancelConflict(target: FileTarget): void;
  position(
    target: FileTarget,
    mode: FileView | `${FileView}:original`,
    position: EditorPosition,
  ): void;
  reorder(checkout: CheckoutTarget, from: string, to: number): void;
  navigate(checkout: CheckoutTarget, direction: 1 | -1): Promise<boolean>;
  answerClose(promptId: string, choice: CloseChoice): void;
  close(targets: FileTarget[]): Promise<boolean>;
  closeCheckout(checkout: CheckoutTarget): Promise<boolean>;
  prepareQuit(): Promise<boolean>;
  reopen(checkout: CheckoutTarget): Promise<boolean>;
  tree(checkout: CheckoutTarget, patch: Partial<CheckoutView['tree']>): void;
  resizeSidebar(width: number): void;
  list(checkout: CheckoutTarget, path?: string): Promise<DirectoryListing>;
  reveal(target: FileTarget, showIgnored?: boolean): Promise<void>;
  lookup(checkout: CheckoutTarget, query: string): Promise<CommandOutput<'lookupFiles'>>;
  refresh(checkout: CheckoutTarget): Promise<void>;
  createLookup(): EditorLookup;
  createMutation(action: MutationAction): EditorMutation;
  inspect(checkout: CheckoutTarget, paths: string[]): Promise<CommandOutput<'inspectEntries'>>;
  mutate(
    input: Omit<WorkspaceOperation, 'clientId' | 'id'> & { id?: string },
  ): Promise<OperationResult>;
  resolveOperation(id: string, operationClientId?: string): Promise<OperationResult | null>;
  reconcileRecovery(): Promise<void>;
  dispose(): Promise<void>;
};
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type EditorControllerCompatibility = Assert<
  Equal<EditorController, ExpectedEditorController>
>;
