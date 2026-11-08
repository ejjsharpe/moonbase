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
import { normalizeApplicationError } from '../../runtime/effect-client.ts';
import { checkoutKey } from './references.ts';

const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) => checkoutKey(a) === checkoutKey(b);
type DiscoveryDependencies = {
  execute<A>(effect: Effect.Effect<A, ApplicationError>): Promise<A>;
  watch: EditorClient['watch'];
  listDirectory(
    input: CommandInput<'listDirectory'>,
    scope: Scope.Scope,
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
    const observation = this.stops.get(key);
    if (!observation) return Promise.resolve();
    this.stops.delete(key);
    return this.dependencies.execute(
      Scope.close(observation.scope, Exit.void).pipe(
        Effect.flatMap(() => Effect.promise(observation.close)),
      ),
    );
  }
  async observe(
    checkout: CheckoutTarget,
    isOpen: () => boolean,
    onChanged: (isCurrent: () => boolean) => void,
  ) {
    const key = checkoutKey(checkout);
    await this.releaseObservation(checkout);
    if (this.dependencies.isClosing()) return;
    const scope = Scope.forkUnsafe(this.scope);
    const ready = Deferred.makeUnsafe<Exit.Exit<ObservationClose, ApplicationError>>();
    let completion: Promise<void> | undefined;
    const close: ObservationClose = () =>
      (completion ??= this.dependencies.execute(
        Effect.flatMap(Deferred.await(ready), (acquired) =>
          Effect.flatMap(acquired, (release) => Effect.promise(release)),
        ).pipe(Effect.uninterruptible),
      ));
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
                    this.stops.get(key)?.scope !== scope
                  )
                    return;
                  if (event.error) this.dependencies.report(event.error);
                  if (event.ready) return;
                  this.revision++;
                  onChanged(() => this.stops.get(key)?.scope === scope);
                },
                this.dependencies.report,
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
  listDirectory(input: CommandInput<'listDirectory'>, scope: Scope.Scope) {
    return this.dependencies.listDirectory(input, scope);
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
          catch: ApplicationError.fromUnknown,
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
    // A plain folder has no Git status to read.
    if (checkout.vcs === 'git')
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
