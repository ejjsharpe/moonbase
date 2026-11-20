import { TestClock } from 'effect/testing';
import * as Atom from 'effect/reactivity/Atom';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import {
  Cause,
  Context,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Queue,
  Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import { CancelledError } from '@moonbase/contracts/errors';
import { WorkspaceUnavailableError } from '@moonbase/contracts/workspace-host-errors';
import {
  WorkspaceService,
  type WorkspacePortError,
  type WorkspaceServiceShape,
} from '@moonbase/contracts/workspace-service';
import { isWorkspaceError, type WorkspaceError } from '@moonbase/contracts/workspace-errors';
import type { RecoveryOutline } from '@moonbase/contracts/recovery';
import type {
  CheckoutTarget,
  CheckoutTree,
  CommandInput,
  CommandOutput,
  EditorPosition,
  FileTarget,
  FileView,
  WorkspaceCommand,
  WorkspaceEvent,
} from '@moonbase/contracts/workspace';
import {
  EditorAlerts,
  EditorCheckouts,
  EditorDiscovery,
  EditorError,
  EditorLoader,
  EditorLookup,
  EditorMutations,
  EditorPreservation,
  EditorSaves,
  EditorSession,
  EditorTabs,
  EditorTextSearch,
  EditorTree,
  EditorViews,
  RecoverySync,
  editorLayer,
  fileKey,
  makeEditorAtoms,
  sameCheckout,
  type CloseChoice,
  type EditorBuffer,
  type EditorOptions,
  type EditorServices,
  type EditorSnapshot,
  type MutationAction,
  type MutationOptions,
  type OpenOptions,
  type OperationInput,
  type RevealOptions,
  type TextSearchOptions,
  type Lookup,
  type LookupSnapshot,
  type TextSearch,
  type TextSearchSnapshot,
} from '../editor/index.ts';

// Test support: a Promise view of the workspace and of one editor's services, so suites drive the
// editor as a user does and inspect what it published. Library code runs Effects only on its
// root's runtime; tests run them here.

/** The workspace as a test drives it: a command, and watches it can fail or close by hand. */
export type WorkspaceClient = {
  command<K extends WorkspaceCommand>(
    operation: K,
    input: CommandInput<K>,
    options?: { signal?: AbortSignal },
  ): Promise<CommandOutput<K>>;
  watch(
    input: { checkout: CheckoutTarget; paths: string[] },
    receive: (event: WorkspaceEvent) => void,
    onError: (error: WorkspacePortError) => void,
  ): () => Promise<void>;
  watchRecovery(
    input: { clientId: string },
    receive: (outline: RecoveryOutline) => void,
    onError: (error: WorkspacePortError) => void,
  ): () => Promise<void>;
};

/** A client's failure as the workspace's: its own error, else the fixed unavailable one. */
const asWorkspaceError = (error: unknown): WorkspaceError =>
  isWorkspaceError(error) ? error : new WorkspaceUnavailableError({ cause: 'failed' });

/**
 * Throws an exit's failure itself. An interrupted one is `cancelled`: a closing editor's own
 * `closed`, else a `CancelledError`, as a view would read it.
 */
function unwrap<A>(exit: Exit.Exit<A, unknown>, cancelled: () => unknown = () => closed()): A {
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
  if (failure?._tag === 'Fail') throw failure.error;
  const defect = exit.cause.reasons.find((reason) => reason._tag === 'Die');
  if (defect?._tag === 'Die') throw defect.defect;
  throw cancelled();
}
const closed = () => new EditorError({ reason: 'closed' });

/** A Promise client over a runtime that provides the workspace, failing with its errors. */
export function toWorkspaceClient(
  runtime: ManagedRuntime.ManagedRuntime<WorkspaceService, unknown>,
): WorkspaceClient {
  const observe = <A>(
    stream: Stream.Stream<A, WorkspacePortError, WorkspaceService>,
    receive: (value: A) => void,
    onError: (error: WorkspacePortError) => void,
  ) => {
    let closing = false;
    const fiber = runtime.runFork(
      Stream.runForEach(stream, (value) =>
        Effect.sync(() => {
          if (!closing) receive(value);
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (!closing) onError(error);
          }),
        ),
      ),
    );
    return async () => {
      closing = true;
      await runtime.runPromise(Fiber.interrupt(fiber));
    };
  };
  return {
    command: async (operation, input, options) =>
      unwrap(
        await runtime.runPromiseExit(
          Effect.flatMap(WorkspaceService, (service) =>
            (service[operation] as (input: unknown) => Effect.Effect<never, WorkspacePortError>)(
              input,
            ),
          ),
          options,
        ),
      ),
    watch: (input, receive, onError) =>
      observe(
        Stream.unwrap(Effect.map(WorkspaceService, (service) => service.watch(input))),
        receive,
        onError,
      ),
    watchRecovery: (input, receive, onError) =>
      observe(
        Stream.unwrap(Effect.map(WorkspaceService, (service) => service.watchRecovery(input))),
        receive,
        onError,
      ),
  };
}

