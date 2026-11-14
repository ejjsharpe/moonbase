import { Cause, Context, Effect, Exit, Fiber, FiberSet, Layer, type Scope, Stream } from 'effect';
import type { WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import type { HostInput } from '@moonbase/contracts/workspace-host';
import {
  isWorkspaceHostError,
  toWireError,
  WorkspaceStoreError,
  WorkspaceUnavailableError,
  WorkspaceUnsupportedError,
  type WorkspaceHostError,
} from '@moonbase/contracts/workspace-host-errors';
import { attempt } from '../attempt.ts';
import { decodeConfiguration, type WorkspaceHostConfiguration } from '../schema.ts';
import { path } from '../validation.ts';
import { Checkouts } from './checkouts.ts';
import { WorkspaceDiscovery } from './discovery.ts';
import { HostJournal } from './host-journal.ts';
import { HostSettings } from './host-settings.ts';
import { HostStore } from './host-store.ts';
import { readOperationFeed } from './operation-feed.ts';
import { Leases, type Lease } from './leases.ts';
import { getOperationFootprint, mutate } from './mutations.ts';
import { NativeReferences } from './native-references.ts';
import { WorkspaceObservations } from './observations.ts';
import {
  createChatWorktree,
  createWorktree,
  initializeRepository,
  turnChatIntoProject,
} from './requests.ts';
import { saveFile } from './saves.ts';
import { WorkspaceWorktrees } from './worktrees.ts';

/** The services an operation runs with. */
type HostServices =
  | Checkouts
  | HostJournal
  | HostSettings
  | Leases
  | NativeReferences
  | WorkspaceDiscovery
  | WorkspaceWorktrees;

/**
 * The file host's error for a failure: its own errors as they are, and a fixed one for anything
 * else (a store failure for work on the journals), so unknown diagnostics never reach a client.
 */
const asHostError = (error: unknown, persistence: boolean): WorkspaceHostError => {
  if (isWorkspaceHostError(error)) return error;
  const reason = 'Application effect failed';
  return persistence
    ? new WorkspaceStoreError({ reason })
    : new WorkspaceUnavailableError({ reason });
};

type RunOptions<A> = {
  /** Work on the journals, whose unknown failures are store failures. */
  persistence?: boolean;
  /** Paths the work holds while it runs. */
  lease?: Lease;
  /**
   * Read-only work, which stops wherever it is when cancelled. Other work stops only at the
   * points it marks interruptible, such as a helper run or a wait, and finishes its journal.
   */
  interruptible?: boolean;
  /** Undoes a result nobody will receive, such as the reply to a cancelled request. */
  abandoned?: (result: A) => Effect.Effect<void, unknown>;
};

/**
 * The file host as one service: the `WorkspaceHostService` operations and the folder check
 * `WorkspaceFolders` serves.
 */
export class FileHost extends Context.Service<
  FileHost,
  {
    readonly service: WorkspaceHostServiceShape;
    hasFolder(path: string): Effect.Effect<boolean, WorkspaceHostError>;
  }
>()('moonbase/workspace/FileHost') {}

const makeFileHost = Effect.gen(function* () {
  const { config } = yield* HostSettings;
  const checkouts = yield* Checkouts;
  const journal = yield* HostJournal;
  const store = yield* HostStore;
  const leases = yield* Leases;
  const discovery = yield* WorkspaceDiscovery;
  const worktrees = yield* WorkspaceWorktrees;
  const references = yield* NativeReferences;
  const observations = yield* WorkspaceObservations;
  const services = yield* Effect.context<HostServices>();
  // Every operation runs here, so closing the host stops each and waits for it to end before
  // anything it may use is released.
  const operations = yield* FiberSet.make<unknown, WorkspaceHostError>();
  /**
   * Runs one operation as the host's own work: a caller that stops waiting (cancels) asks it to
   * stop without waiting for it, and it keeps its lease, helpers and descriptors until it ends.
   */
  const run = <A>(
    work: Effect.Effect<A, unknown, HostServices | Scope.Scope>,
    { persistence = false, lease, interruptible = false, abandoned }: RunOptions<A> = {},
  ): Effect.Effect<A, WorkspaceHostError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scoped = Effect.scoped(
          Effect.gen(function* () {
            if (lease) yield* leases.hold(lease);
            return yield* work;
          }),
        );
        const owned: Effect.Effect<A, WorkspaceHostError> = (
          interruptible ? Effect.interruptible(scoped) : Effect.uninterruptible(scoped)
        ).pipe(
          Effect.provideContext(services),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause as Cause.Cause<never>)
              : Effect.fail(asHostError(Cause.squash(cause), persistence)),
          ),
        );
        const fiber = yield* FiberSet.run(operations, owned);
        return yield* restore(Fiber.join(fiber) as Effect.Effect<A, WorkspaceHostError>).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              // Asked at once, so the work sees it at its next interruptible point.
              fiber.interruptUnsafe();
              if (!abandoned) return;
              const exit = yield* Fiber.await(fiber);
              if (Exit.isSuccess(exit)) yield* Effect.exit(abandoned(exit.value as A));
            }),
          ),
          // Work stopped while its caller still waits: the host is closing.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.fail(new WorkspaceUnavailableError({ reason: 'Workspace scope is closed.' }))
              : Effect.failCause(cause),
          ),
        );
      }),
    );
  const read = <A>(work: Effect.Effect<A, unknown, HostServices | Scope.Scope>) =>
    run(work, { interruptible: true });
  const requireNativeImports = Effect.suspend(() =>
    config.nativeImports === false
      ? Effect.fail(
          new WorkspaceUnsupportedError({ reason: 'This host does not accept native imports.' }),
        )
      : Effect.void,
  );
  const footprint = getOperationFootprint(references);
  const service: WorkspaceHostServiceShape = {
    openCheckout: (input) => read(checkouts.open(input.root)),
    verifyCheckout: (input) => read(Effect.asVoid(checkouts.directory(input.checkout))),
    readFile: (target) =>
      read(Effect.flatMap(checkouts.directory(target.checkout), (d) => d.read(target.path))),
    saveFile: (input) =>
      run(saveFile(input), {
        lease: { checkoutId: input.target.checkout.checkoutId, paths: [input.target.path] },
      }),
    listDirectory: (input) => read(discovery.listDirectory(input)),
    getIgnoredPaths: (input) => read(discovery.getIgnoredPaths(input)),
    gitStatus: (input) => read(discovery.getStatus(input.checkout)),
    listWorktrees: (input) => read(worktrees.listWorktrees(input.checkout)),
    createWorktree: (input) => run(createWorktree(input)),
    initializeRepository: (input) =>
      run(initializeRepository(input), {
        // Waits for, and holds off, every save and file operation in the checkout.
        lease: { checkoutId: input.checkout.checkoutId, paths: [''] },
      }),
    readComparison: (input) => read(discovery.readComparison(input)),
    lookupFiles: (input) => read(discovery.lookupFiles(input)),
    searchText: (input) => read(discovery.searchText(input)),
    inspectEntries: (input) =>
      read(
        Effect.gen(function* () {
          const directory = yield* checkouts.directory(input.checkout);
          return yield* Effect.forEach(input.paths, (p) =>
            Effect.gen(function* () {
              yield* attempt(() => path(p));
              return {
                target: { checkout: input.checkout, path: p },
                ...(yield* directory.entry(p)),
              };
            }),
          );
        }),
      ),
    mutate: (input: HostInput<'mutate'>) =>
      run(mutate(input), {
        lease: { checkoutId: input.checkout.checkoutId, paths: footprint(input) },
      }),
    operationStatus: (input) => run(journal.operationStatus(input), { persistence: true }),
    acknowledgeOperation: (input) =>
      run(
        attempt(() => journal.acknowledgeOperation(input)),
        { persistence: true },
      ),
    saveStatus: (input) => run(journal.saveStatus(input), { persistence: true }),
    acknowledgeSave: (input) =>
      run(
        attempt(() => journal.acknowledgeSave(input)),
        { persistence: true },
      ),
    listOperations: (input) =>
      run(
        attempt(() => {
          checkouts.approval(input.checkout);
          return readOperationFeed(store, journal.epoch, input.checkout, input.after);
        }),
        { persistence: true },
      ),
    createChatWorktree: (input) => run(createChatWorktree(input)),
    turnChatIntoProject: (input) => run(turnChatIntoProject(input)),
    captureImports: (input) =>
      run(
        Effect.andThen(requireNativeImports, references.capture(input)).pipe(
          Effect.map((captured) => ({ references: captured })),
        ),
        {
          abandoned: (output) => references.release({ ...input, references: output.references }),
        },
      ),
    releaseImports: (input) => run(Effect.andThen(requireNativeImports, references.release(input))),
    watch: (input) =>
      observations.watch(input).pipe(Stream.mapError((error) => asHostError(error, false))),
  };
  return { service, hasFolder: (folder: string) => read(checkouts.hasFolder(folder)) };
});

