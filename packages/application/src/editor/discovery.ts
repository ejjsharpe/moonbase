import { normalizeApplicationError } from '@moonbase/effect';
import { Cause, Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import {
  ApplicationError,
  type CheckoutTarget,
  type Comparison,
  type CommandInput,
  type DirectoryListing,
  type EditorClient,
  type FileDocument,
  type FileTarget,
  type GitStatus,
  type ObservationClose,
} from '@moonbase/contracts/workspace';
import { watchRetry } from '../runtime/watch-retry.ts';
import { checkoutKey } from './references.ts';

/** How long a watch must stay up for its failure to renew the retry cap. */
const watchHealthyMs = watchRetry.healthyMs;
const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) => checkoutKey(a) === checkoutKey(b);
type DiscoveryDependencies = {
  execute<A>(effect: Effect.Effect<A, ApplicationError>): Promise<A>;
  watch: EditorClient['watch'];
  /** Backoff before each re-watch after a retryable watch failure; its length is the cap. */
  watchRetryMs: readonly number[];
  /** Lists a folder, reporting a failure unless `report` is false. */
  listDirectory(
    input: CommandInput<'listDirectory'>,
    scope: Scope.Scope,
    report?: boolean,
  ): Promise<DirectoryListing>;
  readFile(target: FileTarget, scope: Scope.Scope): Promise<FileDocument>;
  readComparison(input: CommandInput<'readComparison'>, scope: Scope.Scope): Promise<Comparison>;
  gitStatus(checkout: CheckoutTarget, scope: Scope.Scope): Promise<GitStatus>;
  isClosing(): boolean;
  notify(): void;
  report(error: unknown): void;
};
type ComparisonRead = {
  input: CommandInput<'readComparison'>;
  isCurrent(): boolean;
  apply(comparison: Comparison): Promise<void>;
};
type RefreshCapabilities = {
  isCurrent(): boolean;
  refreshListings(): Promise<unknown>;
  publishGit(status: GitStatus): void;
  captureComparison(): ComparisonRead | undefined;
};