const watchOf =
  <I, A>(
    watch: (
      input: I,
      receive: (value: A) => void,
      onError: (error: WorkspacePortError) => void,
    ) => () => Promise<void>,
  ) =>
  (input: I) =>
    Stream.callback<A, WorkspacePortError>((queue) =>
      Effect.acquireRelease(
        Effect.try({
          try: () =>
            watch(
              input,
              (value) => {
                Queue.offerUnsafe(queue, value);
              },
              (error) => {
                Queue.failCauseUnsafe(queue, Cause.fail(error));
              },
            ),
          catch: asWorkspaceError,
        }),
        (close) => Effect.promise(() => close().catch(() => {})),
      ),
    );

/** The workspace a client gives, as the editor's `WorkspaceService`. */
export const workspaceLayer = (client: WorkspaceClient) =>
  Layer.succeed(
    WorkspaceService,
    new Proxy({} as WorkspaceServiceShape, {
      get: (_, name: string) => {
        if (name === 'watch') return watchOf(client.watch);
        if (name === 'watchRecovery') return watchOf(client.watchRecovery);
        return (input: unknown) =>
          Effect.tryPromise({
            try: (signal) => client.command(name as WorkspaceCommand, input as never, { signal }),
            catch: asWorkspaceError,
          });
      },
    }),
  );

export type EditorDriverOptions = EditorOptions & {
  client: WorkspaceClient;
  /** Runs the editor on a `TestClock`, which `adjust` moves. */
  testClock?: boolean;
};
type Closeable = { dispose(): Promise<void> };

/** One editor, driven as the workbench drives it. */
export type EditorDriver = Awaited<ReturnType<typeof acquireEditorDriver>>;