/**
 * The file host's layer: its store, checkouts, journal and helpers, each released after
 * everything that uses it has stopped.
 */
export function makeFileHostLayer(configuration: WorkspaceHostConfiguration, now = Date.now) {
  const settings = Layer.effect(
    HostSettings,
    Effect.map(
      attempt(() => decodeConfiguration(configuration)),
      (config) => ({
        config,
        allowRoot: configuration.allowRoot,
        chats: configuration.chats,
        now,
      }),
    ),
  );
  const helpers = Layer.mergeAll(
    HostJournal.layer,
    WorkspaceDiscovery.layer,
    WorkspaceWorktrees.layer,
    NativeReferences.layer,
    WorkspaceObservations.layer,
  ).pipe(Layer.provideMerge(Layer.mergeAll(Checkouts.layer, Leases.layer)));
  return Layer.effect(FileHost, makeFileHost).pipe(
    Layer.provide(helpers),
    Layer.provide(HostStore.layer),
    Layer.provide(settings),
    // A host that cannot start fails its composition with the wire error its owners expect,
    // until the workspace moves to Effect RPC (CL-07).
    Layer.catchCause((cause) =>
      Layer.effect(FileHost, Effect.fail(toWireError(asHostError(Cause.squash(cause), true)))),
    ),
  );
}
