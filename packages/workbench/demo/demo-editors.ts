import { Context, Effect, Exit, Layer, Scope, type ManagedRuntime } from 'effect';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import {
  WorkspaceService,
  type WorkspaceServiceShape,
} from '@moonbase/contracts/workspace-service';
import type {
  CheckoutTarget,
  CommandInput,
  CommandOutput,
  FileTarget,
  WorkspaceCommand,
} from '@moonbase/contracts/workspace';
import {
  editorLayer,
  EditorLoader,
  EditorMutations,
  EditorTabs,
  EditorTree,
  type EditorFailure,
  type EditorServices,
  type OpenOptions,
  type OperationInput,
  type RevealOptions,
} from '@moonbase/application/editor';
import {
  makeEditorActions,
  makeWorkbenchEditor,
  type WorkbenchPlatformShape,
} from '../src/index.ts';

// The demos' composition root: one runtime over the faux workspace, editors built on it, and the
// Promise handles the browser specs drive and intercept. Feature packages construct no runtimes.

/** The workspace as specs call it: each command, replaceable to observe or delay it. */
export type DemoClient = {
  command<K extends WorkspaceCommand>(
    name: K,
    input: CommandInput<K>,
    options?: { signal?: AbortSignal },
  ): Promise<CommandOutput<K>>;
};
type Command = (input: unknown) => Effect.Effect<unknown, unknown>;

/** A Promise client over `base`, run on the demo's runtime. */
export const makeDemoClient = (
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  base: WorkspaceServiceShape,
): DemoClient => ({
  command: (name, input, options) =>
    runtime.runPromise(
      (base[name] as unknown as Command)(input) as Effect.Effect<CommandOutput<typeof name>>,
      options,
    ),
});

/** The workspace an editor sees: its commands go through `client()`, its watches to `base`. */
export function makeDemoWorkspace(
  base: WorkspaceServiceShape,
  client: () => DemoClient,
): WorkspaceServiceShape {
  const shape: Record<string, unknown> = { ...base };
  for (const name of Object.keys(base))
    if (name !== 'watch' && name !== 'watchRecovery')
      shape[name] = (input: unknown) =>
        Effect.tryPromise({
          try: (signal) => client().command(name as WorkspaceCommand, input as never, { signal }),
          catch: (error) => error,
        });
  return shape as WorkspaceServiceShape;
}

/** The actions as specs call them: each one returning an Effect runs it to a Promise. */
type PromisedActions<T> = {
  [K in keyof T]: T[K] extends (...args: infer P) => Effect.Effect<infer A, infer _E, never>
    ? (...args: P) => Promise<A>
    : T[K];
};
const promiseActions = <T extends object>(
  actions: T,
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
): PromisedActions<T> =>
  Object.fromEntries(
    Object.entries(actions).map(([name, value]) => [
      name,
      typeof value === 'function'
        ? (...args: unknown[]) => {
            const result = (value as (...a: unknown[]) => unknown)(...args);
            return Effect.isEffect(result) ? run(result as Effect.Effect<unknown>) : result;
          }
        : value,
    ]),
  ) as PromisedActions<T>;

/**
 * Builds and loads one editor in its own scope on `runtime`. Its handle is the workbench's actions
 * plus `mutate` (dispatch an operation as given), and its `open` and `reveal`, which the
 * workbench's own calls go through, so specs can replace them.
 */
export async function buildDemoEditor(
  runtime: ManagedRuntime.ManagedRuntime<never, never>,
  registry: AtomRegistry.AtomRegistry,
  workspace: WorkspaceServiceShape,
  clientId: string,
  platform: WorkbenchPlatformShape = {},
) {
  const scope = await runtime.runPromise(Scope.make());
  const built = await runtime.runPromise(
    Layer.buildWithScope(
      editorLayer({ clientId }).pipe(Layer.provide(Layer.succeed(WorkspaceService, workspace))),
      scope,
    ),
  );
  await runtime.runPromise(Context.get(built, EditorLoader).load);
  const tabs = Context.get(built, EditorTabs),
    tree = Context.get(built, EditorTree);
  const hooks = {
    open: (target: FileTarget, options?: OpenOptions) => run(tabs.open(target, options)),
    reveal: (target: FileTarget, options?: RevealOptions) => run(tree.reveal(target, options)),
  };
  const promised = <A>(effect: () => Promise<A>) =>
    Effect.tryPromise({ try: effect, catch: (error) => error as EditorFailure });
  const context: Context.Context<EditorServices> = built.pipe(
    Context.add(EditorTabs, {
      ...tabs,
      open: (target, options) => promised(() => handle.open(target, options)),
    }),
    Context.add(EditorTree, {
      ...tree,
      reveal: (target, options) => promised(() => handle.reveal(target, options)),
    }),
  );
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  const editor = makeWorkbenchEditor(context, platform);
  const actions = makeEditorActions(editor, registry);
  const handle = {
    ...promiseActions(actions, run),
    ...hooks,
    clientId,
    mutate: (input: OperationInput) => run(Context.get(built, EditorMutations).dispatch(input)),
    reconcileRecovery: () => run(Context.get(built, EditorMutations).reconcile),
    inspect: (checkout: CheckoutTarget, paths: string[]) =>
      run(Context.get(built, EditorMutations).inspect(checkout, paths)),
    /** Closes the editor's scope, releasing it. */
    release: () => runtime.runPromise(Scope.close(scope, Exit.void)),
  };
  return { editor, handle };
}
export type DemoEditor = Awaited<ReturnType<typeof buildDemoEditor>>['handle'];
export const makeDemoRegistry = () => AtomRegistry.make();