/** An editor over `client`, built (not yet loaded). */
export async function acquireEditorDriver(options: EditorDriverOptions) {
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      editorLayer(options),
      options.testClock
        ? Layer.merge(workspaceLayer(options.client), TestClock.layer())
        : workspaceLayer(options.client),
    ),
  );
  const context = await runtime.context().catch((error) => {
    void runtime.dispose();
    throw error;
  });
  const get = <I, S>(tag: Context.Key<I, S>) => Context.get(context as Context.Context<I>, tag);
  const session = get(EditorSession),
    tabs = get(EditorTabs),
    tree = get(EditorTree),
    saves = get(EditorSaves),
    preservation = get(EditorPreservation),
    checkouts = get(EditorCheckouts),
    mutations = get(EditorMutations),
    recovery = get(RecoverySync),
    alerts = get(EditorAlerts),
    views = get(EditorViews);
  // Read as a view reads it: through the editor's atoms, kept mounted in the driver's registry.
  const registry = AtomRegistry.make();
  const atoms = makeEditorAtoms(context as Context.Context<EditorServices>);
  const unmount = registry.mount(atoms.snapshot);
  const getSnapshot = (): EditorSnapshot => registry.get(atoms.snapshot);
  // Actions run with the editor's services but outside its runtime's own fibers, as a view's do:
  // closing the editor ends the work it owns, not the caller waiting on it.
  const services = context as Context.Context<EditorServices>;
  const cancelled = () =>
    SubscriptionRef.getUnsafe(session.state).closing
      ? closed()
      : new CancelledError({ operation: 'Editor action' });
  const run = async <A, E>(
    effect: Effect.Effect<A, E, EditorServices>,
    signal?: AbortSignal,
  ): Promise<A> => unwrap(await Effect.runPromiseExitWith(services)(effect, { signal }), cancelled);
  const now = <A, E>(effect: Effect.Effect<A, E, EditorServices>): A =>
    unwrap(Effect.runSyncExitWith(services)(effect), cancelled);
  const handles = new Set<Closeable>();
  /** A popup's query, as a lookup or a search. */
  const makeQuery = <S, Q extends { state: SubscriptionRef.SubscriptionRef<S> }>(
    make: Effect.Effect<Q, never, Scope.Scope>,
  ) => {
    const scope = now(Scope.make());
    const query = now(Scope.provide(scope)(make));
    // Mounted while the handle lives, as a view showing the query keeps it.
    const state = Atom.subscriptionRef(query.state),
      unmountState = registry.mount(state);
    let completion: Promise<void> | undefined;
    const handle = {
      query,
      getSnapshot: (): S => registry.get(state),
      subscribe: (listener: () => void) => registry.subscribe(state, listener),
      /** Opens a result through the query, which a newer query or open interrupts. */
      open: (target: FileTarget, options?: OpenOptions) =>
        run(
          (
            query as unknown as {
              open: <E>(o: Effect.Effect<boolean, E>) => Effect.Effect<boolean>;
            }
          ).open(tabs.open(target, options)),
        ),
      message: (message: string) =>
        now((query as unknown as { message: (m: string) => Effect.Effect<void> }).message(message)),
      dispose: () => {
        handles.delete(handle);
        unmountState();
        return (completion ??= run(Scope.close(scope, Exit.void)));
      },
      stop: () => void handle.dispose(),
    };
    handles.add(handle);
    return handle;
  };
  let changes = 0;
  runtime.runFork(
    get(EditorDiscovery).changes.pipe(
      Stream.runForEach(() =>
        Effect.sync(() => {
          changes++;
        }),
      ),
    ),
  );
  let disposal: Promise<void> | undefined;
  const driver = {
    /** Moves the editor's `TestClock` (with `testClock`) on by `duration`. */
    adjust: (duration: Duration.Input) => run(TestClock.adjust(duration)),
    /** How many changes the checkouts' watches have reported. */
    changes: () => changes,
    runtime,
    context,
    clientId: session.clientId,
    instanceId: crypto.randomUUID(),
    getSnapshot,
    /** Calls `listener` after each change to the editor's state, from now until unsubscribed. */
    subscribe: (listener: () => void) => registry.subscribe(atoms.snapshot, listener),
    report: (error: unknown) => now(alerts.report(error)),
    clearErrors: () => now(alerts.clear),
    /** Composition fences admissions while it prepares Quit. */
    setAdmissionsOpen: (open: boolean) =>
      now(session.update((s) => (s.closing ? s : { ...s, admissionsOpen: open }))),
    load: () => run(get(EditorLoader).load),
    openCheckout: (root: string) => run(checkouts.openCheckout(root)),
    /** Lists a checkout's worktrees; aborting `signal` interrupts the listing. */
    listWorktrees: (checkout: CheckoutTarget, signal?: AbortSignal) =>
      run(checkouts.listWorktrees(checkout), signal),
    createWorktree: (input: CommandInput<'createWorktree'>) => run(checkouts.createWorktree(input)),
    initializeRepository: (checkout: CheckoutTarget) =>
      run(checkouts.initializeRepository(checkout)),
    selectCheckout: (target: CheckoutTarget) => run(checkouts.selectCheckout(target)),
    flush: () => run(Effect.andThen(session.admit, recovery.flush)),
    buffer: (target: FileTarget): Readonly<EditorBuffer> | undefined =>
      getSnapshot().buffers.find((buffer) => fileKey(buffer.target) === fileKey(target)),
    edit: (target: FileTarget, text: string) => now(tabs.edit(target, text)),
    keepOpen: (target: FileTarget) => now(tabs.keepOpen(target)),
    /** Opens a file; aborting `signal` interrupts the open. */
    open: (target: FileTarget, options?: OpenOptions, signal?: AbortSignal) =>
      run(tabs.open(target, options), signal),
    navigate: (checkout: CheckoutTarget, direction: 1 | -1) =>
      run(tabs.navigate(checkout, direction)),
    reorder: (checkout: CheckoutTarget, from: string, to: number) =>
      now(tabs.reorder(checkout, from, to)),
    position: (
      target: FileTarget,
      mode: FileView | `${FileView}:original`,
      position: EditorPosition,
    ) => now(tabs.position(target, mode, position)),
    save: (target: FileTarget, overwrite?: boolean) => run(saves.save(target, overwrite)),
    reload: (target: FileTarget) => run(saves.reload(target)),
    cancelConflict: (target: FileTarget) => now(saves.cancelConflict(target)),
    answerClose: (promptId: string, choice: CloseChoice) =>
      now(preservation.answerClose(promptId, choice)),
    close: (targets: FileTarget[]) => run(preservation.close(targets)),
    closeCheckout: (checkout: CheckoutTarget) => run(preservation.closeCheckout(checkout)),
    prepareQuit: () => run(preservation.prepareQuit),
    finishQuitPreparation: () => run(preservation.finishQuitPreparation),
    reopen: (checkout: CheckoutTarget) => run(preservation.reopen(checkout)),
    tree: (checkout: CheckoutTarget, patch: Partial<CheckoutTree>) =>
      now(tree.tree(checkout, patch)),
    resizeSidebar: (width: number) => now(tree.resizeSidebar(width)),
    setFollowActiveFile: (follow: boolean) => now(tree.setFollowActiveFile(follow)),
    list: (checkout: CheckoutTarget, path?: string) => run(tree.list(checkout, path)),
    /** Reveals a file; aborting `signal` interrupts the reveal. */
    reveal: (target: FileTarget, options?: RevealOptions, signal?: AbortSignal) =>
      run(tree.reveal(target, options), signal),
    refresh: (checkout: CheckoutTarget) => run(tree.refresh(checkout)),
    /** One lookup of file names in a checkout, with its recent files. */
    lookup: (checkout: CheckoutTarget, query: string) =>
      run(
        Effect.gen(function* () {
          yield* session.admit;
          yield* views.view(checkout);
          const { recovery: shown } = yield* views.get;
          return yield* Context.get(
            context as Context.Context<WorkspaceService>,
            WorkspaceService,
          ).lookupFiles({
            checkout,
            query,
            limit: 100,
            history: shown.recentFiles
              .filter((item) => sameCheckout(item.checkout, checkout))
              .map((item) => item.path),
          });
        }) as Effect.Effect<CommandOutput<'lookupFiles'>, unknown, EditorServices>,
      ),
    createLookup: () => {
      const handle = makeQuery<LookupSnapshot, Lookup>(get(EditorLookup).make),
        lookup = handle.query;
      return Object.assign(handle, {
        query: (query: string, checkouts: CheckoutTarget[]) =>
          handles.has(handle) ? now(lookup.query(query, checkouts)) : undefined,
      });
    },
    createTextSearch: () => {
      const handle = makeQuery<TextSearchSnapshot, TextSearch>(get(EditorTextSearch).make),
        search = handle.query;
      return Object.assign(handle, {
        query: (query: string, options: TextSearchOptions, checkout: CheckoutTarget) =>
          handles.has(handle) ? now(search.query(query, options, checkout)) : undefined,
      });
    },
    mutations: {
      admits: (action: MutationAction) => now(mutations.admits(action)),
      /** Runs a file operation as the tree does, asking before it replaces anything. */
      run: (action: MutationAction, destination: string | MutationOptions) =>
        run(
          mutations.mutate(action, typeof destination === 'string' ? { destination } : destination),
        ),
      answer: (promptId: string, replace: boolean) => now(mutations.answer(promptId, replace)),
    },
    inspect: (checkout: CheckoutTarget, paths: string[]) => run(mutations.inspect(checkout, paths)),
    mutate: (input: OperationInput) => run(mutations.dispatch(input)),
    resolveOperation: (id: string, operationClientId?: string) =>
      run(mutations.resolve(id, operationClientId)),
    reconcileRecovery: () => run(mutations.reconcile),
    dispose: () =>
      (disposal ??= (async () => {
        // oxlint-disable-next-line no-useless-spread -- Disposing removes each handle.
        for (const handle of [...handles]) await handle.dispose().catch(() => {});
        await runtime.dispose();
        // The registry stays readable: a test reads what the closed editor last published.
        unmount();
      })()),
  };
  return driver;
}

