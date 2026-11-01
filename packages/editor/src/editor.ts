import { EditorLookup, EditorMutation, type MutationAction } from './workflows.ts';
import { Deferred, Effect, Exit, Fiber, Scope, Semaphore, type ManagedRuntime } from 'effect';
import { runApplicationEffect } from '@moonbase/application/effect-client';
import { decodeEditorRecovery } from '@moonbase/application/workspace-schema';
import {
  ApplicationError,
  emptyRecovery,
  maximumFileBytes,
  type CheckoutTarget,
  type CheckoutView,
  type Comparison,
  type DirectoryListing,
  type EditorClient,
  type ObservationClose,
  type EditorPosition,
  type EditorRecovery,
  type FileDocument,
  type FileTarget,
  type FileView,
  type GitStatus,
  type OperationResult,
  type SaveResult,
  type RecoveryChange,
  type RecoveryPublication,
  type RecoveryLoad,
  type WorkspaceCommand,
  type CommandInput,
  type CommandOutput,
  type WorkspaceOperation,
} from '@moonbase/application/client';

import { readOwn, writeOwn } from './record.ts';

import { checkoutKey, fileKey, moveRecoveryReferences } from './references.ts';
export { checkoutKey, fileKey } from './references.ts';
const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) => checkoutKey(a) === checkoutKey(b);
const operationKey = (clientId: string, id: string) => JSON.stringify([clientId, id]);
const deferObservation = Symbol('defer recovery observation');
const definitiveNonAdmission = (error: unknown) =>
  ApplicationError.is(error) && error.code === 'InvalidInput';