/** Checkout observations and selection reads retain their own cancellation/close outcomes. */
export class EditorDiscovery {
  private scope: Scope.Closeable;
  private dependencies: DiscoveryDependencies;
  private stops = new Map<string, { scope: Scope.Closeable; close: ObservationClose }>();
  private observationClosures = new Set<ObservationClose>();
  /** Checkouts whose watch gave up, so an explicit refresh or reopen watches them again. */
  private lostWatches = new Set<string>();
  private selection?: Scope.Closeable;
  private selectionCheckout?: string;
  private obsoleteReadErrors = new WeakSet<ApplicationError>();
  private activation = 0;
  private revision = 0;
  private refreshing = new Map<string, Fiber.Fiber<void, ApplicationError>>();
  private refreshPending = new Set<string>();
  constructor(scope: Scope.Closeable, dependencies: DiscoveryDependencies) {
    this.scope = scope;
    this.dependencies = dependencies;
  }
  get discoveryRevision() {
    return this.revision;
  }
  get activationGeneration() {
    return this.activation;
  }
  invalidateActivation() {
    return ++this.activation;
  }
  isObsoleteReadError(error: unknown) {
    return ApplicationError.is(error) && this.obsoleteReadErrors.has(error);
  }
  getCheckoutScope(checkout: CheckoutTarget) {
    return this.stops.get(checkoutKey(checkout))?.scope ?? this.scope;
  }
  getComparisonScope(checkout: CheckoutTarget) {
    return this.selectionCheckout === checkoutKey(checkout) && this.selection
      ? this.selection
      : this.getCheckoutScope(checkout);
  }
  clearSelection() {
    if (this.selection)
      void this.dependencies
        .execute(Scope.close(this.selection, Exit.void))
        .catch(this.dependencies.report);
    this.selection = undefined;
    this.selectionCheckout = undefined;
  }
  selectReadScope(checkout: CheckoutTarget, replace = false) {
    const key = checkoutKey(checkout);
    if (
      !replace &&
      this.selectionCheckout === key &&
      this.selection &&
      this.selection.state._tag !== 'Closed'
    )
      return this.selection;
    const previous = this.selection;
    const scope = (this.selection = Scope.forkUnsafe(this.stops.get(key)?.scope ?? this.scope));
    this.selectionCheckout = key;
    if (previous)
      void this.dependencies
        .execute(Scope.close(previous, Exit.void))
        .catch(this.dependencies.report);
    return scope;
  }
  invoke<A>(effect: Effect.Effect<A, ApplicationError>, scope: Scope.Scope): Promise<A> {
    let interruptOnly = false;
    return this.dependencies
      .execute(
        effect.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              interruptOnly = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
            }),
          ),
        ),
      )
      .catch((error) => {
        if (interruptOnly && scope.state._tag === 'Closed' && ApplicationError.is(error))
          this.obsoleteReadErrors.add(error);
        throw error;
      });
  }
  releaseObservation(checkout: CheckoutTarget): Promise<void> {
    const key = checkoutKey(checkout);
    this.lostWatches.delete(key);
    const observation = this.stops.get(key);
    if (!observation) return Promise.resolve();
    this.stops.delete(key);
    return this.dependencies.execute(
      Scope.close(observation.scope, Exit.void).pipe(
        Effect.flatMap(() => Effect.promise(observation.close)),
      ),
    );
  }
  /** Whether the checkout's watch gave up, such as after a daemon stayed away past every backoff. */
  isWatchLost(checkout: CheckoutTarget) {
    return this.lostWatches.has(checkoutKey(checkout));
  }
  /**
   * Watches a checkout. A retryable (`Unavailable`) failure, such as a daemon that restarted,
   * watches again after each backoff and reads again once the new watch is ready, since changes
   * were missed meanwhile; only a failure that cannot be retried, or the last of them, is reported and leaves the watch
   * lost, which an explicit refresh or reopen of the checkout arms again.
   */
  async observe(
    checkout: CheckoutTarget,
    isOpen: () => boolean,
    onChanged: (isCurrent: () => boolean) => void,
    failures = 0,
  ) {
    const key = checkoutKey(checkout),
      rewatched = failures > 0;
    await this.releaseObservation(checkout);
    if (this.dependencies.isClosing()) return;
    const scope = Scope.forkUnsafe(this.scope);
    const ready = Deferred.makeUnsafe<Exit.Exit<ObservationClose, ApplicationError>>();
    let completion: Promise<void> | undefined, upSince: number | undefined;
    const isCurrent = () => this.stops.get(key)?.scope === scope;
    const close: ObservationClose = () =>
      (completion ??= this.dependencies.execute(
        Effect.flatMap(Deferred.await(ready), (acquired) =>
          Effect.flatMap(acquired, (release) => Effect.promise(release)),
        ).pipe(Effect.uninterruptible),
      ));
    const fail = (error: unknown) => {
      if (this.dependencies.isClosing() || !isOpen() || !isCurrent()) return;
      const failure = normalizeApplicationError(error);
      if (upSince !== undefined && performance.now() - upSince >= watchHealthyMs) failures = 0;
      const delay = this.dependencies.watchRetryMs[failures];
      if (failure.code !== 'Unavailable' || delay === undefined) {
        this.lostWatches.add(key);
        this.dependencies.report(error);
        return;
      }
      // The failed watch is released when the next one replaces it; the backoff runs on the root
      // scope, since replacing the observation ends its own scope.
      const rewatch = Effect.gen({ self: this }, function* () {
        yield* Effect.sleep(delay);
        if (this.dependencies.isClosing() || !isOpen() || !isCurrent()) return;
        yield* Effect.tryPromise({
          try: () =>
            this.observe(
              checkout,
              isOpen,
              onChanged,
              // A watch that fails again at once spends the next backoff.
              failures + 1,
            ),
          catch: normalizeApplicationError,
        });
      }).pipe(Effect.catch((retry) => Effect.sync(() => this.dependencies.report(retry))));
      void this.dependencies.execute(Effect.forkIn(rewatch, this.scope)).catch(() => {});
    };
    // A synchronous watch callback can dispose the model before its close handle returns.
    this.observationClosures.add(close);
    this.stops.set(key, { scope, close });
    await this.dependencies.execute(
      Effect.gen({ self: this }, function* () {
        const acquired = yield* Effect.exit(
          Effect.try({
            try: () =>
              this.dependencies.watch(
                { checkout, paths: [''] },
                (event) => {
                  if (
                    this.dependencies.isClosing() ||
                    !isOpen() ||
                    !sameCheckout(event.checkout, checkout) ||
                    !isCurrent()
                  )
                    return;
                  if (event.error) this.dependencies.report(event.error);
                  if (event.ready) {
                    const first = upSince === undefined;
                    upSince ??= performance.now();
                    // A re-watch's first ready is its change: what was missed while it was down,
                    // read only now that no later change can slip past the live watch.
                    if (!first || !rewatched) return;
                  }
                  this.revision++;
                  onChanged(isCurrent);
                },
                fail,
              ),
            catch: normalizeApplicationError,
          }),
        );
        yield* Deferred.succeed(ready, acquired);
        yield* Scope.addFinalizer(
          scope,
          Effect.promise(close).pipe(
            Effect.exit,
            Effect.tap((exit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(exit)) this.observationClosures.delete(close);
              }),
            ),
            Effect.asVoid,
          ),
        );
        if (Exit.isFailure(acquired)) yield* acquired;
      }).pipe(Effect.uninterruptible),
    );
  }
  joinObservationClosures(): Effect.Effect<void> {
    // A child scope detaches when close starts; join closures still settling outside it.
    return Effect.suspend(() =>
      Effect.all(
        [...this.observationClosures].map((close) => Effect.promise(close).pipe(Effect.exit)),
        { concurrency: 'unbounded' },
      ).pipe(Effect.flatMap(Exit.asVoidAll), Effect.orDie),
    );
  }
  readFile(target: FileTarget, scope: Scope.Scope = this.scope) {
    return this.dependencies.readFile(target, scope);
  }
  readComparison(input: CommandInput<'readComparison'>, scope: Scope.Scope) {
    return this.dependencies.readComparison(input, scope);
  }
  listDirectory(input: CommandInput<'listDirectory'>, scope: Scope.Scope, report = true) {
    return this.dependencies.listDirectory(input, scope, report);
  }
  refresh(checkout: CheckoutTarget, capabilities: RefreshCapabilities): Promise<void> {
    const key = checkoutKey(checkout),
      scope = this.getCheckoutScope(checkout);
    return this.invoke(
      Effect.suspend(() => {
        const existing = this.refreshing.get(key);
        if (existing) {
          this.refreshPending.add(key);
          return Fiber.join(existing);
        }
        const work = Effect.tryPromise({
          try: async () => {
            do {
              this.refreshPending.delete(key);
              await this.refreshOnce(checkout, capabilities);
            } while (
              this.refreshPending.has(key) &&
              !this.dependencies.isClosing() &&
              capabilities.isCurrent()
            );
          },
          catch: normalizeApplicationError,
        }).pipe(Effect.ensuring(Effect.sync(() => this.refreshing.delete(key))));
        return Effect.flatMap(Effect.forkIn(work, scope), (fiber) => {
          this.refreshing.set(key, fiber);
          return Fiber.join(fiber);
        });
      }),
      scope,
    );
  }
  private async refreshOnce(checkout: CheckoutTarget, capabilities: RefreshCapabilities) {
    await capabilities.refreshListings();
    if (this.dependencies.isClosing() || !capabilities.isCurrent()) return;
    try {
      const status = await this.dependencies.gitStatus(checkout, this.getCheckoutScope(checkout));
      if (!this.dependencies.isClosing() && capabilities.isCurrent())
        capabilities.publishGit(status);
    } catch {
      /* The public command already reported the error; retained buffers stay usable. */
    }
    if (this.dependencies.isClosing() || !capabilities.isCurrent()) return;
    const generation = this.activation;
    const comparison = capabilities.captureComparison();
    if (comparison) {
      try {
        const result = await this.readComparison(
          comparison.input,
          this.getComparisonScope(checkout),
        );
        if (
          !this.dependencies.isClosing() &&
          capabilities.isCurrent() &&
          generation === this.activation &&
          comparison.isCurrent()
        )
          await comparison.apply(result);
      } catch {
        /* A failed refresh retains the last comparison and current edits. */
      }
    }
    if (!this.dependencies.isClosing()) this.dependencies.notify();
  }
}