/** Answers each close prompt as `choose` decides while `action` runs. */
export function answering<A>(
  editor: EditorDriver,
  action: () => Promise<A>,
  choose: (buffer: Readonly<EditorBuffer>) => Promise<CloseChoice>,
) {
  const answered = new Set<string>();
  const check = () => {
    const prompt = editor.getSnapshot().closePrompt;
    if (!prompt || answered.has(prompt.id)) return;
    answered.add(prompt.id);
    void choose(prompt.buffer).then((choice) => editor.answerClose(prompt.id, choice));
  };
  const off = editor.subscribe(check);
  return action().finally(off);
}

/**
 * Runs `action` as the tree does, answering each replace prompt with `replace`; resolves with its
 * result and the paths each prompt asked about.
 */
export async function mutateReplying(
  editor: EditorDriver,
  action: MutationAction,
  options: string | MutationOptions,
  replace: boolean,
) {
  const asked: string[][] = [],
    seen = new Set<string>();
  const check = () => {
    const prompt = editor.getSnapshot().replacePrompt;
    if (!prompt || seen.has(prompt.id)) return;
    seen.add(prompt.id);
    asked.push(prompt.paths);
    editor.mutations.answer(prompt.id, replace);
  };
  const off = editor.subscribe(check);
  try {
    return { result: await editor.mutations.run(action, options), asked };
  } finally {
    off();
  }
}
