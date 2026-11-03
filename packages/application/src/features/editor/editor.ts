import { EditorDiscovery } from './discovery.ts';
import { EditorPreservation, type ConfirmedClose } from './preservation.ts';
import { RecoveryPublications, type PublicationOptions } from './recovery-publications.ts';
import {
  EditorLookup,
  EditorMutation,
  getMutationDestinations,
  type MutationAction,
} from './workflows.ts';
import { Deferred, Effect, Exit, Fiber, Scope, Semaphore, type ManagedRuntime } from 'effect';
import { normalizeApplicationError, runApplicationEffect } from '../../runtime/effect-client.ts';
import { decodeEditorRecovery } from '@moonbase/contracts/workspace-schema';
import {
  ApplicationError,
  emptyRecovery,
  maximumFileBytes,
  type CheckoutTarget,
  type CheckoutView,
  type Comparison,
  type DirectoryListing,
  type EditorClient,
  type EditorPosition,
  type EditorRecovery,
  type FileDocument,
  type FileTarget,
  type FileView,
  type GitStatus,
  type OperationResult,
  type SaveResult,
  type RecoveryChange,
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
export { checkoutKey, fileKey } from './references.ts';
// These diagnostics are authored by this module; injected failures use shared normalization.
const editorError = (message: string) => new ApplicationError({ code: 'Unavailable', message });
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
  private preservation: EditorPreservation;
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
  private listeners = new Set<() => void>();
  private referenceRevision = 0;
  private deferredFacts: {
    changes: RecoveryChange[];
    result?: OperationResult;
    forcePublication: boolean;
  }[] = [];
  private publications: RecoveryPublications;
  private discovery: EditorDiscovery;
  private snapshot!: EditorSnapshot;
  private scope: Scope.Closeable;
  constructor(scope: Scope.Closeable, options: EditorDependencies) {
    this.scope = scope;
    this.client = options.client;
    this.clientId = options.clientId ?? crypto.randomUUID();
    if (!this.clientId.trim())
      throw editorError('An editor requires its own nonempty recovery client ID.');
    this.discovery = new EditorDiscovery(scope, {
      execute: (effect) => this.runEffect(effect),
      watch: (...args) => this.client.watch(...args),
      listDirectory: (input, scope) => this.command('listDirectory', input, scope),
      readFile: (target, scope) => this.command('readFile', target, scope),
      readComparison: (input, scope) => this.command('readComparison', input, scope),
      gitStatus: (checkout, scope) => this.command('gitStatus', { checkout }, scope),
      isClosing: () => this.closing,
      notify: () => this.emit(),
      report: (error) => this.report(error),
    });
    this.publications = new RecoveryPublications(this.clientId, scope, {
      execute: (effect) => this.runEffect(effect),
      run: (effect) => this.run(effect),
      isClosing: () => this.closing,
      persistRecovery: (request) => this.command('persistRecovery', request),
      getRecoveryPublication: (request) => this.command('getRecoveryPublication', request),
      confirmSaves: (requests) => {
        for (const id of requests) {
          this.saveResults.delete(id);
          for (const buffer of this.buffers.values())
            if (buffer.pendingSave?.requestId === id) buffer.pendingSave = undefined;
        }
      },
      resumeFacts: () => this.resumeFacts(),
      notify: () => this.emit(),
      report: (error) => this.report(error),
    });
    this.preservation = new EditorPreservation({
      run: (effect) => this.run(effect),
      isClosing: () => this.closing,
      retainsConfirmation: () => this.publications.retainsConfirmation,
      invalidateReads: (kind) => {
        this.discovery.invalidateActivation();
        if (kind === 'close') this.publications.cancelScheduled();
      },
      notify: () => this.emit(),
      report: (error) => this.report(error),
      afterRelease: async () => {
        this.resumeFacts();
        await this.activateSelected();
        this.schedule();
      },
    });
    this.recovery = emptyRecovery(this.clientId);
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
        this.publications.confirmed &&
        ![...this.buffers.values()].some((buffer) => buffer.saving || buffer.pendingSave) &&
        ![...this.operations.values()].some((value) => !value.acknowledged),
      disposed: this.disposed,
      closePrompt: this.preservation.prompt,
      preserving: this.preservation.active,
      discoveryRevision: this.discovery.discoveryRevision,
      recovery: this.recovery,
      buffers: [...this.buffers.values()],
      comparisons: this.comparisons,
      listings: this.listings,
      git: this.git,
      publication: this.publications.pending,
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
    this.errors = [...this.errors.slice(-19), ApplicationError.fromUnknown(error).message];
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
      this.report(error);
      throw error;
    }
  }
  async load() {
    this.assertAdmission();
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
      throw editorError('Recovery belongs to another editor client.');
    this.recovery = decodeEditorRecovery(loaded.state);
    this.publications.initialize(loaded.revision);
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
  private observe(checkout: CheckoutTarget) {
    return this.discovery.observe(
      checkout,
      () => this.recovery.openCheckoutIds.includes(checkout.checkoutId),
      (isCurrent) => {
        void this.publishFacts([]).catch(this.report);
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
    if (this.closing) return target;
    const collision = this.recovery.checkouts.find(
      (item) => item.checkoutId === target.checkoutId && !sameCheckout(item, target),
    );
    if (collision)
      throw editorError('Checkout identity changed; retained work has not been rebound.');
    if (!this.recovery.checkouts.some((item) => sameCheckout(item, target))) {
      this.recovery.checkouts.push(target);
      writeOwn(this.recovery.views, target.checkoutId, view());
    }
    const reopening = !this.recovery.openCheckoutIds.includes(target.checkoutId);
    if (reopening) {
      this.recovery.openCheckoutIds.push(target.checkoutId);
      await this.observe(target);
    }
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
  private resumeFacts() {
    if (this.closing || this.preservation.active || this.publications.pending) return;
    // A pre-capture recovery snapshot may predate a committed Discard; fetch fresh state.
    for (const request of this.deferredFacts.splice(0))
      void this.publishFacts(
        request.changes,
        request.result,
        undefined,
        request.forcePublication,
      ).catch(this.report);
  }
  private invalidateRecovery() {
    this.publications.invalidate();
  }
  private changed() {
    this.invalidateRecovery();
    this.schedule();
  }
  private schedule() {
    if (
      !this.ready ||
      this.loading ||
      this.closing ||
      this.preservation.active ||
      this.publications.pending
    )
      return;
    this.publications.schedule(() => this.flushRecovery());
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
  private publicationBlocked() {
    return this.publications.blocked();
  }
  private publish(state: EditorRecovery, options: PublicationOptions = {}) {
    return this.publications.publish(state, options);
  }
  async resolveRecoveryPublication(): Promise<boolean> {
    this.assertAdmission();
    if (this.closing) return false;
    const { resolved, rejected } = await this.publications.resolve(() =>
      this.preservation.release(),
    );
    if (resolved && !rejected) this.schedule();
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
    this.assertAdmission();
    return this.flushRecovery();
  }
  private async flushRecovery() {
    this.assertReady();
    if (this.preservation.active)
      throw editorError('Finish the captured preservation action before flushing.');
    this.publications.cancelScheduled();
    await this.publish(this.capture());
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
          this.report('File unavailable on disk. Retained buffer and edits remain accessible.');
          disk = null;
        }
      } else {
        try {
          comparison = await this.discovery.readComparison({ target, area: mode }, selection);
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
    this.assertAdmission();
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
    this.assertAdmission();
    const captured = structuredClone(target),
      key = fileKey(captured);
    this.checkout(captured.checkout);
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.pendingSave || this.preservation.active || this.publicationBlocked())
      return false;
    const reference = this.referenceRevision,
      revision = this.publications.currentRevision;
    const sameBuffer = () =>
      this.buffers.get(key) === buffer &&
      fileKey(buffer.target) === key &&
      this.referenceRevision === reference;
    return this.preservation.reload(captured, {
      readFile: (target) => this.command('readFile', target),
      captureRecovery: () => this.capture(),
      publishRecovery: (state, options) => this.publish(state, options),
      isCurrent: () => sameBuffer() && this.publications.currentRevision === revision,
      applyConfirmedReload: (disk) => {
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
      this.publications.pending ||
      this.publications.inFlight !== 0 ||
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
    if (
      this.publicationBlocked() ||
      this.preservation.active ||
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
    const referenceRevision = this.referenceRevision;
    return this.preservation.close(captured, kind, checkout && structuredClone(checkout), {
      captureBuffer: (target) => {
        const buffer = this.buffers.get(fileKey(target));
        return buffer && structuredClone(buffer);
      },
      saveFile: (target, generation) => this.saveFile(target, false, generation),
      captureRecovery: () => this.capture(),
      publishRecovery: (state, options) => this.publish(state, options),
      referencesCurrent: () => referenceRevision === this.referenceRevision,
      applyConfirmedClose: (result) => this.applyConfirmedClose(result),
    });
  }
  private async applyConfirmedClose({ targets, discarded, state, kind, checkout }: ConfirmedClose) {
    // A confirmed close overrides older Copy materialization only for these exact targets.
    for (const known of this.operations.values())
      if (known.result.kind === 'copy' && known.copies)
        for (const target of targets)
          if (sameCheckout(target.checkout, known.result.checkout))
            (known.closedCopyTargets ??= new Set()).add(fileKey(target));
    closeRecoveryReferences(this.recovery, targets, kind, checkout);
    this.recovery.drafts = state.drafts;
    if (kind === 'quit')
      for (const key of discarded) {
        const buffer = this.buffers.get(key)!;
        buffer.text = buffer.disk.text;
        buffer.conflict = undefined;
      }
    else {
      for (const key of targets.map(fileKey)) {
        this.buffers.delete(key);
        delete this.comparisons[key];
        this.comparisonAttempts.delete(key);
      }
      if (kind === 'checkout' && checkout) {
        try {
          await this.discovery.releaseObservation(checkout);
        } catch (error) {
          this.report(error);
        }
      }
    }
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
      }
    selected.active = action.active;
    selected.preview = null;
    this.invalidateRecovery();
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
  list(checkout: CheckoutTarget, path = '') {
    this.assertAdmission();
    return this.listCheckout(checkout, path);
  }
  private listCheckout(checkout: CheckoutTarget, path: string) {
    return this.listIn(checkout, path, this.discovery.getCheckoutScope(checkout));
  }
  private async listIn(checkout: CheckoutTarget, path: string, scope: Scope.Scope) {
    const selected = this.checkout(checkout);
    validPath(path, true);
    const listing = await this.discovery.listDirectory(
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
    this.assertAdmission();
    const selected = this.checkout(target.checkout);
    validPath(target.path);
    const scope = this.discovery.getCheckoutScope(target.checkout);
    const parts = target.path.split('/'),
      expanded: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      const listing = await this.discovery.listDirectory(
        {
          checkout: target.checkout,
          path: parts.slice(0, i).join('/'),
          hideIgnored: false,
        },
        scope,
      );
      const entry = listing.entries.find((item) => item.path === path);
      if (!entry) throw editorError(listing.error ?? 'Active file unavailable. Refresh and retry.');
      if (entry.ignored && selected.tree.hideIgnored && !showIgnored)
        throw editorError(
          'Active file is hidden. Turn off Hide Git-ignored files and reveal again.',
        );
      if (i < parts.length - 1) expanded.push(path);
    }
    this.updateTree(target.checkout, {
      expanded: [...new Set([...selected.tree.expanded, ...expanded])],
      focus: target.path,
      selected: [target.path],
      ...(showIgnored ? { hideIgnored: false } : {}),
    });
    await Promise.all(['', ...expanded].map((path) => this.listCheckout(target.checkout, path)));
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
  refresh(checkout: CheckoutTarget): Promise<void> {
    this.assertAdmission();
    return this.refreshCheckout(checkout);
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
    this.checkout(input.checkout);
    if (this.preservation.active || this.publicationBlocked())
      throw editorError('Finish the captured preservation/publication action first.');
    const operation: WorkspaceOperation = {
      ...structuredClone(input),
      clientId: this.clientId,
      id: input.id ?? crypto.randomUUID(),
    };
    if (this.operations.has(operationKey(this.clientId, operation.id)))
      throw editorError(
        'Operation already submitted. Resolve its status instead of dispatching it again.',
      );
    if (operation.destination !== undefined)
      validPath(operation.destination, operation.kind === 'import');
    if (
      operation.sources.some((source) => this.uncertainAffects(source.target)) ||
      (operation.destination &&
        this.uncertainAffects({ checkout: operation.checkout, path: operation.destination }))
    )
      throw editorError('Resolve the pending operation on these entries before applying another.');
    for (const source of [...operation.sources, ...(operation.replacements ?? [])]) {
      validPath(source.target.path);
      if (!sameCheckout(source.target.checkout, operation.checkout))
        throw editorError('A file operation must use one exact checkout.');
    }
    const replacementPaths = (operation.replacements ?? []).map((item) => item.target.path);
    if (operation.destination)
      replacementPaths.push(
        ...getMutationDestinations(operation.sources, operation.destination).destinations,
      );
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
      throw editorError(
        'Replacement has open buffers. Close them safely before replacing their files.',
      );
    if (
      [...this.buffers.values()].some(
        (buffer) =>
          sameCheckout(buffer.target.checkout, operation.checkout) &&
          operation.sources.some((source) => affected(buffer.target.path, source.target.path)) &&
          (buffer.saving || buffer.pendingSave),
      )
    )
      throw editorError('Resolve the source Save before moving or copying it.');
    // Publish dirty source drafts before any external mutation, including Trash.
    await this.flushRecovery();
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
        throw editorError(
          'Operation response identity mismatch. Original pending evidence retained.',
        );
      await this.publishFacts([], result);
      if (this.recovery.openCheckoutIds.includes(operation.checkout.checkoutId))
        await this.refreshCheckout(operation.checkout);
      return result;
    } catch (error) {
      if (this.operations.has(operationKey(this.clientId, operation.id)))
        this.report('Operation outcome unconfirmed. Resolve status before taking further action.');
      throw error;
    }
  }
  async resolveOperation(id: string, operationClientId = this.clientId) {
    this.assertAdmission();
    const known = this.operations.get(operationKey(operationClientId, id));
    if (!known) throw editorError('Unknown operation.');
    const result = await this.command('operationStatus', { clientId: operationClientId, id });
    if (!result) {
      this.report('Operation status unavailable; drafts and original references retained.');
      return null;
    }
    if (result.clientId !== operationClientId || result.id !== id)
      throw editorError('Operation status identity mismatch.');
    await this.publishFacts([], result);
    if (this.recovery.openCheckoutIds.includes(result.checkout.checkoutId))
      await this.refreshCheckout(result.checkout);
    return result;
  }
  async reconcileRecovery() {
    this.assertAdmission();
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
      throw editorError(
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
        this.preservation.removeTrashedReferences(result.checkout, item.source);
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
            const boundary = this.preservation.generation;
            const check = () => {
              if (
                this.closing ||
                this.publications.pending ||
                boundary !== this.preservation.generation ||
                (this.preservation.active && preservation !== boundary)
              )
                throw deferObservation;
            };
            try {
              check();
              await this.publications.waitForIdle();
              check();
              const loaded =
                initial ?? (await this.command('loadRecovery', { clientId: this.clientId }));
              check();
              if (loaded.state.clientId !== this.clientId)
                throw editorError('Recovery belongs to another editor client.');
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
              if (this.preservation.active) {
                // A captured Save may publish its own known revision, never remap another captured draft.
                if (
                  facts.some((fact) =>
                    fact.recoveryChanges.some(
                      (change) =>
                        change.clientId === this.clientId &&
                        change.revision > this.publications.currentRevision,
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
              for (const transition of transitions) this.publications.advanceRevision(transition);
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
    this.preservation.moveClosedReferences(checkout, source, destination);
    return true;
  }
  /** Immediately stop admissions; cleanup is owned by the caller outside this model scope. */
  private beginDisposal() {
    if (this.closing) return;
    this.closing = true;
    this.discovery.invalidateActivation();
    this.preservation.cancelPrompt();
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

export type EditorDependencies = { client: EditorClient; clientId?: string };
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
}

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
