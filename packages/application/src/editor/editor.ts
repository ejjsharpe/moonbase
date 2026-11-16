import { normalizeApplicationError } from '@moonbase/effect';
import { getParentPath, isPathAtOrInside } from '@moonbase/contracts/paths';
import { EditorDiscovery } from './discovery.ts';
import { EditorPreservation, type ConfirmedClose } from './preservation.ts';
import {
  RecoveryOutbox,
  type DebounceRunner,
  type RecoveryEditRequest,
} from './recovery-outbox.ts';
import {
  emptyCheckoutView,
  emptyEditorRecovery,
  readRecoveryState,
  toRecoveryLayout,
  type CheckoutView,
  type EditorRecovery,
  type EditorTab,
} from './recovery-layout.ts';
import {
  EditorLookup,
  EditorTextSearch,
  EditorMutation,
  getMutationDestinations,
  type MutationAction,
} from './workflows.ts';
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  Scope,
  Semaphore,
  type ManagedRuntime,
} from 'effect';
import { watchRetry } from '../watch-retry.ts';
import { runApplicationEffect } from '../runtime/effect-client.ts';
import type { RecoveryOutline, RecoveryState } from '@moonbase/contracts/recovery';
import {
  ApplicationError,
  maximumFileBytes,
  type CheckoutTarget,
  type Comparison,
  type DirectoryEntry,
  type DirectoryListing,
  type EditorClient,
  type EditorPosition,
  type FileDocument,
  type FileTarget,
  type FileView,
  type GitStatus,
  type ObservationClose,
  type OperationResult,
  type RecoveryLoad,
  type WorkspaceCommand,
  type CommandInput,
  type CommandOutput,
  type WorkspaceOperation,
} from '@moonbase/contracts/workspace';

import { readOwn, writeOwn } from './record.ts';

import {
  checkoutKey,
  fileKey,
  moveRecoveryReferences,
  closeRecoveryReferences,
} from './references.ts';
import { findFreePath } from './free-path.ts';
export { checkoutKey, fileKey } from './references.ts';
export type { CheckoutView, EditorRecovery } from './recovery-layout.ts';
// These diagnostics are authored by this module; injected failures use shared normalization.
const editorError = (message: string) => new ApplicationError({ code: 'Unavailable', message });
const sameCheckout = (a: CheckoutTarget, b: CheckoutTarget) => checkoutKey(a) === checkoutKey(b);
/** Whether `next` is the Git checkout that a plain-folder checkout became after `git init`. */
const isInitialized = (previous: CheckoutTarget, next: CheckoutTarget) =>
  previous.vcs === 'none' &&
  next.vcs === 'git' &&
  previous.hostId === next.hostId &&
  previous.checkoutId === next.checkoutId &&
  previous.root === next.root;
const operationKey = (clientId: string, id: string) => JSON.stringify([clientId, id]);
const definitiveNonAdmission = (error: unknown) =>
  ApplicationError.is(error) && error.code === 'InvalidInput';
/**
 * The paths an operation writes: each entry's path in a batch's destination folder (which may be
 * the root), or one destination path.
 */
function listOperationDestinations(operation: WorkspaceOperation) {
  if (operation.destination === undefined) return [];
  if (operation.sources.length > 1)
    return getMutationDestinations(operation.sources, operation.destination).destinations;
  return operation.destination ? [operation.destination] : [];
}
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
const view = emptyCheckoutView;
const isDirty = (buffer: EditorBuffer) => buffer.text !== buffer.disk.text;

type PendingSave = CommandInput<'saveFile'>;
export type EditorBuffer = {
  target: FileTarget;
  text: string;
  disk: FileDocument;
  conflict?: FileDocument;
  pendingSave?: PendingSave;
  saving: boolean;
  /** Its file isn't on disk (text kept apart from a replaced file): a Save creates it. */
  newFile?: boolean;
};
export type CloseChoice = 'save' | 'discard' | 'cancel';
export type ClosePrompt = { id: string; buffer: Readonly<EditorBuffer> };
export type EditorSnapshot = {
  ready: boolean;
  recoveryReady: boolean;
  disposed: boolean;
  closePrompt: ClosePrompt | null;
  preserving: boolean;
  /** The checkout whose `initializeRepository` is running; it refuses saves and file operations. */
  initializing: string | null;
  discoveryRevision: number;
  recovery: EditorRecovery;
  buffers: readonly EditorBuffer[];
  comparisons: Readonly<Record<string, Comparison>>;
  listings: Readonly<Record<string, DirectoryListing>>;
  git: Readonly<Record<string, GitStatus>>;
  /** The last recovery edit failed; edits made since are not kept until a flush succeeds. */
  recoveryFailed: boolean;
  errors: readonly string[];
  operations: readonly OperationResult[];
};
type SnapshotData =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly SnapshotData[]
  | { readonly [key: string]: SnapshotData };

// Snapshot DTOs need fresh containers, but immutable strings can retain their backing storage.
function copySnapshotData<A extends SnapshotData>(value: A): A;
function copySnapshotData(value: SnapshotData): SnapshotData {
  if (Array.isArray(value)) return value.map((item) => copySnapshotData(item));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copySnapshotData(item)]),
    );
  return value;
}

