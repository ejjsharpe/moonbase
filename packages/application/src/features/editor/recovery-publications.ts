import { Effect, Fiber, Semaphore, type Scope } from 'effect';
import {
  ApplicationError,
  type CommandInput,
  type EditorRecovery,
  type RecoveryChange,
  type RecoveryPublication,
} from '@moonbase/contracts/workspace';

type Run = <A>(effect: Effect.Effect<A, ApplicationError>) => Promise<A>;
export type PublicationOptions = {
  onConfirmed?: () => Promise<void>;
  kind?: 'close' | 'reload';
  before?: () => void;
  savedRequests?: string[];
};
type PendingPublication = {
  request: CommandInput<'persistRecovery'>;
  onConfirmed?: () => Promise<void>;
  kind: 'recovery' | 'close' | 'reload';
  savedRequests: string[];
  captureRevision: number;
};
type PublicationDependencies = {
  execute: Run;
  run: Run;
  isClosing(): boolean;
  persistRecovery(request: CommandInput<'persistRecovery'>): Promise<RecoveryPublication>;
  getRecoveryPublication(
    request: CommandInput<'getRecoveryPublication'>,
  ): Promise<RecoveryPublication | null>;
  confirmSaves(requests: string[]): void;
  resumeFacts(): void;
  notify(): void;
  report(error: unknown): void;
};