const affected = (path: string, parent: string) => path === parent || path.startsWith(parent + '/');
const validPath = (path: string, directory = false) => {
  if (directory && path === '') return;
  if (
    !path ||
    path.length > 4096 ||
    path.startsWith('/') ||
    /[\\\0]/.test(path) ||
    path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw new ApplicationError({
      code: 'InvalidInput',
      message: 'Use an exact relative path without traversal or .git.',
    });
};
const view = (): CheckoutView => ({
  openFiles: [],
  active: '',
  preview: null,
  fileViews: {},
  positions: {},
  tree: { expanded: [], selected: [], focus: '', scroll: 0, hideIgnored: false },
});

type PendingSave = CommandInput<'saveFile'>;
export type EditorBuffer = {
  target: FileTarget;
  text: string;
  disk: FileDocument;
  conflict?: FileDocument;
  pendingSave?: PendingSave;
  saving: boolean;
};
export type CloseChoice = 'save' | 'discard' | 'cancel';
export type ClosePrompt = { id: string; buffer: Readonly<EditorBuffer> };
export type EditorSnapshot = {
  ready: boolean;
  recoveryReady: boolean;
  disposed: boolean;
  closePrompt: ClosePrompt | null;
  preserving: boolean;
  discoveryRevision: number;
  recovery: EditorRecovery;
  buffers: readonly EditorBuffer[];
  comparisons: Readonly<Record<string, Comparison>>;
  listings: Readonly<Record<string, DirectoryListing>>;
  git: Readonly<Record<string, GitStatus>>;
  publication?: { requestId: string; kind: 'recovery' | 'close' | 'reload' };
  errors: readonly string[];
  operations: readonly OperationResult[];
};
type ClosedAction = {
  checkout: CheckoutTarget;
  files: {
    path: string;
    index: number;
    view: FileView;
    positions?: CheckoutView['positions'][string];
  }[];
  active: string;
};

/** One editor instance; IO always enters the application's injected command client. */
class EditorModelState {
  readonly clientId: string;
  readonly instanceId = crypto.randomUUID();
  private client: EditorClient;
  private recovery: EditorRecovery;
  private revision = 0;
  private captureRevision = 0;
  private confirmedCapture = -1;
  private publications = 0;
  private ready = false;
  private loading = false;
  private closing = false;
  private disposed = false;
  private workflows = new Set<{ stop(): void }>();
  private closePrompt: ClosePrompt | null = null;
  private closeAnswer?: Deferred.Deferred<CloseChoice>;
  private cleanup?: Promise<void>;
  private cleanupFailures: ApplicationError[] = [];
  private releaseStarted = false;
  private releaseDone = Deferred.makeUnsafe<Exit.Exit<void>>();
  private bound = false;
  private runEffect!: <A>(effect: Effect.Effect<A, ApplicationError>) => Promise<A>;
  private recoveryLock = Semaphore.makeUnsafe(1);
  private factsLock = Semaphore.makeUnsafe(1);
  private selection?: Scope.Closeable;
  private preserving = false;
  private buffers = new Map<string, EditorBuffer>();
  private saveResults = new Map<string, Extract<SaveResult, { kind: 'saved' }>>();
  private comparisons: Record<string, Comparison> = {};
  private comparisonAttempts = new Map<string, { mode: FileView; failedWorkingVersion?: string }>();
  private listings: Record<string, DirectoryListing> = {};
  private git: Record<string, GitStatus> = {};
  private errors: string[] = [];
  private operations = new Map<
    string,
    {
      operation?: WorkspaceOperation;
      result: OperationResult;
      applied: Set<string>;
      copies?: EditorBuffer[];
      closedCopyTargets?: Set<string>;
      acknowledged?: boolean;
    }
  >();
  private history: ClosedAction[] = [];
  private listeners = new Set<() => void>();
  private stops = new Map<string, { scope: Scope.Closeable; close: ObservationClose }>();
  private activation = 0;
  private discoveryRevision = 0;
  private referenceRevision = 0;
  private preservationRevision = 0;
  private deferredFacts: {
    changes: RecoveryChange[];
    result?: OperationResult;
    forcePublication: boolean;
  }[] = [];
  private refreshing = new Map<string, Fiber.Fiber<void, ApplicationError>>();
  private refreshPending = new Set<string>();
  private pendingPublication?: {
    request: CommandInput<'persistRecovery'>;
    onConfirmed?: () => Promise<void>;
    kind: 'recovery' | 'close' | 'reload';
    savedRequests: string[];
    captureRevision: number;
  };
  private scheduled?: Fiber.Fiber<void, ApplicationError>;
  private scheduleGeneration = 0;
  private snapshot!: EditorSnapshot;
  private scope: Scope.Closeable;
  constructor(scope: Scope.Closeable, options: EditorDependencies) {
    this.scope = scope;
    this.client = options.client;
    this.clientId = options.clientId ?? crypto.randomUUID();
    if (!this.clientId.trim())
      throw Error('An editor requires its own nonempty recovery client ID.');
    this.recovery = emptyRecovery(this.clientId);
    this.emit();
  }
  bind<R, E extends ApplicationError>(runtime: ManagedRuntime.ManagedRuntime<R, E>) {
    if (this.bound)
      throw new ApplicationError({ code: 'InvalidInput', message: 'Editor model already bound.' });
    this.bound = true;
    this.runEffect = (effect) => runApplicationEffect(runtime, effect);
    return this;
  }
  private run<A>(
    effect: Effect.Effect<A, ApplicationError>,
    scope: Scope.Scope = this.scope,
  ): Promise<A> {
    return this.runEffect(
      Effect.flatMap(Effect.forkIn(effect, scope, { startImmediately: true }), Fiber.join),
    );
  }
  private cancelScheduled() {
    this.scheduleGeneration++;
    if (this.scheduled) void this.runEffect(Fiber.interrupt(this.scheduled)).catch(this.report);
    this.scheduled = undefined;
  }
  private releaseObservation(key: string): Promise<void> {
    const observation = this.stops.get(key);
    if (!observation) return Promise.resolve();
    this.stops.delete(key);
    return this.runEffect(Scope.close(observation.scope, Exit.void)).catch((error) => {
      this.cleanupFailures.push(ApplicationError.fromUnknown(error));
      throw error;
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private emit(force = false) {
    if (this.closing && !force) return;
    this.snapshot = {
      ready: this.ready,
      recoveryReady:
        this.ready &&
        !this.loading &&
        !this.closing &&
        !this.preserving &&
        this.captureRevision === this.confirmedCapture &&
        this.publications === 0 &&
        !this.pendingPublication &&
        ![...this.buffers.values()].some((buffer) => buffer.saving || buffer.pendingSave) &&
        ![...this.operations.values()].some((value) => !value.acknowledged),
      disposed: this.disposed,
      closePrompt: this.closePrompt && structuredClone(this.closePrompt),
      preserving: this.preserving,
      discoveryRevision: this.discoveryRevision,
      recovery: structuredClone(this.recovery),
      buffers: structuredClone([...this.buffers.values()]),
      comparisons: { ...this.comparisons },
      listings: { ...this.listings },
      git: { ...this.git },
      publication: this.pendingPublication && {
        requestId: this.pendingPublication.request.requestId,
        kind: this.pendingPublication.kind,
      },
      errors: [...this.errors],
      operations: [...this.operations.values()]
        .filter((value) => !value.acknowledged)
        .map((value) => structuredClone(value.result)),
    };
    for (const listener of this.listeners) listener();
  }
  report = (error: unknown) => {
    if (this.closing) return;
    this.errors = [...this.errors.slice(-19), ApplicationError.fromUnknown(error).message];
    this.emit();
  };
  clearErrors() {
    this.errors = [];
    this.emit();
  }
  private assertReady() {
    if (this.closing || !this.ready)
      throw Error(this.closing ? 'Editor disposed.' : 'Load editor recovery first.');
  }
  private checkout(target: CheckoutTarget, requireOpen = true) {
    this.assertReady();
    if (
      !this.recovery.checkouts.some((item) => sameCheckout(item, target)) ||
      (requireOpen && !this.recovery.openCheckoutIds.includes(target.checkoutId))
    )
      throw Error('This exact checkout is not open in this editor.');
    return (
      readOwn(this.recovery.views, target.checkoutId) ??
      writeOwn(this.recovery.views, target.checkoutId, view())
    );
  }
  private async command<K extends WorkspaceCommand>(
    name: K,
    input: CommandInput<K>,
    scope: Scope.Scope = this.scope,
  ): Promise<CommandOutput<K>> {
    if (this.closing)
      throw new ApplicationError({ code: 'Unavailable', message: 'Editor disposed.' });
    try {
      return await this.run(
        Effect.tryPromise({
          try: (signal) => this.client.command(name, input, { signal }),
          catch: ApplicationError.fromUnknown,
        }),
        scope,
      );
    } catch (error) {
      if (!ApplicationError.is(error) || error.code !== 'Cancelled') this.report(error);
      throw error;
    }
  }
  async load() {
    if (this.ready) return;
    this.loading = true;
    const loaded = await this.command('loadRecovery', { clientId: this.clientId });
    try {
      decodeEditorRecovery(loaded.state);
    } catch (error) {
      this.report(error);
      throw error;
    }
    if (this.closing) return;
    if (loaded.state.clientId !== this.clientId)
      throw Error('Recovery belongs to another editor client.');
    this.recovery = decodeEditorRecovery(loaded.state);
    this.revision = loaded.revision;
    this.errors.push(...loaded.errors);
    for (const draft of this.recovery.drafts) {
      this.buffers.set(fileKey(draft.target), { ...structuredClone(draft), saving: false });
      const selected =
        readOwn(this.recovery.views, draft.target.checkout.checkoutId) ??
        writeOwn(this.recovery.views, draft.target.checkout.checkoutId, view());
      if (!selected.openFiles.includes(draft.target.path))
        selected.openFiles.push(draft.target.path);
      if (selected.preview === draft.target.path) selected.preview = null;
    }
    for (const result of loaded.operations)
      this.operations.set(operationKey(result.clientId, result.id), { result, applied: new Set() });
    this.ready = true;
    if (loaded.operations.length)
      try {
        await this.publishFacts([], undefined, loaded);
      } catch (error) {
        this.report(error);
      }
    const selectedCheckoutId = this.recovery.selectedCheckoutId;
    for (const checkout of this.recovery.checkouts.filter((target) =>
      this.recovery.openCheckoutIds.includes(target.checkoutId),
    )) {
      if (this.closing) break;
      await this.observe(checkout);
      const selected = readOwn(this.recovery.views, checkout.checkoutId);
      if (selected?.active)
        await this.open(
          { checkout, path: selected.active },
          { view: readOwn(selected.fileViews, selected.active) ?? 'file' },
        );
      await this.refresh(checkout);
    }
    this.recovery.selectedCheckoutId = selectedCheckoutId;
    this.loading = false;
    this.changed();
  }
  private async observe(checkout: CheckoutTarget) {
    const key = checkoutKey(checkout);
    await this.releaseObservation(key);
    if (this.closing) return;
    const scope = Scope.forkUnsafe(this.scope);
    let close: ObservationClose | undefined;
    await this.runEffect(
      Effect.gen({ self: this }, function* () {
        yield* Scope.addFinalizer(
          scope,
          Effect.suspend(() =>
            close
              ? Effect.tryPromise({
                  try: close,
                  catch: ApplicationError.fromUnknown,
                }).pipe(Effect.orDie)
              : Effect.void,
          ),
        );
        close = this.client.watch(
          { checkout, paths: [''] },
          (event) => {
            if (
              this.closing ||
              !this.recovery.openCheckoutIds.includes(checkout.checkoutId) ||
              !sameCheckout(event.checkout, checkout) ||
              this.stops.get(key)?.scope !== scope
            )
              return;
            if (event.error) this.report(event.error);
            if (event.ready) return;
            this.discoveryRevision++;
            void this.reconcileRecovery().catch(this.report);
            void this.refresh(checkout).catch(this.report);
          },
          this.report,
        );
        this.stops.set(key, { scope, close });
      }),
    );
  }
  async openCheckout(root: string) {
    this.assertReady();
    const target = await this.command('openCheckout', { root });
    if (this.closing) return target;
    const collision = this.recovery.checkouts.find(
      (item) => item.checkoutId === target.checkoutId && !sameCheckout(item, target),
    );
    if (collision) throw Error('Checkout identity changed; retained work has not been rebound.');
    if (!this.recovery.checkouts.some((item) => sameCheckout(item, target))) {
      this.recovery.checkouts.push(target);
      writeOwn(this.recovery.views, target.checkoutId, view());
    }
    const reopening = !this.recovery.openCheckoutIds.includes(target.checkoutId);
    if (reopening) {
      this.recovery.openCheckoutIds.push(target.checkoutId);
      await this.observe(target);
    }
    await this.selectCheckout(target);
    await this.refresh(target);
    return target;
  }
  selectCheckout(target: CheckoutTarget) {
    this.checkout(target);
    this.activation++;
    this.recovery.selectedCheckoutId = target.checkoutId;
    this.changed();
    return this.activateSelected();
  }
  private async activateSelected() {
    if (this.closing || this.preserving) return false;
    const checkout = this.recovery.checkouts.find(
      (target) => target.checkoutId === this.recovery.selectedCheckoutId,
    );
    const path = checkout && readOwn(this.recovery.views, checkout.checkoutId)?.active;
    if (!checkout || !path) return true;
    const key = fileKey({ checkout, path }),
      mode = readOwn(this.checkout(checkout).fileViews, path) ?? 'file';
    const attempt = this.comparisonAttempts.get(key),
      working = this.comparisons[key]?.working;
    // A failed activation stays settled for that working version, not future availability.
    const needsWorking =
      !this.buffers.has(key) &&
      working != null &&
      working.version !== attempt?.failedWorkingVersion;
    if (mode === 'file' ? this.buffers.has(key) : attempt?.mode === mode && !needsWorking)
      return true;
    return this.open(
      { checkout, path },
      {
        current: () =>
          this.recovery.selectedCheckoutId === checkout.checkoutId &&
          readOwn(this.recovery.views, checkout.checkoutId)?.active === path,
      },
    );
  }
  private resumeFacts() {
    if (this.closing || this.preserving || this.pendingPublication) return;
    // A pre-capture recovery snapshot may predate a committed Discard; fetch fresh state.
    for (const request of this.deferredFacts.splice(0))
      void this.publishFacts(
        request.changes,
        request.result,
        undefined,
        request.forcePublication,
      ).catch(this.report);
  }
  private async releasePreservation() {
    if (this.closing) return;
    if (this.pendingPublication?.onConfirmed) return;
    this.preserving = false;
    this.emit();
    this.resumeFacts();
    await this.activateSelected();
    this.schedule();
  }
  private invalidateRecovery() {
    this.captureRevision++;
    this.emit();
  }
  private changed() {
    this.invalidateRecovery();
    this.schedule();
  }
  private schedule() {
    if (!this.ready || this.loading || this.closing || this.preserving || this.pendingPublication)
      return;
    this.cancelScheduled();
    const generation = this.scheduleGeneration;
    void this.runEffect(
      Effect.forkIn(
        Effect.sleep('150 millis').pipe(
          Effect.flatMap(() => {
            if (generation !== this.scheduleGeneration || this.closing) return Effect.void;
            this.scheduled = undefined;
            return Effect.tryPromise({
              try: () => this.flush(),
              catch: ApplicationError.fromUnknown,
            });
          }),
          Effect.catch((error) => Effect.sync(() => this.report(error))),
        ),
        this.scope,
      ),
    )
      .then((fiber) => {
        if (!this.closing && generation === this.scheduleGeneration) this.scheduled = fiber;
        else void this.runEffect(Fiber.interrupt(fiber)).catch(this.report);
      })
      .catch(this.report);
  }
  private capture(savedRequests: string[] = []): EditorRecovery {
    const state = structuredClone(this.recovery);
    state.drafts = [...this.buffers.values()]
      .filter(
        (buffer) =>
          buffer.text !== buffer.disk.text ||
          (buffer.pendingSave && !savedRequests.includes(buffer.pendingSave.requestId)),
      )
      .map(({ target, text, disk }) => structuredClone({ target, text, disk }));
    return state;
  }
  private async confirmPublication(
    request: CommandInput<'persistRecovery'>,
    receipt: RecoveryPublication,
    onConfirmed: (() => Promise<void>) | undefined,
    savedRequests: string[],
    captureRevision: number,
  ) {
    if (this.closing)
      throw new ApplicationError({ code: 'Cancelled', message: 'Editor disposed.' });
    if (
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
    for (const id of savedRequests) {
      this.saveResults.delete(id);
      for (const buffer of this.buffers.values())
        if (buffer.pendingSave?.requestId === id) buffer.pendingSave = undefined;
    }
    await onConfirmed?.();
    this.confirmedCapture = captureRevision;
    this.resumeFacts();
    this.emit();
  }
  private publicationBlocked() {
    if (!this.pendingPublication) return false;
    this.report(
      'Recovery publication PENDING/UNCERTAIN. Resolve its exact identity before Save, Reload, file operations, Close or Quit.',
    );
    return true;
  }
  private publish(
    state: EditorRecovery,
    {
      onConfirmed,
      kind = 'close',
      before,
      savedRequests = [],
    }: {
      onConfirmed?: () => Promise<void>;
      kind?: 'close' | 'reload';
      before?: () => void;
      savedRequests?: string[];
    } = {},
  ) {
    const captured = structuredClone(state),
      captureRevision = this.captureRevision;
    this.publications++;
    this.emit();
    const next = this.run(
      this.recoveryLock.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            if (this.closing)
              throw new ApplicationError({ code: 'Cancelled', message: 'Editor disposed.' });
            before?.();
            if (this.publicationBlocked())
              throw new ApplicationError({
                code: 'Uncertain',
                message: 'Resolve the pending recovery publication first.',
              });
            const request = {
              clientId: this.clientId,
              requestId: crypto.randomUUID(),
              expectedRevision: this.revision,
              state: captured,
            };
            let receipt: RecoveryPublication;
            try {
              receipt = await this.command('persistRecovery', request);
            } catch (error) {
              if (this.closing) throw error;
              if (ApplicationError.is(error) && ['InvalidInput', 'Conflict'].includes(error.code))
                throw error;
              this.pendingPublication = {
                request,
                onConfirmed,
                kind: onConfirmed ? kind : 'recovery',
                savedRequests,
                captureRevision,
              };
              this.emit();
              const known = await this.command('getRecoveryPublication', {
                clientId: request.clientId,
                requestId: request.requestId,
              }).catch(() => null);
              if (!known) {
                this.report(
                  'Recovery publication PENDING/UNCERTAIN. Live work and the immutable request are retained; null status does not prove failure.',
                );
                throw error;
              }
              receipt = known;
            }
            // Retain identity even when a malformed/mismatched receipt cannot be accepted.
            this.pendingPublication = {
              request,
              onConfirmed,
              kind: onConfirmed ? kind : 'recovery',
              savedRequests,
              captureRevision,
            };
            await this.confirmPublication(
              request,
              receipt,
              onConfirmed,
              savedRequests,
              captureRevision,
            );
          },
          catch: ApplicationError.fromUnknown,
        }),
      ),
    )
      .catch((error) => {
        if (!this.closing) this.confirmedCapture = -1;
        throw error;
      })
      .finally(() => {
        if (!this.closing) {
          this.publications--;
          this.emit();
        }
      });
    return next;
  }
  async resolveRecoveryPublication(): Promise<boolean> {
    if (this.closing) return false;
    let rejected = false;
    const next = this.run(
      this.recoveryLock.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const pending = this.pendingPublication;
            if (!pending || this.closing) return !this.closing;
            try {
              const { request, onConfirmed, savedRequests, captureRevision } = pending;
              let receipt = await this.command('getRecoveryPublication', {
                clientId: request.clientId,
                requestId: request.requestId,
              });
              if (!receipt) {
                try {
                  receipt = await this.command('persistRecovery', request);
                } catch (error) {
                  // Matching committed requests return their receipt before CAS; only this retry's Conflict proves rejection.
                  if (this.closing || !ApplicationError.is(error) || error.code !== 'Conflict')
                    throw error;
                  this.pendingPublication = undefined;
                  rejected = true;
                  this.report(
                    onConfirmed
                      ? 'The original Close/Reload publication did not commit. Drafts retained; choose the action again.'
                      : 'The original recovery publication did not commit. Retained facts will reconcile into a fresh capture.',
                  );
                  if (onConfirmed) await this.releasePreservation();
                  else this.resumeFacts();
                  return !onConfirmed;
                }
              }
              if (this.closing) return false;
              await this.confirmPublication(
                request,
                receipt,
                onConfirmed,
                savedRequests,
                captureRevision,
              );
              this.schedule();
              return true;
            } catch (error) {
              this.report(error);
              this.publicationBlocked();
              return false;
            }
          },
          catch: ApplicationError.fromUnknown,
        }),
      ),
    );
    const resolved = await next;
    // Rejoin after the publication tail settles; never run a rejected destructive callback.
    if (rejected && !this.closing)
      try {
        await this.publishFacts([], undefined, undefined, true);
      } catch (error) {
        this.report(error);
        return false;
      }
    return resolved;
  }
  async flush() {
    this.assertReady();
    if (this.preserving) throw Error('Finish the captured preservation action before flushing.');
    this.cancelScheduled();
    await this.publish(this.capture());
  }
  buffer(target: FileTarget): Readonly<EditorBuffer> | undefined {
    return this.snapshot.buffers.find((buffer) => fileKey(buffer.target) === fileKey(target));
  }
  edit(target: FileTarget, text: string) {
    this.checkout(target.checkout);
    validPath(target.path);
    if (this.preserving) throw Error('Finish the captured preservation action first.');
    if (new TextEncoder().encode(text).length > maximumFileBytes)
      throw Error('Editable text exceeds 2 MiB.');
    const buffer = this.buffers.get(fileKey(target));
    if (!buffer) throw Error('Open this file before editing it.');
    buffer.text = text;
    if (text !== buffer.disk.text) this.keepOpen(target);
    this.changed();
  }
  keepOpen(target: FileTarget) {
    const selected = this.checkout(target.checkout);
    if (selected.preview === target.path) {
      selected.preview = null;
      this.changed();
    }
  }
  async open(
    target: FileTarget,
    options: { view?: FileView; intent?: 'preview' | 'keep'; current?: () => boolean } = {},
  ) {
    const selected = this.checkout(target.checkout);
    validPath(target.path);
    if (this.preserving) return false;
    const generation = ++this.activation;
    const previous = this.selection;
    const selection = (this.selection = Scope.forkUnsafe(this.scope));
    if (previous) void this.runEffect(Scope.close(previous, Exit.void)).catch(this.report);
    const current = () =>
      !this.closing &&
      !this.preserving &&
      generation === this.activation &&
      (options.current?.() ?? true) &&
      this.recovery.openCheckoutIds.includes(target.checkout.checkoutId) &&
      this.recovery.checkouts.some((item) => sameCheckout(item, target.checkout));
    const key = fileKey(target),
      mode = options.view ?? readOwn(selected.fileViews, target.path) ?? 'file';
    try {
      let disk: FileDocument | null, comparison: Comparison | undefined;
      if (mode === 'file' || mode === 'conflict') {
        try {
          disk = await this.command('readFile', target, selection);
        } catch (error) {
          if (!current() || !this.buffers.has(key)) throw error;
          this.report('File unavailable on disk. Retained buffer and edits remain accessible.');
          disk = null;
        }
      } else {
        try {
          comparison = await this.command('readComparison', { target, area: mode }, selection);
          disk = comparison.working;
        } catch (error) {
          if (!current() || !this.buffers.has(key)) throw error;
          this.report('Comparison unavailable. Retained buffer and edits remain accessible.');
          disk = null;
          comparison = this.comparisons[key];
        }
      }
      if (!current()) return false;
      if (mode === 'file') this.comparisonAttempts.delete(key);
      else this.comparisonAttempts.set(key, { mode });
      let buffer = this.buffers.get(key);
      if (!buffer && disk) {
        buffer = { target, text: disk.text, disk, saving: false };
        this.buffers.set(key, buffer);
      } else if (buffer && disk && buffer.text === buffer.disk.text && !buffer.pendingSave) {
        buffer.disk = disk;
        buffer.text = disk.text;
      }
      if (buffer && disk && buffer.disk.version !== disk.version) buffer.conflict = disk;
      if (mode === 'conflict')
        comparison = disk
          ? { original: disk.text, working: disk, title: 'Disk versus your edits' }
          : this.comparisons[key];
      if (comparison) this.comparisons[key] = comparison;
      else delete this.comparisons[key];
      if (comparison?.error) this.report(comparison.error);
      if (!selected.openFiles.includes(target.path)) {
        const previous = selected.preview;
        if (options.intent === 'preview' && previous && previous !== target.path) {
          const oldKey = fileKey({ checkout: target.checkout, path: previous }),
            old = this.buffers.get(oldKey);
          if (!old || (old.text === old.disk.text && !old.pendingSave)) {
            selected.openFiles = selected.openFiles.filter((path) => path !== previous);
            this.buffers.delete(oldKey);
            delete this.comparisons[oldKey];
            this.comparisonAttempts.delete(oldKey);
          }
        }
        selected.openFiles.splice(selected.openFiles.indexOf(selected.active) + 1, 0, target.path);
        if (options.intent === 'preview' && (!buffer || buffer.text === buffer.disk.text))
          selected.preview = target.path;
      }
      if (options.intent === 'keep')
        selected.preview = selected.preview === target.path ? null : selected.preview;
      selected.active = target.path;
      writeOwn(selected.fileViews, target.path, mode);
      this.recovery.selectedCheckoutId = target.checkout.checkoutId;
      this.recovery.recentFiles = [
        target,
        ...this.recovery.recentFiles.filter((item) => fileKey(item) !== key),
      ].slice(0, 100);
      this.changed();
      return true;
    } catch {
      if (current() && mode !== 'file')
        this.comparisonAttempts.set(key, {
          mode,
          failedWorkingVersion: this.comparisons[key]?.working?.version,
        });
      return false;
    }
  }
  async save(target: FileTarget, overwrite = false): Promise<boolean> {
    return this.saveFile(target, overwrite);
  }
  private async saveFile(
    target: FileTarget,
    overwrite = false,
    preservation?: number,
  ): Promise<boolean> {
    this.checkout(target.checkout);
    if (this.publicationBlocked()) return false;
    if (this.uncertainAffects(target)) {
      this.report('Resolve the pending file operation before saving this file.');
      return false;
    }
    const buffer = this.buffers.get(fileKey(target));
    if (!buffer || buffer.saving) return false;
    const request = buffer.pendingSave ?? {
      target: structuredClone(target),
      clientId: this.clientId,
      requestId: crypto.randomUUID(),
      text: buffer.text,
      expectedVersion: overwrite && buffer.conflict ? buffer.conflict.version : buffer.disk.version,
    };
    buffer.pendingSave = request;
    buffer.saving = true;
    this.emit();
    try {
      const result =
        this.saveResults.get(request.requestId) ??
        (await this.command('saveFile', request).catch((error) => {
          if (!this.closing && definitiveNonAdmission(error)) buffer.pendingSave = undefined;
          throw error;
        }));
      if (this.closing) return false;
      if (result.kind === 'conflict') {
        buffer.pendingSave = undefined;
        buffer.conflict = result.disk;
        this.report(
          'Disk changed. Your edits are retained. Compare, overwrite this version, reload or cancel.',
        );
        return false;
      }
      if (result.persistencePending) {
        this.report(
          result.message ??
            'Saved on disk; recovery is uncertain. Edits retained. Retry the same Save before closing.',
        );
        return false;
      }
      this.saveResults.set(request.requestId, structuredClone(result));
      buffer.disk = result.disk;
      buffer.conflict = undefined;
      this.invalidateRecovery();
      await this.publishFacts([], undefined, undefined, true, preservation);
      return !buffer.pendingSave && buffer.text === result.disk.text;
    } finally {
      if (!this.closing) {
        buffer.saving = false;
        this.emit();
      }
    }
  }
  async reload(target: FileTarget) {
    const captured = structuredClone(target),
      key = fileKey(captured);
    this.checkout(captured.checkout);
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.pendingSave || this.preserving || this.publicationBlocked()) return false;
    this.preserving = true;
    this.preservationRevision++;
    this.activation++;
    this.emit();
    const reference = this.referenceRevision,
      revision = this.revision;
    const sameBuffer = () =>
      this.buffers.get(key) === buffer &&
      fileKey(buffer.target) === key &&
      this.referenceRevision === reference;
    const guard = () => {
      if (this.closing || !sameBuffer() || this.revision !== revision)
        throw Error(
          'Captured Reload target or recovery revision changed. Edits retained; reconcile and retry.',
        );
    };
    try {
      const disk = await this.command('readFile', captured);
      guard();
      const state = this.capture();
      state.drafts = state.drafts.filter((item) => fileKey(item.target) !== key);
      await this.publish(state, {
        onConfirmed: async () => {
          if (sameBuffer()) {
            buffer.disk = disk;
            buffer.text = disk.text;
            buffer.conflict = undefined;
            if (readOwn(this.checkout(captured.checkout).fileViews, captured.path) === 'conflict') {
              this.comparisons[key] = {
                original: disk.text,
                working: disk,
                title: 'Disk versus your edits',
              };
              this.comparisonAttempts.set(key, { mode: 'conflict' });
            }
          } else
            this.report(
              'Reload committed for its original target; a changed live buffer was retained.',
            );
          await this.releasePreservation();
        },
        kind: 'reload',
        before: guard,
      });
      return true;
    } finally {
      if (this.preserving && !this.pendingPublication?.onConfirmed)
        await this.releasePreservation();
    }
  }
  cancelConflict(target: FileTarget) {
    const buffer = this.buffers.get(fileKey(target));
    if (buffer) buffer.conflict = undefined;
    const selected = this.checkout(target.checkout);
    if (readOwn(selected.fileViews, target.path) === 'conflict')
      writeOwn<FileView>(selected.fileViews, target.path, 'file');
    this.changed();
  }
  position(target: FileTarget, mode: FileView | `${FileView}:original`, position: EditorPosition) {
    if (this.closing || this.preserving) return;
    if (
      !this.recovery.openCheckoutIds.includes(target.checkout.checkoutId) ||
      !this.recovery.checkouts.some((item) => sameCheckout(item, target.checkout))
    )
      return;
    const selected = readOwn(this.recovery.views, target.checkout.checkoutId);
    if (!selected) return;
    if (!selected.openFiles.includes(target.path)) return;
    const positions =
      readOwn(selected.positions, target.path) ?? writeOwn(selected.positions, target.path, {});
    writeOwn(positions, mode, position);
    this.changed();
  }
  reorder(checkout: CheckoutTarget, from: string, to: number) {
    const selected = this.checkout(checkout);
    if (this.preserving || !selected.openFiles.includes(from)) return;
    selected.openFiles.splice(selected.openFiles.indexOf(from), 1);
    selected.openFiles.splice(Math.max(0, Math.min(to, selected.openFiles.length)), 0, from);
    this.keepOpen({ checkout, path: from });
    this.changed();
  }
  navigate(checkout: CheckoutTarget, direction: 1 | -1) {
    const selected = this.checkout(checkout),
      paths = selected.openFiles;
    if (!paths.length) return Promise.resolve(false);
    const next = (paths.indexOf(selected.active) + direction + paths.length) % paths.length;
    return this.open({ checkout, path: paths[next] });
  }
  answerClose(promptId: string, choice: CloseChoice) {
    if (
      !this.closeAnswer ||
      this.closePrompt?.id !== promptId ||
      !['save', 'discard', 'cancel'].includes(choice)
    )
      return;
    Deferred.doneUnsafe(this.closeAnswer, Effect.succeed(choice));
  }
  async close(targets: FileTarget[]) {
    return this.preserve(targets, 'files');
  }
  async closeCheckout(checkout: CheckoutTarget) {
    const selected = this.checkout(checkout);
    return this.preserve(
      selected.openFiles.map((path) => ({ checkout, path })),
      'checkout',
      checkout,
    );
  }
  async prepareQuit() {
    return this.preserve(
      [...this.buffers.values()].map((buffer) => buffer.target),
      'quit',
    );
  }
  private async preserve(
    targets: FileTarget[],
    kind: 'files' | 'checkout' | 'quit',
    checkout?: CheckoutTarget,
  ) {
    this.assertReady();
    if (
      this.publicationBlocked() ||
      this.preserving ||
      [...this.buffers.values()].some((buffer) => buffer.saving || buffer.pendingSave)
    )
      return false;
    const captured = [
      ...new Map(targets.map((target) => [fileKey(target), structuredClone(target)])).values(),
    ];
    if (captured.some((target) => this.uncertainAffects(target))) {
      this.report('Resolve pending file operations before closing their files.');
      return false;
    }
    this.preserving = true;
    this.preservationRevision++;
    this.activation++;
    this.cancelScheduled();
    this.emit();
    let committed = false;
    let commitClose: (() => Promise<void>) | undefined;
    const referenceRevision = this.referenceRevision;
    const discarded = new Set<string>();
    try {
      for (const target of captured) {
        const buffer = this.buffers.get(fileKey(target));
        if (!buffer || buffer.text === buffer.disk.text) continue;
        const answer = Deferred.makeUnsafe<CloseChoice>();
        const prompt = { id: crypto.randomUUID(), buffer: structuredClone(buffer) };
        this.closeAnswer = answer;
        this.closePrompt = prompt;
        this.emit();
        const choice = await this.run(Deferred.await(answer));
        if (this.closePrompt?.id === prompt.id) {
          this.closePrompt = null;
          this.closeAnswer = undefined;
          this.emit();
        }
        if (this.closing) return false;
        if (choice === 'cancel') return false;
        if (choice === 'discard') discarded.add(fileKey(target));
        else if (!(await this.saveFile(target, false, this.preservationRevision))) return false;
      }
      if (referenceRevision !== this.referenceRevision)
        throw Error(
          'Files moved during the captured close. Edits retained; review their new paths and retry.',
        );
      const keys = new Set(captured.map(fileKey));
      const history: ClosedAction[] = [];
      const applyClose = (state: EditorRecovery, remember = false) => {
        state.drafts = state.drafts.filter(
          (draft) =>
            !discarded.has(fileKey(draft.target)) &&
            (kind === 'quit' || !keys.has(fileKey(draft.target))),
        );
        if (kind === 'files')
          for (const target of state.checkouts) {
            const selected = readOwn(state.views, target.checkoutId);
            if (!selected) continue;
            const closing = selected.openFiles.filter((path) =>
              keys.has(fileKey({ checkout: target, path })),
            );
            if (!closing.length) continue;
            if (remember)
              history.push({
                checkout: target,
                active: closing.includes(selected.active) ? selected.active : closing.at(-1)!,
                files: closing.map((path) => ({
                  path,
                  index: selected.openFiles.indexOf(path),
                  view: readOwn(selected.fileViews, path) ?? 'file',
                  positions: structuredClone(readOwn(selected.positions, path)),
                })),
              });
            selected.openFiles = selected.openFiles.filter((path) => !closing.includes(path));
            if (closing.includes(selected.active))
              selected.active =
                state.recentFiles.find(
                  (item) =>
                    sameCheckout(item.checkout, target) && selected.openFiles.includes(item.path),
                )?.path ??
                selected.openFiles[0] ??
                '';
            if (selected.preview && closing.includes(selected.preview)) selected.preview = null;
          }
        if (kind === 'checkout' && checkout) {
          state.openCheckoutIds = state.openCheckoutIds.filter((id) => id !== checkout.checkoutId);
          if (state.selectedCheckoutId === checkout.checkoutId)
            state.selectedCheckoutId = state.openCheckoutIds[0] ?? null;
        }
        return state;
      };
      let preflight = this.capture();
      for (;;) {
        await this.publish(preflight);
        if (referenceRevision !== this.referenceRevision)
          throw Error(
            'Files moved during the captured close. Edits retained; review their new paths and retry.',
          );
        const latest = this.capture();
        if (JSON.stringify(latest) === JSON.stringify(preflight)) break;
        preflight = latest;
      }
      const state = applyClose(this.capture(), true);
      commitClose = async () => {
        committed = true; // The exact final receipt is the close outcome; later IO cannot veto it.
        // A confirmed close overrides older Copy materialization only for these exact targets.
        for (const known of this.operations.values())
          if (known.result.kind === 'copy' && known.copies)
            for (const target of captured)
              if (sameCheckout(target.checkout, known.result.checkout))
                (known.closedCopyTargets ??= new Set()).add(fileKey(target));
        applyClose(this.recovery);
        this.recovery.drafts = state.drafts;
        if (kind === 'quit')
          for (const key of discarded) {
            const buffer = this.buffers.get(key)!;
            buffer.text = buffer.disk.text;
            buffer.conflict = undefined;
          }
        else {
          this.history = [...this.history, ...history].slice(-20);
          for (const key of keys) {
            this.buffers.delete(key);
            delete this.comparisons[key];
            this.comparisonAttempts.delete(key);
          }
          if (kind === 'checkout' && checkout) {
            try {
              await this.releaseObservation(checkoutKey(checkout));
            } catch (error) {
              this.report(error);
            }
            this.stops.delete(checkoutKey(checkout));
          }
        }
        await this.releasePreservation();
      };
      await this.publish(state, { onConfirmed: commitClose });
      return true;
    } catch (error) {
      this.report(error);
      return committed;
    } finally {
      if (this.preserving && !this.pendingPublication?.onConfirmed)
        await this.releasePreservation();
    }
  }
  async reopen(checkout: CheckoutTarget) {
    const selected = this.checkout(checkout);
    if (this.preserving) return false;
    const index = this.history.findLastIndex((action) => sameCheckout(action.checkout, checkout));
    if (index < 0) return false;
    const action = this.history[index];
    for (const file of action.files)
      if (!selected.openFiles.includes(file.path)) {
        selected.openFiles.splice(Math.min(file.index, selected.openFiles.length), 0, file.path);
        writeOwn(selected.fileViews, file.path, file.view);
        if (file.positions)
          writeOwn(selected.positions, file.path, structuredClone(file.positions));
      }
    selected.active = action.active;
    selected.preview = null;
    this.invalidateRecovery();
    const success = await this.open({ checkout, path: action.active });
    await this.flush();
    this.history.splice(index, 1);
    this.emit();
    return success;
  }
  tree(checkout: CheckoutTarget, patch: Partial<CheckoutView['tree']>) {
    const selected = this.checkout(checkout);
    selected.tree = { ...selected.tree, ...patch };
    this.changed();
  }
  resizeSidebar(width: number) {
    if (this.closing) return;
    this.recovery.sidebarWidth = Math.max(190, Math.min(380, Math.round(width)));
    this.changed();
  }
  list(checkout: CheckoutTarget, path = '') {
    return this.listIn(checkout, path, this.stops.get(checkoutKey(checkout))?.scope ?? this.scope);
  }
  private async listIn(checkout: CheckoutTarget, path: string, scope: Scope.Scope) {
    const selected = this.checkout(checkout);
    validPath(path, true);
    const listing = await this.command(
      'listDirectory',
      {
        checkout,
        path,
        hideIgnored: selected.tree.hideIgnored,
      },
      scope,
    );
    if (this.closing || !this.recovery.openCheckoutIds.includes(checkout.checkoutId))
      return listing;
    this.listings[JSON.stringify([checkoutKey(checkout), path])] = listing;
    this.emit();
    return listing;
  }
  async reveal(target: FileTarget, showIgnored = false) {
    const selected = this.checkout(target.checkout);
    validPath(target.path);
    const parts = target.path.split('/'),
      expanded: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      const listing = await this.command('listDirectory', {
        checkout: target.checkout,
        path: parts.slice(0, i).join('/'),
        hideIgnored: false,
      });
      const entry = listing.entries.find((item) => item.path === path);
      if (!entry) throw Error(listing.error ?? 'Active file unavailable. Refresh and retry.');
      if (entry.ignored && selected.tree.hideIgnored && !showIgnored)
        throw Error('Active file is hidden. Turn off Hide Git-ignored files and reveal again.');
      if (i < parts.length - 1) expanded.push(path);
    }
    this.tree(target.checkout, {
      expanded: [...new Set([...selected.tree.expanded, ...expanded])],
      focus: target.path,
      selected: [target.path],
      ...(showIgnored ? { hideIgnored: false } : {}),
    });
    await Promise.all(['', ...expanded].map((path) => this.list(target.checkout, path)));
  }
  async lookup(checkout: CheckoutTarget, query: string) {
    this.checkout(checkout);
    return this.command('lookupFiles', {
      checkout,
      query,
      limit: 100,
      history: this.recovery.recentFiles
        .filter((item) => sameCheckout(item.checkout, checkout))
        .map((item) => item.path),
    });
  }
  async refresh(checkout: CheckoutTarget): Promise<void> {
    this.checkout(checkout);
    const key = checkoutKey(checkout);
    const existing = this.refreshing.get(key);
    if (existing) {
      this.refreshPending.add(key);
      return this.runEffect(Fiber.join(existing));
    }
    const scope = this.stops.get(key)?.scope ?? this.scope;
    const work = Effect.tryPromise({
      try: async () => {
        do {
          this.refreshPending.delete(key);
          await this.refreshOnce(checkout);
        } while (
          this.refreshPending.has(key) &&
          !this.closing &&
          this.recovery.openCheckoutIds.includes(checkout.checkoutId)
        );
      },
      catch: ApplicationError.fromUnknown,
    }).pipe(Effect.ensuring(Effect.sync(() => this.refreshing.delete(key))));
    const fiber = await this.runEffect(Effect.forkIn(work, scope));
    this.refreshing.set(key, fiber);
    return this.runEffect(Fiber.join(fiber));
  }
  private async refreshOnce(checkout: CheckoutTarget) {
    const paths = ['', ...this.checkout(checkout).tree.expanded];
    await Promise.allSettled(paths.map((path) => this.list(checkout, path)));
    if (this.closing || !this.recovery.openCheckoutIds.includes(checkout.checkoutId)) return;
    try {
      const status = await this.command(
        'gitStatus',
        { checkout },
        this.stops.get(checkoutKey(checkout))?.scope,
      );
      if (!this.closing && this.recovery.openCheckoutIds.includes(checkout.checkoutId))
        this.git[checkoutKey(checkout)] = status;
    } catch {
      /* The public command already reported the error; retained buffers stay usable. */
    }
    if (this.closing || !this.recovery.openCheckoutIds.includes(checkout.checkoutId)) return;
    const selected = this.checkout(checkout),
      mode = readOwn(selected.fileViews, selected.active),
      generation = this.activation;
    if (selected.active && mode && mode !== 'file' && mode !== 'conflict' && !this.preserving) {
      const target = { checkout, path: selected.active },
        key = fileKey(target);
      try {
        const comparison = await this.command('readComparison', { target, area: mode });
        if (
          !this.closing &&
          !this.preserving &&
          generation === this.activation &&
          selected.active === target.path &&
          readOwn(selected.fileViews, target.path) === mode
        ) {
          this.comparisons[key] = comparison;
          this.comparisonAttempts.set(key, { mode });
          const buffer = this.buffers.get(key);
          if (
            buffer &&
            comparison.working &&
            buffer.text === buffer.disk.text &&
            !buffer.pendingSave
          ) {
            buffer.disk = comparison.working;
            buffer.text = comparison.working.text;
          } else if (
            !buffer &&
            comparison.working &&
            this.recovery.selectedCheckoutId === checkout.checkoutId
          )
            await this.activateSelected();
        }
      } catch {
        /* A failed refresh retains the last comparison and current edits. */
      }
    }
    if (!this.closing) this.emit();
  }
  createLookup() {
    this.assertReady();
    const lookup = new EditorLookup(
      this.scope,
      (effect) => this.runEffect(effect),
      (checkout, query, signal) => {
        this.checkout(checkout);
        return this.client.command(
          'lookupFiles',
          {
            checkout,
            query,
            limit: 100,
            history: this.recovery.recentFiles
              .filter((item) => sameCheckout(item.checkout, checkout))
              .map((item) => item.path),
          },
          { signal },
        );
      },
    );
    this.workflows.add(lookup);
    const stop = lookup.stop.bind(lookup);
    lookup.stop = () => {
      this.workflows.delete(lookup);
      stop();
    };
    return lookup;
  }
  createMutation(action: MutationAction) {
    this.checkout(action.checkout);
    const mutation = new EditorMutation(
      this.scope,
      (effect) => this.runEffect(effect),
      {
        inspect: (checkout, paths, scope) => this.inspectIn(checkout, paths, scope),
        list: (checkout, path, scope) => this.listIn(checkout, path, scope),
        mutate: (operation) => this.mutate(operation),
        resolve: (id) => this.resolveOperation(id),
        pending: (id) => this.operations.has(operationKey(this.clientId, id)),
      },
      action,
    );
    this.workflows.add(mutation);
    const stop = mutation.stop.bind(mutation);
    mutation.stop = () => {
      this.workflows.delete(mutation);
      stop();
    };
    return mutation;
  }
  inspect(checkout: CheckoutTarget, paths: string[]) {
    return this.inspectIn(checkout, paths, this.scope);
  }
  private async inspectIn(checkout: CheckoutTarget, paths: string[], scope: Scope.Scope) {
    this.checkout(checkout);
    paths.forEach((path) => validPath(path));
    return this.command('inspectEntries', { checkout, paths }, scope);
  }
  async mutate(input: Omit<WorkspaceOperation, 'clientId' | 'id'> & { id?: string }) {
    this.checkout(input.checkout);
    if (this.preserving || this.publicationBlocked())
      throw Error('Finish the captured preservation/publication action first.');
    const operation: WorkspaceOperation = {
      ...structuredClone(input),
      clientId: this.clientId,
      id: input.id ?? crypto.randomUUID(),
    };
    if (this.operations.has(operationKey(this.clientId, operation.id)))
      throw Error(
        'Operation already submitted. Resolve its status instead of dispatching it again.',
      );
    if (operation.destination !== undefined)
      validPath(operation.destination, operation.kind === 'import');
    if (
      operation.sources.some((source) => this.uncertainAffects(source.target)) ||
      (operation.destination &&
        this.uncertainAffects({ checkout: operation.checkout, path: operation.destination }))
    )
      throw Error('Resolve the pending operation on these entries before applying another.');
    for (const source of [...operation.sources, ...(operation.replacements ?? [])]) {
      validPath(source.target.path);
      if (!sameCheckout(source.target.checkout, operation.checkout))
        throw Error('A file operation must use one exact checkout.');
    }
    const replacementPaths = [
      ...(operation.replacements ?? []).map((item) => item.target.path),
      ...(operation.destination ? [operation.destination] : []),
    ];
    if (
      [...this.buffers.values()].some(
        (buffer) =>
          sameCheckout(buffer.target.checkout, operation.checkout) &&
          !operation.sources.some((source) => affected(buffer.target.path, source.target.path)) &&
          replacementPaths.some((path) =>
            affected(
              buffer.target.path.normalize('NFC').toLowerCase(),
              path.normalize('NFC').toLowerCase(),
            ),
          ),
      )
    )
      throw Error('Replacement has open buffers. Close them safely before replacing their files.');
    if (
      [...this.buffers.values()].some(
        (buffer) =>
          sameCheckout(buffer.target.checkout, operation.checkout) &&
          operation.sources.some((source) => affected(buffer.target.path, source.target.path)) &&
          (buffer.saving || buffer.pendingSave),
      )
    )
      throw Error('Resolve the source Save before moving or copying it.');
    // Publish dirty source drafts before any external mutation, including Trash.
    await this.flush();
    const uncertain: OperationResult = {
      id: operation.id,
      clientId: this.clientId,
      recoveryChanges: [],
      checkout: operation.checkout,
      kind: operation.kind,
      outcome: 'uncertain',
      items: [],
      message: 'Awaiting operation status.',
    };
    this.operations.set(operationKey(this.clientId, operation.id), {
      operation,
      result: uncertain,
      applied: new Set(),
      copies: structuredClone([...this.buffers.values()]),
    });
    this.emit();
    try {
      const result = await this.command('mutate', operation).catch((error) => {
        if (!this.closing && definitiveNonAdmission(error)) {
          this.operations.delete(operationKey(this.clientId, operation.id));
          this.emit();
        }
        throw error;
      });
      if (
        result.clientId !== operation.clientId ||
        result.id !== operation.id ||
        result.kind !== operation.kind ||
        !sameCheckout(result.checkout, operation.checkout)
      )
        throw Error('Operation response identity mismatch. Original pending evidence retained.');
      await this.publishFacts([], result);
      if (this.recovery.openCheckoutIds.includes(operation.checkout.checkoutId))
        await this.refresh(operation.checkout);
      return result;
    } catch (error) {
      if (this.operations.has(operationKey(this.clientId, operation.id)))
        this.report('Operation outcome unconfirmed. Resolve status before taking further action.');
      throw error;
    }
  }
  async resolveOperation(id: string, operationClientId = this.clientId) {
    const known = this.operations.get(operationKey(operationClientId, id));
    if (!known) throw Error('Unknown operation.');
    const result = await this.command('operationStatus', { clientId: operationClientId, id });
    if (!result) {
      this.report('Operation status unavailable; drafts and original references retained.');
      return null;
    }
    if (result.clientId !== operationClientId || result.id !== id)
      throw Error('Operation status identity mismatch.');
    await this.publishFacts([], result);
    if (this.recovery.openCheckoutIds.includes(result.checkout.checkoutId))
      await this.refresh(result.checkout);
    return result;
  }
  async reconcileRecovery() {
    this.assertReady();
    await this.publishFacts([]);
  }
  private uncertainAffects(target: FileTarget) {
    return [...this.operations.values()].some(({ operation, result }) => {
      if (result.outcome !== 'uncertain' || !sameCheckout(result.checkout, target.checkout))
        return false;
      const paths = operation
        ? [
            ...operation.sources.map((source) => source.target.path),
            ...(operation.destination ? [operation.destination] : []),
          ]
        : result.items.flatMap((item) => [
            item.source,
            ...(item.destination ? [item.destination] : []),
          ]);
      return (
        !paths.length ||
        paths.some((path) => affected(target.path, path) || affected(path, target.path))
      );
    });
  }
  private async applyOperationFacts(
    result: OperationResult,
    durable: EditorRecovery,
    check: () => void,
  ) {
    check();
    const key = operationKey(result.clientId, result.id);
    let known = this.operations.get(key);
    if (!known) {
      known = { result, applied: new Set() };
      this.operations.set(key, known);
    }
    const operation = known.operation;
    if (
      (operation &&
        (result.clientId !== operation.clientId ||
          result.id !== operation.id ||
          result.kind !== operation.kind ||
          !sameCheckout(result.checkout, operation.checkout))) ||
      known.result.kind !== result.kind ||
      !sameCheckout(known.result.checkout, result.checkout) ||
      !this.recovery.checkouts.some((item) => sameCheckout(item, result.checkout))
    )
      throw Error(
        'Operation checkout identity unavailable or changed. Evidence and drafts retained without rebinding.',
      );
    known.result = result;
    this.invalidateRecovery();
    let reconciled = true;
    for (const item of result.items.filter((item) => item.outcome === 'completed')) {
      const itemKey = JSON.stringify([item.source, item.destination]);
      if (known.applied.has(itemKey)) continue;
      if (operation && !operation.sources.some((source) => source.target.path === item.source))
        continue;
      if (
        result.kind === 'move' &&
        item.destination &&
        !this.moveReferences(result.checkout, item.source, item.destination)
      ) {
        reconciled = false;
        continue;
      }
      if (result.kind === 'copy' && item.destination) {
        const durableCopies = durable.drafts.filter(
          (draft) =>
            sameCheckout(draft.target.checkout, result.checkout) &&
            affected(draft.target.path, item.destination!),
        );
        for (const draft of durableCopies)
          if (
            !known.closedCopyTargets?.has(fileKey(draft.target)) &&
            !this.buffers.has(fileKey(draft.target))
          ) {
            this.buffers.set(fileKey(draft.target), { ...structuredClone(draft), saving: false });
            const selected = this.checkout(result.checkout, false);
            if (!selected.openFiles.includes(draft.target.path))
              selected.openFiles.push(draft.target.path);
          }
        for (const buffer of known.copies ?? [])
          if (
            sameCheckout(buffer.target.checkout, result.checkout) &&
            affected(buffer.target.path, item.source) &&
            buffer.text !== buffer.disk.text
          ) {
            const target = {
              checkout: result.checkout,
              path: item.destination + buffer.target.path.slice(item.source.length),
            };
            if (
              !known.closedCopyTargets?.has(fileKey(target)) &&
              !this.buffers.has(fileKey(target))
            ) {
              const disk = await this.command('readFile', target);
              check();
              if (
                known.closedCopyTargets?.has(fileKey(target)) ||
                this.buffers.has(fileKey(target))
              )
                continue;
              this.buffers.set(fileKey(target), { target, disk, text: buffer.text, saving: false });
              const selected = this.checkout(result.checkout, false);
              if (!selected.openFiles.includes(target.path)) selected.openFiles.push(target.path);
            }
          }
      }
      // Trash keeps dirty drafts visible at their original target for manual recovery.
      if (result.kind === 'trash')
        this.history = this.history.flatMap((action) => {
          if (!sameCheckout(action.checkout, result.checkout)) return [action];
          action.files = action.files.filter((file) => !affected(file.path, item.source));
          return action.files.length ? [action] : [];
        });
      known.applied.add(itemKey);
    }
    return reconciled;
  }
  private publishFacts(
    changes: RecoveryChange[],
    result?: OperationResult,
    initial?: RecoveryLoad,
    forcePublication = false,
    preservation?: number,
  ): Promise<void> {
    return this.run(
      this.factsLock.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            const boundary = this.preservationRevision;
            const check = () => {
              if (
                this.closing ||
                this.pendingPublication ||
                boundary !== this.preservationRevision ||
                (this.preserving && preservation !== boundary)
              )
                throw deferObservation;
            };
            try {
              check();
              await this.run(this.recoveryLock.withPermits(1)(Effect.void));
              check();
              const loaded =
                initial ?? (await this.command('loadRecovery', { clientId: this.clientId }));
              check();
              if (loaded.state.clientId !== this.clientId)
                throw Error('Recovery belongs to another editor client.');
              const facts = [
                ...new Map(
                  [...loaded.operations, ...(result ? [result] : [])].map((fact) => [
                    operationKey(fact.clientId, fact.id),
                    fact,
                  ]),
                ).values(),
              ];
              const before = (fact: OperationResult) =>
                fact.recoveryChanges.find((change) => change.clientId === this.clientId)
                  ?.previousRevision ?? Infinity;
              facts.sort((a, b) => before(a) - before(b));
              const reconciled = new Set<string>();
              if (this.preserving) {
                // A captured Save may publish its own known revision, never remap another captured draft.
                if (
                  facts.some((fact) =>
                    fact.recoveryChanges.some(
                      (change) =>
                        change.clientId === this.clientId && change.revision > this.revision,
                    ),
                  )
                )
                  throw deferObservation;
                if (
                  facts.length &&
                  !this.deferredFacts.some((request) => !request.result && !request.changes.length)
                )
                  this.deferredFacts.push({ changes: [], forcePublication: false });
              } else
                for (const fact of facts) {
                  if (await this.applyOperationFacts(fact, loaded.state, check))
                    reconciled.add(operationKey(fact.clientId, fact.id));
                  check();
                }
              // Keep each known Save until its exact receipt chain and recovery publication succeed.
              const savedRequests = [...this.saveResults.keys()];
              const transitions = [
                ...changes,
                ...facts.flatMap((fact) => fact.recoveryChanges),
                ...[...this.saveResults.values()].flatMap((result) => result.recoveryChanges),
              ]
                .filter((change) => change.clientId === this.clientId)
                .sort((a, b) => a.previousRevision - b.previousRevision);
              for (const transition of transitions) {
                if (transition.revision <= this.revision) continue;
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
              if (!facts.length && !changes.length && !savedRequests.length && !forcePublication)
                return;
              await this.publish(this.capture(savedRequests), { before: check, savedRequests });
              check();
              for (const fact of facts)
                if (
                  fact.outcome !== 'uncertain' &&
                  reconciled.has(operationKey(fact.clientId, fact.id))
                ) {
                  await this.command('acknowledgeOperation', {
                    clientId: this.clientId,
                    operationClientId: fact.clientId,
                    id: fact.id,
                  });
                  const known = this.operations.get(operationKey(fact.clientId, fact.id))!;
                  known.acknowledged = true;
                  known.copies = undefined;
                  known.closedCopyTargets = undefined;
                  check();
                }
              this.emit();
            } catch (error) {
              if (error !== deferObservation) throw error;
              if (!this.closing) {
                const observation =
                  !changes.length &&
                  !result &&
                  this.deferredFacts.find((request) => !request.result && !request.changes.length);
                if (observation) observation.forcePublication ||= forcePublication;
                else
                  this.deferredFacts.push({
                    changes: structuredClone(changes),
                    result: result && structuredClone(result),
                    forcePublication,
                  });
              }
              this.resumeFacts();
            }
          },
          catch: ApplicationError.fromUnknown,
        }),
      ),
    );
  }
  private moveReferences(checkout: CheckoutTarget, source: string, destination: string) {
    const move = (path: string) =>
      affected(path, source) ? destination + path.slice(source.length) : path;
    const incoming = [...this.buffers.values()].filter(
      (buffer) =>
        sameCheckout(buffer.target.checkout, checkout) && affected(buffer.target.path, source),
    );
    if (
      incoming.some((buffer) =>
        [...this.buffers.values()].some(
          (other) =>
            sameCheckout(other.target.checkout, checkout) &&
            !incoming.includes(other) &&
            other.target.path.normalize('NFC').toLowerCase() ===
              move(buffer.target.path).normalize('NFC').toLowerCase(),
        ),
      )
    ) {
      this.report(
        'Move destination has another open buffer. Both drafts and operation evidence are retained. Close one through Save/Discard/Cancel, then resolve operation status.',
      );
      return false;
    }
    this.referenceRevision++;
    this.checkout(checkout, false);
    // oxlint-disable-next-line no-useless-spread -- Renaming reinserts buffers; visit each original buffer once.
    for (const [key, buffer] of [...this.buffers])
      if (sameCheckout(buffer.target.checkout, checkout) && affected(buffer.target.path, source)) {
        this.buffers.delete(key);
        this.comparisonAttempts.delete(key);
        buffer.target = { checkout, path: move(buffer.target.path) };
        this.buffers.set(fileKey(buffer.target), buffer);
        if (this.comparisons[key]) {
          this.comparisons[fileKey(buffer.target)] = this.comparisons[key];
          delete this.comparisons[key];
        }
      }
    moveRecoveryReferences(this.recovery, checkout, source, destination);
    for (const action of this.history)
      if (sameCheckout(action.checkout, checkout)) {
        action.active = move(action.active);
        action.files = action.files.map((file) => ({ ...file, path: move(file.path) }));
      }
    return true;
  }
  /** Immediately stop admissions; cleanup is owned by the caller outside this model scope. */
  private beginDisposal() {
    if (this.closing) return;
    this.closing = true;
    this.activation++;
    this.closePrompt = null;
    if (this.closeAnswer) Deferred.doneUnsafe(this.closeAnswer, Effect.succeed('cancel'));
    this.closeAnswer = undefined;
    this.deferredFacts = [];
    for (const workflow of this.workflows) workflow.stop();
    this.emit(true);
    this.listeners.clear();
  }
  release(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.beginDisposal();
      if (this.releaseStarted)
        return Effect.flatMap(Deferred.await(this.releaseDone), (exit) => exit);
      this.releaseStarted = true;
      return Scope.close(this.scope, Exit.void).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            this.cleanupFailures.length
              ? Effect.die(
                  new ApplicationError({
                    code: this.cleanupFailures[0].code,
                    message: this.cleanupFailures.map((error) => error.message).join('; '),
                  }),
                )
              : Effect.void,
          ),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            this.disposed = true;
            this.emit(true);
          }),
        ),
        Effect.exit,
        Effect.flatMap((exit) =>
          Deferred.succeed(this.releaseDone, exit).pipe(Effect.flatMap(() => exit)),
        ),
        Effect.uninterruptible,
      );
    });
  }
  dispose(): Promise<void> {
    this.beginDisposal();
    return (this.cleanup ??= this.runEffect(this.release()));
  }
}

export type EditorDependencies = { client: EditorClient; clientId?: string };
export type EditorModel = EditorModelState;
export type EditorController = Omit<EditorModelState, 'bind' | 'release'>;

/** Acquire once under the composition root's scope; no runtime or backend is installed. */
export const makeEditorModel = (
  dependencies: EditorDependencies,
): Effect.Effect<EditorModel, ApplicationError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const model = yield* Effect.try({
      try: () => new EditorModelState(scope, dependencies),
      catch: ApplicationError.fromUnknown,
    });
    yield* Effect.addFinalizer(() => model.release());
    return model;
  });

export function makeEditorController<R, E extends ApplicationError>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
  model: EditorModel,
): EditorController {
  return model.bind(runtime);
}