/** One editor instance; IO always enters the application's injected command client. */
class EditorModelState {
  readonly clientId: string;
  readonly instanceId = crypto.randomUUID();
  private client: EditorClient;
  private recovery: EditorRecovery;
  private ready = false;
  private loading = false;
  private closing = false;
  private admissionsOpen = true;
  private disposed = false;
  private workflows = new Set<{ stop(): void }>();
  private cleanup?: Promise<void>;
  private releaseStarted = false;
  private releaseDone = Deferred.makeUnsafe<Exit.Exit<void>>();
  private bound = false;
  private runEffect!: <A>(effect: Effect.Effect<A, ApplicationError>) => Promise<A>;
  private factsLock = Semaphore.makeUnsafe(1);
  /**
   * The one running `initializeRepository`. Until it rebinds, every recovery capture would name
   * the folder target that `git init` retires, so publications wait for it to finish.
   */
  private initialization?: { checkoutId: string; done: Promise<void> };
  private preservation: EditorPreservation;
  private buffers = new Map<string, EditorBuffer>();
  /** Every open tab's buffer in the recovery store, by file key. */
  private tabs = new Map<string, EditorTab>();
  /** Buffers this editor closed, which a late recovery outline may still list. */
  private closedBuffers = new Set<string>();
  private recoveryWatch?: ObservationClose;
  private comparisons: Record<string, Comparison> = {};
  private comparisonAttempts = new Map<string, { mode: FileView; failedWorkingVersion?: string }>();
  private listings: Record<string, DirectoryListing> = {};
  private listingReads = new Map<
    string,
    {
      scope: Scope.Scope;
      classificationScope: Scope.Closeable;
      revision: number;
      listed: boolean;
      classifying: boolean;
      /** Whether this read reports its failures; a quiet one leaves that to later callers. */
      report: boolean;
      promise: Promise<DirectoryListing>;
    }
  >();
  /** Per folder: a superseded Git classification left to finish, and the newest one shown. */
  private keptClassifications = new Map<string, Scope.Closeable>();
  private classifiedListings = new Map<string, number>();
  private listingSequence = 0;
  /** Per checkout, the running reveal's scope, closed when a newer reveal starts. */
  private reveals = new Map<string, Scope.Closeable>();
  private git: Record<string, GitStatus> = {};
  private errors: string[] = [];
  private operations = new Map<
    string,
    {
      operation?: WorkspaceOperation;
      result: OperationResult;
      applied: Set<string>;
      acknowledged?: boolean;
    }
  >();
  private listeners = new Set<() => void>();
  private outbox: RecoveryOutbox;
  private discovery: EditorDiscovery;
  private snapshot!: EditorSnapshot;
  private scope: Scope.Closeable;
  constructor(scope: Scope.Closeable, options: EditorDependencies, debounce: DebounceRunner) {
    this.scope = scope;
    this.client = options.client;
    this.clientId = options.clientId ?? crypto.randomUUID();
    if (!this.clientId.trim())
      throw editorError('An editor requires its own nonempty recovery client ID.');
    this.discovery = new EditorDiscovery(scope, {
      execute: (effect) => this.runEffect(effect),
      watch: (...args) => this.client.watch(...args),
      watchRetryMs: options.watchRetryMs ?? watchRetry.retryMs,
      listDirectory: (input, scope, report) => this.command('listDirectory', input, scope, report),
      readFile: (target, scope) => this.command('readFile', target, scope),
      readComparison: (input, scope) => this.command('readComparison', input, scope),
      gitStatus: (checkout, scope) => this.command('gitStatus', { checkout }, scope),
      isClosing: () => this.closing,
      notify: () => this.emit(),
      report: (error) => this.report(error),
    });
    this.outbox = new RecoveryOutbox(debounce, {
      clientId: this.clientId,
      execute: (effect) => this.run(effect),
      send: async (kind, input) => {
        await this.command(kind, input, this.scope, false);
      },
      layout: () => toRecoveryLayout(this.recovery, this.tabs),
      ready: async () => {
        // A layout now would name the folder target that `git init` retires.
        while (this.initialization) await this.initialization.done;
      },
      resync: (edit, error) => this.resync(edit, error),
      settleClose: async (bufferId) => {
        const loaded = await this.command(
          'loadRecovery',
          { clientId: this.clientId },
          this.scope,
          false,
        );
        return !loaded.state.buffers.some((buffer) => buffer.id === bufferId);
      },
      finishClose: (edit, reopen) => this.finishClose(edit.bufferId, reopen),
      shownTab: (bufferId) => {
        const tab = [...this.tabs.values()].find((shown) => shown.id === bufferId);
        return tab && structuredClone(tab.target);
      },
      notify: () => this.emit(),
      report: (error) => this.report(error),
    });
    this.preservation = new EditorPreservation({
      run: (effect) => this.run(effect),
      isClosing: () => this.closing,
      invalidateReads: () => this.discovery.invalidateActivation(),
      notify: () => this.emit(),
      report: (error) => this.report(error),
      afterRelease: async () => {
        await this.activateSelected();
        this.schedule();
      },
    });
    this.recovery = emptyEditorRecovery(this.clientId);
    this.emit();
  }
  /** Composition fences admissions without interrupting already-admitted work. */
  setAdmissionsOpen(open: boolean) {
    if (!this.closing) this.admissionsOpen = open;
  }
  private assertAdmission() {
    if (!this.admissionsOpen)
      throw new ApplicationError({ code: 'Unavailable', message: 'Application is closing.' });
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
    return this.discovery.invoke(
      Effect.flatMap(Effect.forkIn(effect, scope, { startImmediately: true }), Fiber.join),
      scope,
    );
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
    this.snapshot = copySnapshotData({
      ready: this.ready,
      recoveryReady:
        this.ready &&
        !this.loading &&
        !this.closing &&
        !this.preservation.active &&
        !this.initialization &&
        this.outbox.idle &&
        ![...this.buffers.values()].some((buffer) => buffer.saving || buffer.pendingSave) &&
        ![...this.operations.values()].some((value) => !value.acknowledged),
      disposed: this.disposed,
      closePrompt: this.preservation.prompt,
      preserving: this.preservation.active,
      initializing: this.initialization?.checkoutId ?? null,
      discoveryRevision: this.discovery.discoveryRevision,
      recovery: this.recovery,
      buffers: [...this.buffers.values()],
      comparisons: this.comparisons,
      listings: this.listings,
      git: this.git,
      recoveryFailed: this.outbox.failed,
      errors: this.errors,
      operations: [...this.operations.values()]
        .filter((value) => !value.acknowledged)
        .map((value) => value.result),
    });
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A view cannot interrupt recovery preservation or owned editor work. */
      }
    }
  }
  report = (error: unknown) => {
    if (this.closing || this.discovery.isObsoleteReadError(error)) return;
    // A string is a note of the editor's or its view's own; any other failure shows only an
    // `ApplicationError`'s message. Host text is never passed as a string, so it never shows.
    const message = typeof error === 'string' ? error : normalizeApplicationError(error).message;
    this.errors = [...this.errors.slice(-19), message];
    this.emit();
  };
  clearErrors() {
    this.errors = [];
    this.emit();
  }
  private assertReady() {
    if (this.closing || !this.ready)
      throw editorError(this.closing ? 'Editor disposed.' : 'Load editor recovery first.');
  }
  private checkout(target: CheckoutTarget, requireOpen = true) {
    this.assertReady();
    if (
      !this.recovery.checkouts.some((item) => sameCheckout(item, target)) ||
      (requireOpen && !this.recovery.openCheckoutIds.includes(target.checkoutId))
    )
      throw editorError('This exact checkout is not open in this editor.');
    return (
      readOwn(this.recovery.views, target.checkoutId) ??
      writeOwn(this.recovery.views, target.checkoutId, view())
    );
  }
  private async command<K extends WorkspaceCommand>(
    name: K,
    input: CommandInput<K>,
    scope: Scope.Scope = this.scope,
    report = true,
  ): Promise<CommandOutput<K>> {
    if (this.closing)
      throw new ApplicationError({ code: 'Unavailable', message: 'Editor disposed.' });
    try {
      return await this.run(
        Effect.tryPromise({
          try: (signal) => this.client.command(name, input, { signal }),
          catch: normalizeApplicationError,
        }),
        scope,
      );
    } catch (error) {
      if (report) this.report(error);
      throw error;
    }
  }
  async load() {
    this.assertAdmission();
    if (this.ready) return;
    this.loading = true;
    const loaded = await this.command('loadRecovery', { clientId: this.clientId });
    if (this.closing) return;
    if (loaded.state.clientId !== this.clientId)
      throw editorError('Recovery belongs to another editor client.');
    const { recovery, tabs } = readRecoveryState(loaded.state);
    this.recovery = recovery;
    this.tabs = tabs;
    // A since-removed Hide button saved choices it never applied; they are dropped, not honoured.
    for (const view of Object.values(this.recovery.views)) delete view.tree.hideIgnored;
    this.errors.push(...loaded.errors);
    for (const buffer of loaded.state.buffers)
      if (buffer.draft) this.showDraft({ id: buffer.id, target: buffer.target }, buffer.draft);
    for (const result of loaded.operations)
      this.operations.set(operationKey(result.clientId, result.id), { result, applied: new Set() });
    this.ready = true;
    await this.watchRecovery();
    if (loaded.operations.length)
      try {
        await this.reconcile(undefined, loaded);
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
        await this.openFile(
          { checkout, path: selected.active },
          { view: readOwn(selected.fileViews, selected.active) ?? 'file' },
        );
      await this.refreshCheckout(checkout);
    }
    this.recovery.selectedCheckoutId = selectedCheckoutId;
    this.loading = false;
    this.changed();
  }
  /**
   * Follows the recovery store's outline of this editor's recovery, so a move another window or
   * client makes re-paths its tabs as it commits. A failed watch is watched again at the next
   * reconcile.
   */
  private async watchRecovery() {
    if (this.recoveryWatch || this.closing) return;
    const close = this.client.watchRecovery(
      { clientId: this.clientId },
      (outline) => {
        if (this.closing) return;
        try {
          this.follow(outline, false);
        } catch (error) {
          this.report(error);
        }
      },
      (error) => {
        if (this.recoveryWatch === close) this.recoveryWatch = undefined;
        this.report(error);
      },
    );
    this.recoveryWatch = close;
    await this.runEffect(
      Scope.addFinalizer(this.scope, Effect.tryPromise(() => close()).pipe(Effect.ignore)),
    );
  }
  private observe(checkout: CheckoutTarget) {
    return this.discovery.observe(
      checkout,
      () => this.recovery.openCheckoutIds.includes(checkout.checkoutId),
      (isCurrent) => {
        void this.reconcile().catch(this.report);
        void this.refreshCheckout(checkout).catch((error) => {
          if (isCurrent()) this.report(error);
        });
      },
    );
  }
  async openCheckout(root: string) {
    this.assertAdmission();
    this.assertReady();
    const target = await this.command('openCheckout', { root });
    this.assertNotInitializing(target);
    return this.addCheckout(target);
  }
  async listWorktrees(checkout: CheckoutTarget) {
    this.assertAdmission();
    this.checkout(checkout);
    return this.command('listWorktrees', { checkout });
  }
  /** Creates a branch from `base` in a new linked worktree, then opens and selects it. */
  async createWorktree(input: CommandInput<'createWorktree'>) {
    this.assertAdmission();
    this.assertReady();
    this.checkout(input.checkout);
    return this.addCheckout(await this.command('createWorktree', input));
  }
  /**
   * Runs `git init` in an open plain-folder checkout, then rebinds it, with its tabs and drafts,
   * to the Git checkout that results and selects it. Until then the checkout refuses saves and
   * file operations, and recovery publication waits; edits continue and move with the rebind.
   */
  async initializeRepository(checkout: CheckoutTarget) {
    this.assertAdmission();
    this.assertReady();
    this.checkout(checkout);
    if (checkout.vcs !== 'none')
      throw new ApplicationError({
        code: 'InvalidInput',
        message: 'This project is already a Git repository.',
      });
    if (this.initialization)
      throw new ApplicationError({
        code: 'Conflict',
        message: 'Git is already being initialized. Wait for it to finish.',
      });
    this.assertRebindable(checkout);
    // The folder's approval ends with `git init`: send the edits while it holds.
    await this.outbox.flush();
    let finish!: () => void;
    this.initialization = {
      checkoutId: checkout.checkoutId,
      done: new Promise<void>((resolve) => (finish = resolve)),
    };
    this.emit();
    let target: CheckoutTarget | undefined, failure: ApplicationError | undefined;
    try {
      // End the folder's reads.
      await this.discovery.releaseObservation(checkout);
      let initialized: CheckoutTarget;
      try {
        initialized = await this.command('initializeRepository', { checkout }, this.scope, false);
        if (!isInitialized(checkout, initialized))
          throw editorError('Git initialized a different checkout. Reopen the folder.');
      } catch (error) {
        // A failed or lost reply may follow a `git init` that ran: the folder then opens as its
        // repository, and moves there as if the reply had arrived.
        const reopened = this.closing ? undefined : await this.findInitialized(checkout);
        if (!reopened) {
          this.report(error);
          if (!this.closing && this.recovery.openCheckoutIds.includes(checkout.checkoutId))
            await this.observe(checkout).catch(this.report);
          throw error;
        }
        initialized = reopened;
      }
      try {
        target = await this.addCheckout(initialized);
      } catch (error) {
        if (this.closing) throw error;
        await this.settleInitialization(checkout, initialized);
        failure = editorError(
          'Git was initialized, but the project did not finish moving to it: ' +
            normalizeApplicationError(error).message +
            ' Your tabs and drafts are kept on the repository.',
        );
      }
    } finally {
      this.initialization = undefined;
      finish();
      if (!this.closing) this.emit();
    }
    // Edits made meanwhile are sent now, under the Git target.
    if (!this.closing && !this.preservation.active) {
      const flushed = this.flushRecovery();
      await (failure ? flushed.catch(this.report) : flushed);
    }
    if (failure || !target) throw failure ?? editorError('Editor disposed.');
    return target;
  }
  /**
   * After `git init`, the folder target is no longer approved: whatever stopped the rebind, move
   * the checkout's work to the repository and watch it there rather than strand it.
   */
  private async settleInitialization(previous: CheckoutTarget, next: CheckoutTarget) {
    if (this.recovery.checkouts.some((item) => sameCheckout(item, previous)))
      this.moveCheckout(previous, next);
    if (this.recovery.openCheckoutIds.includes(next.checkoutId)) {
      // A watch that failed to start repeats that failure, already reported, when released.
      await this.discovery.releaseObservation(next).catch(() => undefined);
      await this.observe(next).catch(this.report);
    }
  }
  /** The repository a plain folder became, when `git init` ran but its reply was lost. */
  private async findInitialized(checkout: CheckoutTarget) {
    try {
      const reopened = await this.command(
        'openCheckout',
        { root: checkout.root },
        this.scope,
        true,
      );
      return isInitialized(checkout, reopened) ? reopened : undefined;
    } catch {
      return undefined;
    }
  }
  /** Refuses work on a checkout while Git is initializing in it. */
  private assertNotInitializing(checkout: CheckoutTarget) {
    if (this.initialization?.checkoutId === checkout.checkoutId)
      throw editorError('Git is initializing in this project. Try again when it finishes.');
  }
  private assertRebindable(checkout: CheckoutTarget) {
    if (
      this.preservation.active ||
      [...this.buffers.values()].some(
        (buffer) =>
          sameCheckout(buffer.target.checkout, checkout) && (buffer.saving || buffer.pendingSave),
      ) ||
      [...this.operations.values()].some(
        (value) => !value.acknowledged && sameCheckout(value.result.checkout, checkout),
      )
    )
      throw editorError('Wait for saves and file operations in this project to finish.');
  }
  /** Moves a checkout's views, buffers, drafts and recents to the target it became. */
  private async rebindCheckout(previous: CheckoutTarget, next: CheckoutTarget) {
    this.assertRebindable(previous);
    const open = this.recovery.openCheckoutIds.includes(previous.checkoutId);
    await this.discovery.releaseObservation(previous);
    this.moveCheckout(previous, next);
    if (open) await this.observe(next);
  }
  /**
   * Moves a checkout's views, tabs, buffers and recents to the target it became; the next layout
   * relists it in the store, whose buffers then follow under the same checkout ID.
   */
  private moveCheckout(previous: CheckoutTarget, next: CheckoutTarget) {
    const previousKey = checkoutKey(previous);
    const ofPrevious = (key: string) => JSON.parse(key)[0] === previousKey;
    const rebind = <T extends { checkout: CheckoutTarget }>(item: T): T =>
      sameCheckout(item.checkout, previous) ? { ...item, checkout: next } : item;
    this.recovery.checkouts = this.recovery.checkouts.map((item) =>
      sameCheckout(item, previous) ? next : item,
    );
    this.recovery.recentFiles = this.recovery.recentFiles.map(rebind);
    // oxlint-disable-next-line no-useless-spread -- Rebinding reinserts tabs; visit each once.
    for (const [key, tab] of [...this.tabs])
      if (sameCheckout(tab.target.checkout, previous)) {
        this.tabs.delete(key);
        tab.target = rebind(tab.target);
        this.tabs.set(fileKey(tab.target), tab);
      }
    // oxlint-disable-next-line no-useless-spread -- Rebinding reinserts buffers; visit each once.
    for (const [key, buffer] of [...this.buffers])
      if (sameCheckout(buffer.target.checkout, previous)) {
        this.buffers.delete(key);
        buffer.target = rebind(buffer.target);
        this.buffers.set(fileKey(buffer.target), buffer);
      }
    // Listings, comparisons and Git status are read again for the new target.
    for (const key of Object.keys(this.comparisons))
      if (ofPrevious(key)) delete this.comparisons[key];
    for (const key of this.comparisonAttempts.keys())
      if (ofPrevious(key)) this.comparisonAttempts.delete(key);
    for (const key of Object.keys(this.listings)) if (ofPrevious(key)) delete this.listings[key];
    delete this.git[previousKey];
    this.preservation.rebindClosedReferences(previous, next);
    // The store relists the checkout, and its buffers follow, with the next layout.
    this.changed();
  }
  private async addCheckout(target: CheckoutTarget) {
    if (this.closing) return target;
    const collision = this.recovery.checkouts.find(
      (item) => item.checkoutId === target.checkoutId && !sameCheckout(item, target),
    );
    // A plain folder that became a repository keeps its tabs and drafts as the Git checkout.
    if (collision && isInitialized(collision, target)) await this.rebindCheckout(collision, target);
    else if (collision)
      throw editorError('Checkout identity changed; retained work has not been rebound.');
    if (!this.recovery.checkouts.some((item) => sameCheckout(item, target))) {
      this.recovery.checkouts.push(target);
      writeOwn(this.recovery.views, target.checkoutId, view());
    }
    const reopening = !this.recovery.openCheckoutIds.includes(target.checkoutId);
    if (reopening) {
      this.recovery.openCheckoutIds.push(target.checkoutId);
      await this.observe(target);
    } else await this.rewatchLost(target);
    await this.selectOpenCheckout(target);
    await this.refreshCheckout(target);
    return target;
  }
  selectCheckout(target: CheckoutTarget) {
    this.assertAdmission();
    return this.selectOpenCheckout(target);
  }
  private selectOpenCheckout(target: CheckoutTarget) {
    this.checkout(target);
    this.discovery.selectReadScope(target, true);
    this.discovery.invalidateActivation();
    this.recovery.selectedCheckoutId = target.checkoutId;
    this.changed();
    return this.activateSelected();
  }
  private async activateSelected() {
    if (this.closing || this.preservation.active) return false;
    const checkout = this.recovery.checkouts.find(
      (target) => target.checkoutId === this.recovery.selectedCheckoutId,
    );
    const path = checkout && readOwn(this.recovery.views, checkout.checkoutId)?.active;
    if (!checkout) {
      this.discovery.clearSelection();
      return true;
    }
    this.discovery.selectReadScope(checkout);
    if (!path) return true;
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
    return this.openFile(
      { checkout, path },
      {
        current: () =>
          this.recovery.selectedCheckoutId === checkout.checkoutId &&
          readOwn(this.recovery.views, checkout.checkoutId)?.active === path,
      },
    );
  }
  /** The layout changed: send it once nothing has changed for a moment. */
  private changed() {
    this.outbox.updateLayout();
    this.schedule();
  }
  private schedule() {
    if (!this.ready || this.loading || this.closing) return;
    this.outbox.schedule();
  }
  async flush() {
    this.assertAdmission();
    return this.flushRecovery();
  }
  private async flushRecovery() {
    this.assertReady();
    // An edit now would name the folder target that `git init` retires.
    while (this.initialization) await this.initialization.done;
    this.assertReady();
    if (this.preservation.active)
      throw editorError('Finish the captured preservation action before flushing.');
    await this.outbox.flush();
  }
  /** Opens a tab in the recovery store for a file the editor shows a tab for. */
  private openTab(target: FileTarget) {
    const key = fileKey(target);
    if (this.tabs.has(key)) return;
    const tab = { id: crypto.randomUUID(), target: structuredClone(target) };
    this.tabs.set(key, tab);
    this.outbox.openTab(tab.id, tab.target);
  }
  /** Closes a clean tab in the recovery store; the editor no longer shows it. */
  private closeTab(target: FileTarget) {
    const key = fileKey(target),
      tab = this.tabs.get(key);
    if (!tab) return;
    this.tabs.delete(key);
    this.closedBuffers.add(tab.id);
    this.outbox.closeTab(tab.id);
  }
  /** Sends a buffer's text to the recovery store. */
  private sendDraft(buffer: EditorBuffer) {
    const tab = this.tabs.get(fileKey(buffer.target));
    if (tab) this.outbox.updateDraft(tab.id, buffer.text, buffer.disk);
  }
  /** Shows a buffer the store holds with a draft as an open tab with that text. */
  private showDraft(tab: EditorTab, draft: { text: string; disk: FileDocument }) {
    const key = fileKey(tab.target);
    this.tabs.set(key, structuredClone(tab));
    this.buffers.set(key, {
      target: structuredClone(tab.target),
      text: draft.text,
      disk: structuredClone(draft.disk),
      saving: false,
    });
    const checkoutId = tab.target.checkout.checkoutId;
    const selected =
      readOwn(this.recovery.views, checkoutId) ?? writeOwn(this.recovery.views, checkoutId, view());
    if (!selected.openFiles.includes(tab.target.path)) selected.openFiles.push(tab.target.path);
    if (selected.preview === tab.target.path) selected.preview = null;
  }
  buffer(target: FileTarget): Readonly<EditorBuffer> | undefined {
    return this.snapshot.buffers.find((buffer) => fileKey(buffer.target) === fileKey(target));
  }
  edit(target: FileTarget, text: string) {
    this.assertAdmission();
    this.checkout(target.checkout);
    validPath(target.path);
    if (this.preservation.active)
      throw editorError('Finish the captured preservation action first.');
    if (new TextEncoder().encode(text).length > maximumFileBytes)
      throw editorError('Editable text exceeds 2 MiB.');
    const buffer = this.buffers.get(fileKey(target));
    if (!buffer) throw editorError('Open this file before editing it.');
    buffer.text = text;
    this.sendDraft(buffer);
    if (text !== buffer.disk.text) this.keepOpen(target);
    this.changed();
  }
  keepOpen(target: FileTarget) {
    this.assertAdmission();
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
    this.assertAdmission();
    // The folder's reads end during `git init`: open the file once it is the repository instead.
    const initializing = this.initialization;
    if (initializing?.checkoutId === target.checkout.checkoutId) {
      await initializing.done;
      const checkout = this.recovery.checkouts.find(
        (item) => item.checkoutId === target.checkout.checkoutId,
      );
      if (!checkout || this.closing) return false;
      return this.openFile({ ...target, checkout }, options);
    }
    return this.openFile(target, options);
  }
  private async openFile(
    target: FileTarget,
    options: { view?: FileView; intent?: 'preview' | 'keep'; current?: () => boolean } = {},
  ) {
    const selected = this.checkout(target.checkout);
    validPath(target.path);
    if (this.preservation.active) return false;
    const generation = this.discovery.invalidateActivation();
    const selection = this.discovery.selectReadScope(target.checkout, true);
    const current = () =>
      !this.closing &&
      !this.preservation.active &&
      generation === this.discovery.activationGeneration &&
      (options.current?.() ?? true) &&
      this.recovery.openCheckoutIds.includes(target.checkout.checkoutId) &&
      this.recovery.checkouts.some((item) => sameCheckout(item, target.checkout));
    const key = fileKey(target),
      mode = options.view ?? readOwn(selected.fileViews, target.path) ?? 'file';
    try {
      let disk: FileDocument | null, comparison: Comparison | undefined;
      if (mode === 'file' || mode === 'conflict') {
        try {
          disk = await this.discovery.readFile(target, selection);
        } catch (error) {
          if (!current() || !this.buffers.has(key)) throw error;
          this.report(
            editorError('File unavailable on disk. Retained buffer and edits remain accessible.'),
          );
          // A missing file is created by its Save, which never replaces one that exists after
          // all. One that is there but unreadable now (permissions, a passing failure) saves over.
          const missing = await this.isMissing(target, selection);
          const buffer = this.buffers.get(key);
          if (missing && buffer && current()) buffer.newFile = true;
          disk = null;
        }
      } else {
        try {
          comparison = await this.discovery.readComparison({ target, area: mode }, selection);
          disk = comparison.working;
        } catch (error) {
          if (!current() || !this.buffers.has(key)) throw error;
          this.report(
            editorError('Comparison unavailable. Retained buffer and edits remain accessible.'),
          );
          disk = null;
          comparison = this.comparisons[key];
        }
      }
      if (!current()) return false;
      if (mode === 'file') this.comparisonAttempts.delete(key);
      else this.comparisonAttempts.set(key, { mode });
      let buffer = this.buffers.get(key);
      if (buffer && disk && mode === 'file') buffer.newFile = undefined;
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
      // The host's text says why; it reaches the UI only as fixed text.
      if (comparison?.error) this.report(normalizeApplicationError(comparison.error));
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
            this.closeTab({ checkout: target.checkout, path: previous });
          }
        }
        selected.openFiles.splice(selected.openFiles.indexOf(selected.active) + 1, 0, target.path);
        this.openTab(target);
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
  /** Whether the file's folder lists without it: a read that failed found nothing there. */
  private async isMissing(target: FileTarget, scope: Scope.Scope) {
    try {
      const listing = await this.discovery.listDirectory(
        {
          checkout: target.checkout,
          path: getParentPath(target.path),
          includeIgnoredStatus: false,
        },
        scope,
        false,
      );
      return !listing.entries.some((entry) => entry.path === target.path);
    } catch {
      return false;
    }
  }
  async save(target: FileTarget, overwrite = false): Promise<boolean> {
    this.assertAdmission();
    return this.saveFile(target, overwrite);
  }
  private async saveFile(target: FileTarget, overwrite = false): Promise<boolean> {
    this.checkout(target.checkout);
    if (this.initialization?.checkoutId === target.checkout.checkoutId) {
      this.report(editorError('Git is initializing in this project. Save again when it finishes.'));
      return false;
    }
    if (this.uncertainAffects(target)) {
      this.report(editorError('Resolve the pending file operation before saving this file.'));
      return false;
    }
    const buffer = this.buffers.get(fileKey(target));
    if (!buffer || buffer.saving) return false;
    if (buffer.newFile) return this.createFile(buffer);
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
      const result = await this.command('saveFile', request).catch((error) => {
        if (!this.closing && definitiveNonAdmission(error)) buffer.pendingSave = undefined;
        throw error;
      });
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
        // The host's own note on it is not shown: no host text reaches the UI.
        this.report(
          'Saved on disk; recovery is uncertain. Edits retained. Retry the same Save before closing.',
        );
        return false;
      }
      // The store took the save's outcome in before it answered: its draft now stands over the
      // saved text, and the buffer's text clears it once it matches.
      buffer.disk = result.disk;
      buffer.conflict = undefined;
      buffer.pendingSave = undefined;
      this.sendDraft(buffer);
      try {
        await this.outbox.flush();
      } catch (error) {
        this.report(error);
      }
      return buffer.text === result.disk.text;
    } finally {
      if (!this.closing) {
        buffer.saving = false;
        this.emit();
      }
    }
  }
  /**
   * Saves a buffer whose file isn't on disk by creating the file with its text. Creation never
   * replaces a file: one that exists by now refuses it, and the text stays a draft.
   */
  private async createFile(buffer: EditorBuffer) {
    buffer.saving = true;
    this.emit();
    try {
      const { target } = buffer;
      const result = await this.mutateFiles(
        {
          checkout: target.checkout,
          kind: 'create-file',
          sources: [],
          destination: target.path,
          text: buffer.text,
        },
        buffer,
      );
      if (result.outcome !== 'completed') return false;
      const disk = await this.command('readFile', target);
      buffer.newFile = undefined;
      buffer.disk = disk;
      buffer.conflict = undefined;
      // The file holds the text now. The store's draft still stands over the file it was kept
      // from, so it is dropped as a Discard would, keeping the tab; newer typing is sent after.
      const tab = this.tabs.get(fileKey(target));
      if (tab) this.outbox.discardDraft(tab.id, tab.target);
      this.sendDraft(buffer);
      this.outbox.updateLayout();
      await this.outbox.flush();
      return buffer.text === disk.text;
    } catch (error) {
      this.report(error);
      return false;
    } finally {
      if (!this.closing) {
        buffer.saving = false;
        this.emit();
      }
    }
  }
  async reload(target: FileTarget) {
    this.assertAdmission();
    const captured = structuredClone(target),
      key = fileKey(captured);
    this.checkout(captured.checkout);
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.pendingSave || this.preservation.active || this.initialization)
      return false;
    const sameBuffer = () => this.buffers.get(key) === buffer && fileKey(buffer.target) === key;
    return this.preservation.reload(captured, {
      readFile: (target) => this.command('readFile', target),
      isCurrent: sameBuffer,
      reloadFile: async (disk) => {
        const tab = this.tabs.get(key);
        if (tab) {
          this.outbox.discardDraft(tab.id, tab.target);
          this.outbox.updateLayout();
          await this.outbox.flush();
        }
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
          this.changed();
        } else
          this.report(
            'Reload committed for its original target; a changed live buffer was retained.',
          );
      },
    });
  }
  cancelConflict(target: FileTarget) {
    if (!this.admissionsOpen) return;
    const buffer = this.buffers.get(fileKey(target));
    if (buffer) buffer.conflict = undefined;
    const selected = this.checkout(target.checkout);
    if (readOwn(selected.fileViews, target.path) === 'conflict')
      writeOwn<FileView>(selected.fileViews, target.path, 'file');
    this.changed();
  }
  position(target: FileTarget, mode: FileView | `${FileView}:original`, position: EditorPosition) {
    if (!this.admissionsOpen) return;
    if (this.closing || this.preservation.active) return;
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
    this.assertAdmission();
    const selected = this.checkout(checkout);
    if (this.preservation.active || !selected.openFiles.includes(from)) return;
    selected.openFiles.splice(selected.openFiles.indexOf(from), 1);
    selected.openFiles.splice(Math.max(0, Math.min(to, selected.openFiles.length)), 0, from);
    this.keepOpen({ checkout, path: from });
    this.changed();
  }
  navigate(checkout: CheckoutTarget, direction: 1 | -1) {
    this.assertAdmission();
    const selected = this.checkout(checkout),
      paths = selected.openFiles;
    if (!paths.length) return Promise.resolve(false);
    const next = (paths.indexOf(selected.active) + direction + paths.length) % paths.length;
    return this.openFile({ checkout, path: paths[next] });
  }
  answerClose(promptId: string, choice: CloseChoice) {
    if (!this.admissionsOpen) return;
    this.preservation.answer(promptId, choice);
  }
  async close(targets: FileTarget[]) {
    this.assertAdmission();
    return this.preserve(targets, 'files');
  }
  async closeCheckout(checkout: CheckoutTarget) {
    this.assertAdmission();
    const selected = this.checkout(checkout);
    return this.preserve(
      selected.openFiles.map((path) => ({ checkout, path })),
      'checkout',
      checkout,
    );
  }
  async prepareQuit() {
    this.assertAdmission();
    return this.preserve(
      [...this.buffers.values()].map((buffer) => buffer.target),
      'quit',
    );
  }
  /** Confirm clean post-close view metadata only after the application fences admissions. */
  async finishQuitPreparation(): Promise<boolean> {
    if (
      this.admissionsOpen ||
      !this.ready ||
      this.loading ||
      this.closing ||
      this.preservation.active ||
      this.initialization ||
      [...this.buffers.values()].some(
        (buffer) => buffer.text !== buffer.disk.text || buffer.saving || buffer.pendingSave,
      ) ||
      [...this.operations.values()].some((operation) => !operation.acknowledged)
    )
      return false;
    if (this.snapshot.recoveryReady) return true;
    try {
      await this.flushRecovery();
    } catch (error) {
      this.report(error);
      return false;
    }
    return this.snapshot.recoveryReady;
  }
  private async preserve(
    targets: FileTarget[],
    kind: 'files' | 'checkout' | 'quit',
    checkout?: CheckoutTarget,
  ) {
    this.assertReady();
    if (this.initialization) {
      this.report(editorError('Git is initializing. Close again when it finishes.'));
      return false;
    }
    if (
      this.preservation.active ||
      [...this.buffers.values()].some((buffer) => buffer.saving || buffer.pendingSave)
    )
      return false;
    const captured = [
      ...new Map(targets.map((target) => [fileKey(target), structuredClone(target)])).values(),
    ];
    if (captured.some((target) => this.uncertainAffects(target))) {
      this.report(editorError('Resolve pending file operations before closing their files.'));
      return false;
    }
    return this.preservation.close(captured, kind, checkout && structuredClone(checkout), {
      captureBuffer: (target) => {
        const buffer = this.buffers.get(fileKey(target));
        return buffer && structuredClone(buffer);
      },
      saveFile: (target) => this.saveFile(target),
      closeFiles: (result) => this.closeFiles(result),
    });
  }
  /**
   * Closes files whose drafts were saved or discarded: once every edit made so far has committed,
   * the store closes their tabs (discarding the drafts chosen), and only then does the editor. A
   * Quit keeps its tabs, dropping only discarded drafts.
   */
  private async closeFiles({ targets, discarded, kind, checkout }: ConfirmedClose) {
    await this.outbox.flush();
    for (const target of targets) {
      const key = fileKey(target),
        tab = this.tabs.get(key);
      if (!tab) continue;
      if (kind !== 'quit') this.outbox.closeTab(tab.id, discarded.has(key));
      else if (discarded.has(key)) this.outbox.discardDraft(tab.id, tab.target);
    }
    await this.outbox.flush();
    const closed = closeRecoveryReferences(this.recovery, targets, kind, checkout, true);
    if (kind === 'quit')
      for (const key of discarded) {
        const buffer = this.buffers.get(key);
        if (!buffer) continue;
        buffer.text = buffer.disk.text;
        buffer.conflict = undefined;
      }
    else {
      for (const key of targets.map(fileKey)) {
        const tab = this.tabs.get(key);
        if (tab) this.closedBuffers.add(tab.id);
        this.tabs.delete(key);
        this.buffers.delete(key);
        delete this.comparisons[key];
        this.comparisonAttempts.delete(key);
      }
      if (kind === 'checkout' && checkout) {
        this.endReveal(checkoutKey(checkout));
        try {
          await this.discovery.releaseObservation(checkout);
        } catch (error) {
          this.report(error);
        }
      }
    }
    this.outbox.updateLayout();
    await this.outbox.flush();
    return closed;
  }
  async reopen(checkout: CheckoutTarget) {
    this.assertAdmission();
    const selected = this.checkout(checkout);
    if (this.preservation.active) return false;
    const closed = this.preservation.findClosedAction(checkout);
    if (!closed) return false;
    const { action, index } = closed;
    for (const file of action.files)
      if (!selected.openFiles.includes(file.path)) {
        selected.openFiles.splice(Math.min(file.index, selected.openFiles.length), 0, file.path);
        writeOwn(selected.fileViews, file.path, file.view);
        if (file.positions)
          writeOwn(selected.positions, file.path, structuredClone(file.positions));
        this.openTab({ checkout, path: file.path });
      }
    selected.active = action.active;
    selected.preview = null;
    this.outbox.updateLayout();
    const success = await this.openFile({ checkout, path: action.active });
    await this.flushRecovery();
    this.preservation.forgetClosedAction(index);
    this.emit();
    return success;
  }
  tree(checkout: CheckoutTarget, patch: Partial<CheckoutView['tree']>) {
    this.assertAdmission();
    return this.updateTree(checkout, patch);
  }
  private updateTree(checkout: CheckoutTarget, patch: Partial<CheckoutView['tree']>) {
    const selected = this.checkout(checkout);
    selected.tree = { ...selected.tree, ...patch };
    this.changed();
  }
  resizeSidebar(width: number) {
    if (!this.admissionsOpen) return;
    if (this.closing) return;
    this.recovery.sidebarWidth = Math.max(190, Math.min(380, Math.round(width)));
    this.changed();
  }
  /** Sets whether this editor's files trees reveal the file made active, saved with its recovery. */
  setFollowActiveFile(follow: boolean) {
    if (!this.admissionsOpen) return;
    if (this.closing) return;
    this.recovery.followActiveFile = follow;
    this.changed();
  }
  list(checkout: CheckoutTarget, path = '') {
    this.assertAdmission();
    return this.listCheckout(checkout, path);
  }
  private listCheckout(checkout: CheckoutTarget, path: string, report = true) {
    return this.listIn(checkout, path, this.discovery.getCheckoutScope(checkout), report);
  }
  private async listIn(checkout: CheckoutTarget, path: string, scope: Scope.Scope, report = true) {
    this.checkout(checkout);
    validPath(path, true);
    const key = JSON.stringify([checkoutKey(checkout), path]),
      revision = this.discovery.discoveryRevision,
      pending = this.listingReads.get(key);
    if (pending?.scope === scope && !pending.listed && pending.revision === revision) {
      // A caller that reports joining a quiet read reports its failure, once.
      if (report && !pending.report) {
        pending.report = true;
        void pending.promise.catch(this.report);
      }
      return pending.promise;
    }
    // A newer read cancels the Git classification it replaces, except for one kept running per
    // folder: refreshes that come faster than Git answers would otherwise keep every entry on its
    // last classification, so a file un-ignored by a .gitignore edit would stay dimmed.
    if (pending?.scope === scope && pending.classifying && !this.keptClassifications.has(key))
      this.keptClassifications.set(key, pending.classificationScope);
    else if (pending)
      void this.run(Scope.close(pending.classificationScope, Exit.void), pending.scope).catch(
        this.report,
      );
    const classificationScope = Scope.forkUnsafe(scope),
      sequence = ++this.listingSequence;
    // The newest classification shown when this listing replaced the last one.
    let shownClassification: number | undefined;
    const promise = this.discovery
      .listDirectory(
        {
          checkout,
          path,
          includeIgnoredStatus: false,
        },
        scope,
        report,
      )
      .then((listing) => {
        if (!isCurrent()) return listing;
        this.listingReads.get(key)!.listed = true;
        shownClassification = this.classifiedListings.get(key);
        // Entries keep their last Git classification until the new one arrives, so a refresh
        // does not flash ignored files as unignored.
        const previous = new Map(
          this.listings[key]?.entries.map((entry) => [entry.path, entry.ignored]),
        );
        this.listings[key] = {
          ...listing,
          entries: listing.entries.map((entry) =>
            entry.ignored === undefined && previous.get(entry.path) !== undefined
              ? { ...entry, ignored: previous.get(entry.path) }
              : entry,
          ),
        };
        this.emit();
        return listing;
      });
    const isOpen = () =>
      !this.closing &&
      scope.state._tag !== 'Closed' &&
      this.recovery.openCheckoutIds.includes(checkout.checkoutId);
    const isCurrent = () => isOpen() && this.listingReads.get(key)?.promise === promise;
    this.listingReads.set(key, {
      scope,
      classificationScope,
      revision,
      listed: false,
      classifying: false,
      report,
      promise,
    });
    void promise
      .then(async (listing) => {
        if (!isCurrent() || !listing.entries.some((entry) => entry.ignored === undefined)) return;
        this.listingReads.get(key)!.classifying = true;
        let ignored: CommandOutput<'getIgnoredPaths'>;
        try {
          ignored = await this.command(
            'getIgnoredPaths',
            {
              checkout,
              path,
              paths: listing.entries.map((entry) => entry.path),
            },
            classificationScope,
            report,
          );
        } catch (error) {
          // Without an answer, entries show as unclassified rather than as a stale classification.
          if (isCurrent() && this.classifiedListings.get(key) === shownClassification) {
            this.listings[key] = { ...this.listings[key], entries: listing.entries };
            this.emit();
          }
          throw error;
        }
        if (!isOpen() || (this.classifiedListings.get(key) ?? 0) > sequence) return;
        const paths = new Set(ignored.paths);
        // Only an answer that replaces the shown flags counts as the newest classification.
        if (isCurrent() || (!ignored.error && this.listings[key]))
          this.classifiedListings.set(key, sequence);
        if (isCurrent())
          this.listings[key] = {
            ...listing,
            entries: listing.entries.map((entry) => ({
              ...entry,
              ignored: ignored.error ? undefined : paths.has(entry.path),
            })),
            partial: listing.partial || !!ignored.error,
            error: ignored.error ?? listing.error,
          };
        else if (!ignored.error && this.listings[key]) {
          // A kept classification answers after a newer listing replaced its own; it is still
          // newer than the classification that listing carried over.
          const classified = new Set(listing.entries.map((entry) => entry.path));
          this.listings[key] = {
            ...this.listings[key],
            entries: this.listings[key].entries.map((entry) =>
              classified.has(entry.path) ? { ...entry, ignored: paths.has(entry.path) } : entry,
            ),
          };
        } else return;
        this.emit();
      })
      .catch(() => {
        /* The scoped command already reported its failure; keep the visible files. */
      })
      .finally(() => {
        if (this.listingReads.get(key)?.promise === promise) this.listingReads.delete(key);
        if (this.keptClassifications.get(key) === classificationScope)
          this.keptClassifications.delete(key);
        return this.run(Scope.close(classificationScope, Exit.void), scope).catch(this.report);
      });
    return promise;
  }
  /**
   * Shows a file in its checkout's tree: expands the folders above it, then focuses and selects
   * it. Levels already listed (the watcher keeps them fresh) are not listed again. While Hide
   * Ignored Files is on, a Git-ignored file (or one in an ignored folder) turns it off, or with
   * `ignored: 'skip'` is left unrevealed; only levels Git hasn't classified yet are asked about.
   * A newer reveal in the same checkout cancels this one's remaining work, and it, closing the
   * checkout or `current` returning false abandons it before it changes the tree. Resolves whether
   * the file was revealed; with `quiet`, its failures reject without being reported.
   */
  async reveal(target: FileTarget, options: RevealOptions = {}) {
    this.assertAdmission();
    this.checkout(target.checkout);
    validPath(target.path);
    const checkout = target.checkout,
      key = checkoutKey(checkout),
      report = !options.quiet,
      checkoutScope = this.discovery.getCheckoutScope(checkout),
      scope = Scope.forkUnsafe(checkoutScope);
    this.endReveal(key);
    this.reveals.set(key, scope);
    const isCurrent = () =>
      !this.closing &&
      this.reveals.get(key) === scope &&
      this.recovery.openCheckoutIds.includes(checkout.checkoutId) &&
      this.recovery.checkouts.some((item) => sameCheckout(item, checkout)) &&
      (options.current?.() ?? true);
    const findListed = (path: string) =>
      this.listings[JSON.stringify([key, getParentPath(path)])]?.entries.find(
        (entry) => entry.path === path,
      );
    const parts = target.path.split('/'),
      levels = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    try {
      const entries: DirectoryEntry[] = [];
      for (const path of levels) {
        let entry = findListed(path);
        if (!entry) {
          const listing = await this.listCheckout(checkout, getParentPath(path), report);
          if (!isCurrent()) return false;
          entry = findListed(path) ?? listing.entries.find((item) => item.path === path);
          if (!entry)
            throw editorError(listing.error ?? 'Active file unavailable. Refresh and retry.');
        }
        entries.push(entry);
      }
      let showIgnored = false;
      if (this.checkout(checkout).tree.hideIgnoredFiles) {
        let ignored = entries.some((entry) => entry.ignored);
        const unclassified = ignored
          ? []
          : levels.filter((_, index) => entries[index].ignored === undefined);
        if (unclassified.length) {
          const answers = await Promise.all(
            unclassified.map((path) =>
              this.command(
                'getIgnoredPaths',
                { checkout, path: getParentPath(path), paths: [path] },
                scope,
                report,
              ),
            ),
          );
          if (!isCurrent()) return false;
          ignored = answers.some((answer) => answer.paths.length > 0);
        }
        if (ignored) {
          if (options.ignored === 'skip') return false;
          showIgnored = true;
        }
      }
      if (!isCurrent()) return false;
      this.updateTree(checkout, {
        expanded: [...new Set([...this.checkout(checkout).tree.expanded, ...levels.slice(0, -1)])],
        focus: target.path,
        selected: [target.path],
        ...(showIgnored ? { hideIgnoredFiles: false } : {}),
      });
      return true;
    } catch (error) {
      // A reveal superseded, closed or no longer wanted is abandoned, whatever its work met.
      if (!isCurrent()) return false;
      throw error;
    } finally {
      // A superseded reveal's scope was closed by the reveal replacing it.
      if (this.reveals.get(key) === scope) this.endReveal(key);
    }
  }
  /** Cancels a checkout's running reveal, if any. */
  private endReveal(key: string) {
    const scope = this.reveals.get(key);
    if (!scope) return;
    this.reveals.delete(key);
    void this.runEffect(Scope.close(scope, Exit.void)).catch(this.report);
  }
  async lookup(checkout: CheckoutTarget, query: string) {
    this.assertAdmission();
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
    this.assertAdmission();
    await this.rewatchLost(checkout);
    return this.refreshCheckout(checkout);
  }
  /** Watches an open checkout again once its watch gave up, so live updates return with the daemon. */
  private async rewatchLost(checkout: CheckoutTarget) {
    if (
      this.closing ||
      !this.discovery.isWatchLost(checkout) ||
      !this.recovery.openCheckoutIds.includes(checkout.checkoutId)
    )
      return;
    await this.observe(checkout).catch(this.report);
  }
  private refreshCheckout(checkout: CheckoutTarget): Promise<void> {
    this.checkout(checkout);
    return this.discovery.refresh(checkout, {
      isCurrent: () => this.recovery.openCheckoutIds.includes(checkout.checkoutId),
      refreshListings: () => {
        const paths = ['', ...this.checkout(checkout).tree.expanded];
        return Promise.allSettled(paths.map((path) => this.listCheckout(checkout, path)));
      },
      publishGit: (status) => {
        this.git[checkoutKey(checkout)] = status;
      },
      captureComparison: () => {
        const selected = this.checkout(checkout),
          mode = readOwn(selected.fileViews, selected.active);
        if (
          !selected.active ||
          !mode ||
          mode === 'file' ||
          mode === 'conflict' ||
          this.preservation.active
        )
          return;
        const target = { checkout, path: selected.active },
          key = fileKey(target);
        return {
          input: { target, area: mode },
          isCurrent: () =>
            !this.preservation.active &&
            selected.active === target.path &&
            readOwn(selected.fileViews, target.path) === mode,
          apply: async (comparison) => {
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
          },
        };
      },
    });
  }
  createLookup() {
    this.assertAdmission();
    this.assertReady();
    const lookup = new EditorLookup(
      () => this.admissionsOpen && !this.closing,
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
  createTextSearch() {
    this.assertAdmission();
    this.assertReady();
    const search = new EditorTextSearch(
      () => this.admissionsOpen && !this.closing,
      this.scope,
      (effect) => this.runEffect(effect),
      (input, signal) => {
        this.checkout(input.checkout);
        return this.client.command('searchText', input, { signal });
      },
    );
    this.workflows.add(search);
    const stop = search.stop.bind(search);
    search.stop = () => {
      this.workflows.delete(search);
      stop();
    };
    return search;
  }
  createMutation(action: MutationAction) {
    this.assertAdmission();
    this.checkout(action.checkout);
    const mutation = new EditorMutation(
      () => this.admissionsOpen && !this.closing,
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
    this.assertAdmission();
    return this.inspectIn(checkout, paths, this.scope);
  }
  private async inspectIn(checkout: CheckoutTarget, paths: string[], scope: Scope.Scope) {
    this.checkout(checkout);
    paths.forEach((path) => validPath(path));
    return this.command('inspectEntries', { checkout, paths }, scope);
  }
  async mutate(input: Omit<WorkspaceOperation, 'clientId' | 'id'> & { id?: string }) {
    this.assertAdmission();
    return this.mutateFiles(input);
  }
  /**
   * `saving` is a Save of a buffer whose file isn't on disk, which creates it with the buffer's
   * text; it may run inside a Close's preservation, whose Save it is.
   */
  private async mutateFiles(
    input: Omit<WorkspaceOperation, 'clientId' | 'id'> & { id?: string },
    saving?: EditorBuffer,
  ) {
    this.checkout(input.checkout);
    this.assertNotInitializing(input.checkout);
    if (this.preservation.active && !saving)
      throw editorError('Finish the captured preservation action first.');
    const operation: WorkspaceOperation = {
      ...structuredClone(input),
      clientId: this.clientId,
      id: input.id ?? crypto.randomUUID(),
    };
    if (this.operations.has(operationKey(this.clientId, operation.id)))
      throw editorError(
        'Operation already submitted. Resolve its status instead of dispatching it again.',
      );
    // A batch's destination is a folder, which may be the root.
    const batch = operation.sources.length > 1;
    if (operation.destination !== undefined)
      validPath(operation.destination, operation.kind === 'import' || batch);
    const destinations = listOperationDestinations(operation);
    if (
      operation.sources.some((source) => this.uncertainAffects(source.target)) ||
      destinations.some((path) => this.uncertainAffects({ checkout: operation.checkout, path }))
    )
      throw editorError('Resolve the pending operation on these entries before applying another.');
    for (const source of [...operation.sources, ...(operation.replacements ?? [])]) {
      validPath(source.target.path);
      if (!sameCheckout(source.target.checkout, operation.checkout))
        throw editorError('A file operation must use one exact checkout.');
    }
    const replacementPaths = [
      ...(operation.replacements ?? []).map((item) => item.target.path),
      ...destinations,
    ];
    if (
      [...this.buffers.values()].some(
        (buffer) =>
          buffer !== saving &&
          sameCheckout(buffer.target.checkout, operation.checkout) &&
          !operation.sources.some((source) =>
            isPathAtOrInside(buffer.target.path, source.target.path),
          ) &&
          replacementPaths.some((path) =>
            isPathAtOrInside(
              buffer.target.path.normalize('NFC').toLowerCase(),
              path.normalize('NFC').toLowerCase(),
            ),
          ),
      )
    )
      throw editorError(
        'Replacement has open buffers. Close them safely before replacing their files.',
      );
    if (
      [...this.buffers.values()].some(
        (buffer) =>
          sameCheckout(buffer.target.checkout, operation.checkout) &&
          operation.sources.some((source) =>
            isPathAtOrInside(buffer.target.path, source.target.path),
          ) &&
          (buffer.saving || buffer.pendingSave),
      )
    )
      throw editorError('Resolve the source Save before moving or copying it.');
    // Send the source drafts before any external mutation, including Trash.
    if (saving) await this.outbox.flush();
    else await this.flushRecovery();
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
        throw editorError(
          'Operation response identity mismatch. Original pending evidence retained.',
        );
      await this.reconcile(result);
      if (this.recovery.openCheckoutIds.includes(operation.checkout.checkoutId))
        await this.refreshCheckout(operation.checkout);
      return result;
    } catch (error) {
      if (this.operations.has(operationKey(this.clientId, operation.id)))
        this.report(
          editorError(
            'Operation outcome unconfirmed. Resolve status before taking further action.',
          ),
        );
      throw error;
    }
  }
  async resolveOperation(id: string, operationClientId = this.clientId) {
    this.assertAdmission();
    const known = this.operations.get(operationKey(operationClientId, id));
    if (!known) throw editorError('Unknown operation.');
    const result = await this.command('operationStatus', { clientId: operationClientId, id });
    if (!result) {
      this.report(
        editorError('Operation status unavailable; drafts and original references retained.'),
      );
      return null;
    }
    if (result.clientId !== operationClientId || result.id !== id)
      throw editorError('Operation status identity mismatch.');
    await this.reconcile(result);
    if (this.recovery.openCheckoutIds.includes(result.checkout.checkoutId))
      await this.refreshCheckout(result.checkout);
    return result;
  }
  async reconcileRecovery() {
    this.assertAdmission();
    this.assertReady();
    await this.reconcile();
  }
  private uncertainAffects(target: FileTarget) {
    return [...this.operations.values()].some(({ operation, result }) => {
      if (result.outcome !== 'uncertain' || !sameCheckout(result.checkout, target.checkout))
        return false;
      const paths = operation
        ? [
            ...operation.sources.map((source) => source.target.path),
            ...listOperationDestinations(operation),
          ]
        : result.items.flatMap((item) => [
            item.source,
            ...(item.destination ? [item.destination] : []),
          ]);
      return (
        !paths.length ||
        paths.some(
          (path) => isPathAtOrInside(target.path, path) || isPathAtOrInside(path, target.path),
        )
      );
    });
  }
  /** Takes an operation's completed items into what the editor remembers by path. */
  private applyOperationFacts(result: OperationResult) {
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
      throw editorError(
        'Operation checkout identity unavailable or changed. Evidence and drafts retained without rebinding.',
      );
    known.result = result;
    for (const item of result.items.filter((item) => item.outcome === 'completed')) {
      const itemKey = JSON.stringify([item.source, item.destination]);
      if (known.applied.has(itemKey)) continue;
      if (operation && !operation.sources.some((source) => source.target.path === item.source))
        continue;
      if (result.kind === 'move' && item.destination) {
        moveRecoveryReferences(this.recovery, result.checkout, item.source, item.destination);
        this.preservation.moveClosedReferences(result.checkout, item.source, item.destination);
      }
      // Trash keeps dirty drafts visible at their original target for manual recovery.
      if (result.kind === 'trash')
        this.preservation.removeTrashedReferences(result.checkout, item.source);
      known.applied.add(itemKey);
    }
  }
  /**
   * Reads this editor's recovery from the store (which also takes in other clients' moves) and
   * follows it, takes in the operations it has not acknowledged (and `result`), then
   * acknowledges each settled one.
   */
  private reconcile(result?: OperationResult, initial?: RecoveryLoad): Promise<void> {
    return this.run(
      this.factsLock.withPermits(1)(
        Effect.tryPromise({
          try: async () => {
            if (this.closing) return;
            while (this.initialization) await this.initialization.done;
            if (!this.recoveryWatch) await this.watchRecovery();
            const loaded =
              initial ?? (await this.command('loadRecovery', { clientId: this.clientId }));
            if (this.closing) return;
            if (loaded.state.clientId !== this.clientId)
              throw editorError('Recovery belongs to another editor client.');
            this.follow(loaded.state, true);
            const facts = [
              ...new Map(
                [...loaded.operations, ...(result ? [result] : [])].map((fact) => [
                  operationKey(fact.clientId, fact.id),
                  fact,
                ]),
              ).values(),
            ];
            for (const fact of facts) this.applyOperationFacts(fact);
            if (facts.length) this.changed();
            for (const fact of facts) {
              if (fact.outcome === 'uncertain' || this.closing) continue;
              await this.command('acknowledgeOperation', {
                clientId: this.clientId,
                operationClientId: fact.clientId,
                id: fact.id,
              });
              this.operations.get(operationKey(fact.clientId, fact.id))!.acknowledged = true;
            }
            this.emit();
          },
          catch: normalizeApplicationError,
        }),
      ),
    );
  }
  /** After the store refused an edit as given, follows its recovery and sends what differs. */
  private async resync(edit: RecoveryEditRequest, error: ApplicationError) {
    // A tab the store would not close (it holds a draft the editor did not know) stays open.
    if (edit.kind === 'closeTab') {
      this.closedBuffers.delete(edit.bufferId);
      return false;
    }
    const loaded = await this.command('loadRecovery', { clientId: this.clientId });
    if (this.closing) throw error;
    this.follow(loaded.state, true);
    return true;
  }
  /**
   * Takes in where the store holds this editor's buffers: a tab whose buffer a move took to
   * another file follows it, and a tab at that file whose clean buffer gave way leaves (its
   * unsent text kept at a new path). A draft the store made itself (a copy, a restored save) opens
   * as a tab; an outline has no text, so its text is read with the next reconcile. A `full` state,
   * read just now, also gets the edits it lacks: tabs it doesn't hold, and text it holds otherwise.
   */
  private follow(store: RecoveryOutline | RecoveryState, full: boolean) {
    const held = new Map(store.buffers.map((buffer) => [buffer.id, buffer]));
    const shown = new Set([...this.tabs.values()].map((tab) => tab.id));
    let changed = false,
      unread = false;
    // oxlint-disable-next-line no-useless-spread -- Moving a tab reinserts it; visit each once.
    for (const [key, tab] of [...this.tabs]) {
      const buffer = held.get(tab.id);
      // A checkout relisted under its ID (after `git init`) is the editor's own rebind.
      if (!buffer || !sameCheckout(buffer.target.checkout, tab.target.checkout)) continue;
      if (buffer.target.path === tab.target.path || this.tabs.get(key) !== tab) continue;
      this.moveTab(key, buffer.target);
      changed = true;
    }
    for (const buffer of store.buffers) {
      if (!buffer.draft || this.closedBuffers.has(buffer.id)) continue;
      if (shown.has(buffer.id)) {
        // A draft the store made over a clean tab (another window's copy onto it) is the newer:
        // the tab takes it, rather than sending its stale text over it.
        const key = fileKey(buffer.target),
          own = this.buffers.get(key);
        if (!own || isDirty(own) || this.outbox.isDraftPending(buffer.id)) continue;
        if (!('text' in buffer.draft)) {
          unread = true;
          continue;
        }
        if (own.text === buffer.draft.text && own.disk.version === buffer.draft.disk.version)
          continue;
        own.text = buffer.draft.text;
        own.disk = structuredClone(buffer.draft.disk);
        changed = true;
        continue;
      }
      if (!('text' in buffer.draft)) {
        unread = true;
        continue;
      }
      if (!this.recovery.checkouts.some((c) => sameCheckout(c, buffer.target.checkout))) continue;
      const key = fileKey(buffer.target),
        own = this.buffers.get(key);
      // This editor's text for the file, under a buffer the store doesn't hold, stays the newer.
      if (own && isDirty(own) && own.text !== buffer.draft.text) this.keepElsewhere(own);
      this.showDraft({ id: buffer.id, target: buffer.target }, buffer.draft);
      changed = true;
    }
    if (full) {
      const drafts = new Map(
        (store as RecoveryState).buffers.map((buffer) => [buffer.id, buffer.draft?.text]),
      );
      // A clean buffer the editor no longer shows (one whose close was lost) is closed, so it
      // never holds a file the editor opens again under another buffer.
      for (const buffer of (store as RecoveryState).buffers)
        if (!buffer.draft && !shown.has(buffer.id) && !this.outbox.isTabPending(buffer.id))
          this.outbox.closeTab(buffer.id);
      for (const [key, tab] of this.tabs) {
        if (this.outbox.isTabPending(tab.id)) continue;
        if (!held.has(tab.id)) this.outbox.openTab(tab.id, tab.target);
        const buffer = this.buffers.get(key);
        const text = buffer && (isDirty(buffer) ? buffer.text : undefined);
        if (buffer && text !== drafts.get(tab.id)) this.sendDraft(buffer);
      }
      this.outbox.forgetLayout();
      changed = true;
    }
    if (unread) void this.reconcile().catch(this.report);
    if (changed) {
      this.changed();
      this.emit();
    }
  }
  /** Moves a tab, its buffer and its view to where the store's buffer now is. */
  private moveTab(key: string, target: FileTarget) {
    const tab = this.tabs.get(key)!,
      next = fileKey(target),
      source = tab.target.path;
    // A clean buffer at the destination gave way to this one in the store.
    if (this.tabs.has(next)) this.dropReplacedTab(next);
    this.tabs.delete(key);
    tab.target = structuredClone(target);
    this.tabs.set(next, tab);
    const buffer = this.buffers.get(key);
    if (buffer) {
      this.buffers.delete(key);
      buffer.target = structuredClone(target);
      this.buffers.set(next, buffer);
    }
    this.comparisonAttempts.delete(key);
    if (this.comparisons[key]) {
      this.comparisons[next] = this.comparisons[key];
      delete this.comparisons[key];
    }
    const selected = readOwn(this.recovery.views, target.checkout.checkoutId);
    if (!selected) return;
    const rename = (path: string) => (path === source ? target.path : path);
    selected.openFiles = [...new Set(selected.openFiles.map(rename))];
    selected.active = rename(selected.active);
    if (selected.preview !== null) selected.preview = rename(selected.preview);
    for (const memory of [selected.fileViews, selected.positions] as Record<string, unknown>[])
      if (Object.hasOwn(memory, source)) {
        writeOwn(memory, target.path, memory[source]);
        delete memory[source];
      }
  }
  /** A tab whose clean buffer a move replaced leaves; text not yet sent is kept elsewhere. */
  private dropReplacedTab(key: string) {
    const tab = this.tabs.get(key)!,
      buffer = this.buffers.get(key);
    this.tabs.delete(key);
    this.closedBuffers.add(tab.id);
    // The store keeps the replaced ID until the client closes it.
    this.outbox.closeTab(tab.id);
    if (buffer && isDirty(buffer)) this.keepElsewhere(buffer);
    this.buffers.delete(key);
    delete this.comparisons[key];
    this.comparisonAttempts.delete(key);
  }
  /**
   * A close whose reply was lost committed, as the store showed later: the Discard stands. A
   * closed tab closes here too; a Discard that keeps its tab (Quit, Reload) drops its text.
   */
  private finishClose(bufferId: string, reopen: { target: FileTarget } | undefined) {
    const entry = [...this.tabs].find(([, tab]) => tab.id === bufferId);
    if (!entry) return;
    const [key, tab] = entry;
    const buffer = this.buffers.get(key);
    if (reopen) {
      if (buffer) {
        buffer.text = buffer.disk.text;
        buffer.conflict = undefined;
      }
      this.outbox.openTab(tab.id, tab.target);
    } else {
      closeRecoveryReferences(this.recovery, [tab.target], 'files');
      this.closedBuffers.add(tab.id);
      this.tabs.delete(key);
      this.buffers.delete(key);
      delete this.comparisons[key];
      this.comparisonAttempts.delete(key);
    }
    this.changed();
    this.emit();
  }
  /**
   * Keeps text the store has no place for (its buffer was replaced) as a draft at a new path
   * beside its file, with the file text it was edited from, and says where.
   */
  private keepElsewhere(buffer: EditorBuffer) {
    const { checkout } = buffer.target;
    const taken = new Set(
      [...this.tabs.values()]
        .filter((tab) => sameCheckout(tab.target.checkout, checkout))
        .map((tab) => tab.target.path),
    );
    // Files the editor has listed are taken too; a Save creates the file and never replaces one.
    for (const listing of Object.values(this.listings))
      for (const entry of listing.entries) taken.add(entry.path);
    const target = { checkout, path: findFreePath(buffer.target.path, taken) };
    const tab = { id: crypto.randomUUID(), target };
    this.showDraft(tab, { text: buffer.text, disk: buffer.disk });
    this.buffers.get(fileKey(target))!.newFile = true;
    this.outbox.openTab(tab.id, target);
    this.outbox.updateDraft(tab.id, buffer.text, buffer.disk);
    this.report(
      `${buffer.target.path} was replaced while it had unsaved changes. They are kept in ${target.path}; Save creates it.`,
    );
  }
  /** Immediately stop admissions; cleanup is owned by the caller outside this model scope. */
  private beginDisposal() {
    if (this.closing) return;
    this.closing = true;
    this.discovery.invalidateActivation();
    this.preservation.cancelPrompt();
    this.outbox.clear();
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
        Effect.ensuring(this.discovery.joinObservationClosures()),
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

/** How `reveal` treats an ignored file while Hide Ignored Files is on, and when it gives up. */
export type RevealOptions = {
  /** 'show' (the default) turns Hide Ignored Files off; 'skip' leaves the file unrevealed. */
  ignored?: 'show' | 'skip';
  /** Checked after each listing and before the tree changes; once false, the reveal stops. */
  current?: () => boolean;
  /** Rejects on failure without reporting it, for a reveal the user didn't ask for. */
  quiet?: boolean;
};
export type EditorDependencies = {
  client: EditorClient;
  clientId?: string;
  /** Backoff before each re-watch of a checkout; defaults to the transcript's. Its length is the cap. */
  watchRetryMs?: readonly number[];
};
export type EditorModel = EditorModelState;
export interface EditorController {
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
  /** Runs `git init` in an open plain-folder checkout; its tabs and drafts move to the result. */
  initializeRepository(checkout: CheckoutTarget): Promise<CheckoutTarget>;
  selectCheckout(target: CheckoutTarget): Promise<boolean>;
  /** Sends the recovery edits made so far; resolves once each has committed. */
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
  setFollowActiveFile(follow: boolean): void;
  list(checkout: CheckoutTarget, path?: string): Promise<DirectoryListing>;
  reveal(target: FileTarget, options?: RevealOptions): Promise<boolean>;
  lookup(checkout: CheckoutTarget, query: string): Promise<CommandOutput<'lookupFiles'>>;
  refresh(checkout: CheckoutTarget): Promise<void>;
  createLookup(): EditorLookup;
  /** Searches file contents in one open checkout; dispose it with the popup that owns it. */
  createTextSearch(): EditorTextSearch;
  createMutation(action: MutationAction): EditorMutation;
  inspect(checkout: CheckoutTarget, paths: string[]): Promise<CommandOutput<'inspectEntries'>>;
  mutate(
    input: Omit<WorkspaceOperation, 'clientId' | 'id'> & { id?: string },
  ): Promise<OperationResult>;
  resolveOperation(id: string, operationClientId?: string): Promise<OperationResult | null>;
  reconcileRecovery(): Promise<void>;
  dispose(): Promise<void>;
}

/** Acquire once under the composition root's scope; no runtime or backend is installed. */
export const makeEditorModel = (
  dependencies: EditorDependencies,
): Effect.Effect<EditorModel, ApplicationError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const handle = yield* FiberHandle.make<void, never>().pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    const debounce: DebounceRunner = yield* FiberHandle.runtime(handle)<never>();
    const model = yield* Effect.try({
      try: () => new EditorModelState(scope, dependencies, debounce),
      catch: normalizeApplicationError,
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