/** Exact immutable publication attempts and their model-scoped debounce lifetime. */
export class RecoveryPublications {
  private lock = Semaphore.makeUnsafe(1);
  private revision = 0;
  private captureRevision = 0;
  private confirmedCapture = -1;
  private publications = 0;
  private pendingPublication?: PendingPublication;
  private scheduled?: Fiber.Fiber<void, ApplicationError>;
  private scheduleGeneration = 0;
  private clientId: string;
  private scope: Scope.Scope;
  private dependencies: PublicationDependencies;
  constructor(clientId: string, scope: Scope.Scope, dependencies: PublicationDependencies) {
    this.clientId = clientId;
    this.scope = scope;
    this.dependencies = dependencies;
  }
  get currentRevision() {
    return this.revision;
  }
  get inFlight() {
    return this.publications;
  }
  get confirmed() {
    return (
      this.captureRevision === this.confirmedCapture &&
      this.publications === 0 &&
      !this.pendingPublication
    );
  }
  get pending() {
    const pending = this.pendingPublication;
    return pending && { requestId: pending.request.requestId, kind: pending.kind };
  }
  get retainsConfirmation() {
    return !!this.pendingPublication?.onConfirmed;
  }
  initialize(revision: number) {
    this.revision = revision;
  }
  advanceRevision(transition: RecoveryChange) {
    if (transition.revision <= this.revision) return;
    if (
      transition.previousRevision !== this.revision ||
      transition.revision <= transition.previousRevision
    )
      throw new ApplicationError({
        code: 'Conflict',
        message:
          'Recovery revision gap. Retained facts cannot replace another publication; close/discard remains blocked.',
      });
    this.revision = transition.revision;
  }
  waitForIdle() {
    return this.dependencies.run(this.lock.withPermits(1)(Effect.void));
  }
  invalidate() {
    this.captureRevision++;
    this.dependencies.notify();
  }
  cancelScheduled() {
    this.scheduleGeneration++;
    if (this.scheduled)
      void this.dependencies
        .execute(Fiber.interrupt(this.scheduled))
        .catch(this.dependencies.report);
    this.scheduled = undefined;
  }
  schedule(flush: () => Promise<void>) {
    this.cancelScheduled();
    const generation = this.scheduleGeneration;
    const { execute, isClosing, report } = this.dependencies;
    void execute(
      Effect.forkIn(
        Effect.sleep('150 millis').pipe(
          Effect.flatMap(() => {
            if (generation !== this.scheduleGeneration || isClosing()) return Effect.void;
            this.scheduled = undefined;
            return Effect.tryPromise({ try: flush, catch: ApplicationError.fromUnknown });
          }),
          Effect.catch((error) => Effect.sync(() => report(error))),
        ),
        this.scope,
      ),
    )
      .then((fiber) => {
        if (!isClosing() && generation === this.scheduleGeneration) this.scheduled = fiber;
        else void execute(Fiber.interrupt(fiber)).catch(report);
      })
      .catch(report);
  }
  blocked() {
    if (!this.pendingPublication) return false;
    this.dependencies.report(
      'Recovery publication PENDING/UNCERTAIN. Resolve its exact identity before Save, Reload, file operations, Close or Quit.',
    );
    return true;
  }
  private async confirm(pending: PendingPublication, receipt: RecoveryPublication) {
    const { request, savedRequests, onConfirmed, captureRevision } = pending;
    const { isClosing, confirmSaves, resumeFacts, notify } = this.dependencies;
    if (isClosing()) throw new ApplicationError({ code: 'Cancelled', message: 'Editor disposed.' });
    if (
      this.pendingPublication !== pending ||
      receipt.clientId !== request.clientId ||
      receipt.requestId !== request.requestId ||
      receipt.previousRevision !== request.expectedRevision ||
      receipt.revision !== receipt.previousRevision + 1 ||
      this.revision !== receipt.previousRevision
    )
      throw new ApplicationError({
        code: 'Uncertain',
        message:
          'Recovery receipt does not confirm this exact pending publication/revision. Live work retained.',
      });
    this.revision = receipt.revision;
    this.pendingPublication = undefined;
    confirmSaves(savedRequests);
    await onConfirmed?.();
    this.confirmedCapture = captureRevision;
    resumeFacts();
    notify();
  }
  publish(
    state: EditorRecovery,
    { onConfirmed, kind = 'close', before, savedRequests = [] }: PublicationOptions = {},
  ) {
    const captured = structuredClone(state),
      captureRevision = this.captureRevision;
    const capturedSaves = [...savedRequests];
    const { run, isClosing, persistRecovery, getRecoveryPublication, notify, report } =
      this.dependencies;
    this.publications++;
    notify();
    return run(
      this.lock.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            if (isClosing())
              throw new ApplicationError({ code: 'Cancelled', message: 'Editor disposed.' });
            before?.();
            if (this.blocked())
              throw new ApplicationError({
                code: 'Uncertain',
                message: 'Resolve the pending recovery publication first.',
              });
            const pending: PendingPublication = {
              request: {
                clientId: this.clientId,
                requestId: crypto.randomUUID(),
                expectedRevision: this.revision,
                state: captured,
              },
              onConfirmed,
              kind: onConfirmed ? kind : 'recovery',
              savedRequests: capturedSaves,
              captureRevision,
            };
            let receipt: RecoveryPublication;
            try {
              receipt = await persistRecovery(pending.request);
            } catch (error) {
              if (isClosing()) throw error;
              if (ApplicationError.is(error) && ['InvalidInput', 'Conflict'].includes(error.code))
                throw error;
              this.pendingPublication = pending;
              notify();
              const known = await getRecoveryPublication({
                clientId: pending.request.clientId,
                requestId: pending.request.requestId,
              }).catch(() => null);
              if (!known) {
                report(
                  'Recovery publication PENDING/UNCERTAIN. Live work and the immutable request are retained; null status does not prove failure.',
                );
                throw error;
              }
              receipt = known;
            }
            // Retain identity even when a malformed/mismatched receipt cannot be accepted.
            this.pendingPublication = pending;
            await this.confirm(pending, receipt);
          },
          catch: ApplicationError.fromUnknown,
        }),
      ),
    )
      .catch((error) => {
        if (!isClosing()) this.confirmedCapture = -1;
        throw error;
      })
      .finally(() => {
        if (!isClosing()) {
          this.publications--;
          notify();
        }
      });
  }
  async resolve(releasePreservation: () => Promise<void>) {
    const { run, isClosing, persistRecovery, getRecoveryPublication, resumeFacts, report } =
      this.dependencies;
    let rejected = false;
    const resolved = await run(
      this.lock.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const pending = this.pendingPublication;
            if (!pending || isClosing()) return !isClosing();
            try {
              const { request, onConfirmed } = pending;
              let receipt = await getRecoveryPublication({
                clientId: request.clientId,
                requestId: request.requestId,
              });
              if (!receipt) {
                try {
                  receipt = await persistRecovery(request);
                } catch (error) {
                  // Matching committed requests return their receipt before CAS; only this retry's Conflict proves rejection.
                  if (isClosing() || !ApplicationError.is(error) || error.code !== 'Conflict')
                    throw error;
                  this.pendingPublication = undefined;
                  rejected = true;
                  report(
                    onConfirmed
                      ? 'The original Close/Reload publication did not commit. Drafts retained; choose the action again.'
                      : 'The original recovery publication did not commit. Retained facts will reconcile into a fresh capture.',
                  );
                  if (onConfirmed) await releasePreservation();
                  else resumeFacts();
                  return !onConfirmed;
                }
              }
              if (isClosing()) return false;
              await this.confirm(pending, receipt);
              return true;
            } catch (error) {
              report(error);
              this.blocked();
              return false;
            }
          },
          catch: ApplicationError.fromUnknown,
        }),
      ),
    );
    return { resolved, rejected };
  }
}
