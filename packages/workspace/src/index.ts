import { Context, Effect, Layer, Queue, Stream } from 'effect';
import { WorkspaceService, type WorkspaceServiceShape } from '@moonbase/application/services';
import { ApplicationError, emptyRecovery, type CheckoutTarget, type CommandInput, type CommandOutput, type EditorRecovery, type OperationResult, type SaveResult, type WorkspaceCommand, type WorkspaceOperation, type WorkspaceEvent } from '@moonbase/application/client';
import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Store } from './store.ts';
import { matchPath, compareMatches } from './lookup.ts';
import { Directory, identity, makeRunner } from './filesystem.ts';
import { NativeImport } from './native-import.ts';
import { canonical, checkout, document, ensure, fail, hash, identifier, path, recovery, same, textDocument } from './validation.ts';

export type WorkspaceConfiguration = {
  /** Explicit fresh Moonbase namespace, outside approved checkouts. Never a legacy store. */
  dataDirectory: string;
  /** Stable identity supplied by this local process's composition root. */
  hostId: string;
  /** Absolute paths allow the packaged shell to ship the native asset and select system Git. */
  filesystemHelper?: string;
  gitExecutable?: string;
  /** Packaged standalone ripgrep; PATH discovery is a development convenience. */
  ripgrepExecutable?: string;
};
type Approval = { target: CheckoutTarget; identity: string; common: {path: string; identity: string}; gitEntry: {identity: string; pointer: string | null} };
type SaveRecord = { recoveryRevision?: number; baseline?: import('@moonbase/application/client').FileDocument; published?: boolean; temporary?: string; input: CommandInput<'saveFile'>; result?: SaveResult; started: boolean; message?: string };
type OperationRecord = { staging?: string[]; publishedItems?: string[]; input: WorkspaceOperation; result: OperationResult; publicationRevisions: Record<string, number>; acknowledgedBy: string[] };
const key = (clientId: string, id: string) => hash(canonical([clientId, id]));
const affected = (p: string, source: string) => p === source || p.startsWith(source + '/');
const folded = (p: string) => p.normalize('NFC').toLowerCase();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const applicationError = (error: unknown, code: ApplicationError['code'] = 'Unavailable') => error instanceof ApplicationError ? error : new ApplicationError({ code, message: errorText(error) });

/** Scoped resources only; the shared application composition root supplies the runtime. */
export function WorkspaceLive(configuration: WorkspaceConfiguration) {
  const resources = Layer.effect(LocalResources, Effect.acquireRelease(
    Effect.tryPromise({ try: async () => new LocalWorkspace(configuration), catch: error => applicationError(error, 'Persistence') }),
    workspace => Effect.promise(() => workspace.close()),
  ));
  return Layer.merge(
    Layer.effect(WorkspaceService, Effect.map(LocalResources, workspace => workspace.service)),
    Layer.effect(WorkspaceNative, Effect.map(LocalResources, workspace => ({
      capture: (input: { checkout: CheckoutTarget; clientId: string; paths: string[] }) => workspace.effect(signal => workspace.capture(input, signal)),
    }))),
  ).pipe(Layer.provide(resources));
}

/** Main/native adapter only: approved picker/drop paths become short-lived, single-use tokens. */
export class WorkspaceNative extends Context.Service<WorkspaceNative, {
  capture(input: { checkout: CheckoutTarget; clientId: string; paths: string[] }): Effect.Effect<string[], ApplicationError>;
}>()('moonbase/WorkspaceNative') {}
class LocalResources extends Context.Service<LocalResources, LocalWorkspace>()('moonbase/LocalWorkspaceResources') {}

class LocalWorkspace {
  readonly store: Store;
  readonly service: WorkspaceServiceShape;
  readonly children = new Set<ChildProcess>();
  readonly directories = new Map<string, Directory>();
  readonly subscriptions = new Set<() => void>();
  readonly pending = new Set<Promise<unknown>>();
  readonly locks = new Set<{checkoutId: string; paths: string[]; done: Promise<void>}>();
  readonly native = new Map<string, { source: NativeImport; clientId: string; checkoutId: string; expires: ReturnType<typeof setTimeout> }>();
  readonly volatileSaves = new Map<string, SaveRecord>();
  readonly volatileOperations = new Map<string, OperationRecord>();
  readonly run;
  readonly ripgrep: string | undefined;
  closed = false;
  readonly config: WorkspaceConfiguration;
  constructor(config: WorkspaceConfiguration) {
    this.config = config;
    ensure(process.platform === 'darwin', 'Workspace native implementation requires macOS.');
    identifier(config.hostId);
    const helper = config.filesystemHelper ?? fileURLToPath(new URL('../dist/filesystem', import.meta.url));
    ensure(isAbsolute(helper) && isAbsolute(config.gitExecutable ?? '/usr/bin/git'), 'Filesystem/Git executables must be absolute.');
    this.ripgrep = config.ripgrepExecutable ?? (process.env.PATH ?? '').split(':').map(p => join(p, 'rg')).find(p => { try { accessSync(p, constants.X_OK); return isAbsolute(p); } catch { return false; } });
    ensure(this.ripgrep === undefined || isAbsolute(this.ripgrep), 'Ripgrep executable must be absolute.');
    this.store = new Store(config.dataDirectory, config.hostId);
    this.run = makeRunner(helper, this.children);
    const call = <K extends WorkspaceCommand>(fn: (input: CommandInput<K>, signal: AbortSignal) => Promise<CommandOutput<K>>, persistence = false) =>
      (input: CommandInput<K>) => this.effect(async signal => structuredClone(await fn(structuredClone(input), signal)), persistence);
    this.service = {
      openCheckout: call<'openCheckout'>((input, signal) => this.open(input.root, signal)),
      readFile: call<'readFile'>(async (target, signal) => (await this.directory(target.checkout)).read(target.path, signal)),
      saveFile: call<'saveFile'>((input, signal) => this.serial(input.target.checkout.checkoutId, [input.target.path], () => { if (signal.aborted) fail('Cancelled', 'Save cancelled before admission.'); return this.save(input); })),
      listDirectory: call<'listDirectory'>((input, signal) => this.list(input, signal)),
      gitStatus: call<'gitStatus'>((input, signal) => this.status(input.checkout, signal)),
      readComparison: call<'readComparison'>((input, signal) => this.comparison(input, signal)),
      lookupFiles: call<'lookupFiles'>((input, signal) => this.lookup(input, signal)),
      inspectEntries: call<'inspectEntries'>(async (input, signal) => {
        ensure(Array.isArray(input.paths) && input.paths.length > 0 && input.paths.length <= 256, 'Inspect between 1 and 256 entries.');
        const directory = await this.directory(input.checkout);
        return Promise.all(input.paths.map(async p => { path(p); return { target: {checkout: input.checkout, path: p}, ...await directory.entry(p, signal) }; }));
      }),
      mutate: call<'mutate'>((input, signal) => this.serial(input.checkout.checkoutId, this.footprint(input), () => this.mutate(input, signal))),
      operationStatus: call<'operationStatus'>(async input => { identifier(input.clientId); identifier(input.id); await this.recoverEvidence(); return this.operation(key(input.clientId, input.id))?.result ?? null; }, true),
      acknowledgeOperation: call<'acknowledgeOperation'>(async input => {
        identifier(input.clientId); identifier(input.operationClientId); identifier(input.id);
        const id = key(input.operationClientId, input.id), record = this.operation(id);
        if (!record || record.acknowledgedBy.includes(input.clientId)) return;
        const observation = this.store.readRecovery(input.clientId);
        if (input.clientId !== input.operationClientId && !(observation?.state as EditorRecovery | undefined)?.checkouts.some(c => same(c, record.input.checkout))) fail('Unauthorized', 'Observer has not opened this exact checkout.');
        if (record.result.outcome === 'uncertain') fail('Uncertain', 'Uncertain operation evidence cannot be acknowledged away. Inspect the affected paths.');
        if ((observation?.revision ?? 0) <= (record.publicationRevisions[input.clientId] ?? observation?.revision ?? 0)) fail('Persistence', 'Publish reconciled recovery before acknowledging this operation.');
        this.store.put('operations', id, {...record, acknowledgedBy: [...record.acknowledgedBy, input.clientId]}); this.volatileOperations.delete(id);
      }, true),
      loadRecovery: call<'loadRecovery'>(async input => this.load(input.clientId), true),
      persistRecovery: call<'persistRecovery'>(async input => {
        identifier(input.clientId); ensure(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 'Invalid recovery revision.');
        recovery(input.state, input.clientId);
        for (const target of input.state.checkouts) this.approval(target);
        const state = structuredClone(input.state);
        const retained = this.store.readRecovery(input.clientId)?.state as EditorRecovery | undefined;
        for (const record of this.operations().filter(r => r.result.outcome === 'uncertain')) {
          for (const draft of retained?.drafts ?? []) if (same(draft.target.checkout, record.input.checkout) && record.input.sources.some(s => affected(draft.target.path, s.target.path)))
            if (!state.drafts.some(d => same(d.target, draft.target))) fail('Persistence', 'An uncertain operation still owns this recovery draft. Inspect/reconcile the original paths before discarding it.');
        }
        return {revision: this.store.persist(input.clientId, input.expectedRevision, state)};
      }, true),
      watch: input => this.watch(input),
    };
  }
  effect<A>(fn: (signal: AbortSignal) => Promise<A>, persistence = false): Effect.Effect<A, ApplicationError> {
    return Effect.tryPromise({ try: signal => {
      if (this.closed) return Promise.reject(new ApplicationError({code: 'Unavailable', message: 'Workspace scope is closed.'}));
      const task = Promise.resolve().then(() => fn(signal)); this.pending.add(task);
      void task.finally(() => this.pending.delete(task)).catch(() => {}); return task;
    }, catch: error => applicationError(error, persistence ? 'Persistence' : 'Unavailable') });
  }
  footprint(input: WorkspaceOperation) {
    const sources = input.sources.map(s => s.target.path);
    if (input.destination === undefined) return sources;
    const names = sources.length ? sources.map(p => basename(p)) : (input.nativeReferences ?? []).map(token => this.native.get(token)?.source.source ?? '');
    return [...sources, ...(names.length > 1 ? names.map(name => name ? join(input.destination!, name) : input.destination!) : [input.destination])];
  }
  overlaps(a: string[], b: string[]) { return a.some(p => b.some(q => p === '' || q === '' || affected(p, q) || affected(q, p))); }
  active(checkoutId: string) { return [...this.locks].some(lock => lock.checkoutId === checkoutId); }
  async serial<A>(checkoutId: string, paths: string[], fn: () => Promise<A>): Promise<A> {
    const previous = [...this.locks].filter(lock => lock.checkoutId === checkoutId && this.overlaps(paths, lock.paths));
    let release!: () => void;
    const lock = {checkoutId, paths, done: new Promise<void>(resolve => { release = resolve; })};
    this.locks.add(lock);
    try { await Promise.all(previous.map(p => p.done)); if (this.closed) fail('Unavailable', 'Workspace scope is closed.'); return await fn(); }
    finally { this.locks.delete(lock); release(); }
  }
  async close() {
    this.closed = true;
    for (const stop of this.subscriptions) stop();
    for (const token of [...this.native.keys()]) this.releaseNative(token);
    const exits = [...this.children].map(child => once(child, 'close').catch(() => {}));
    for (const child of this.children) child.kill('SIGKILL');
    await Promise.allSettled(exits); await Promise.allSettled([...this.pending]);
    for (const stop of this.subscriptions) stop();
    for (const directory of this.directories.values()) directory.close();
    this.store.close();
  }
  protected(root: string) {
    const inside = (a: string, b: string) => { const p = relative(a, b); return !p || (p !== '..' && !p.startsWith('../') && !isAbsolute(p)); };
    ensure(!inside(root, this.store.directory) && !inside(this.store.directory, root), 'Workspace state and file operations must remain outside one another.');
  }
  approval(target: CheckoutTarget) {
    checkout(target);
    if (target.hostId !== this.config.hostId) fail('Unauthorized', 'Remote targets are not local filesystem authority.');
    const stored = this.store.get<Approval>('approvals', target.checkoutId);
    if (!stored || !same(stored.target, target)) fail('Unauthorized', 'Exact checkout identity is not approved. Choose the checkout through the native picker.');
    return stored!;
  }
  async directory(target: CheckoutTarget) {
    const approved = this.approval(target);
    let directory = this.directories.get(target.checkoutId);
    if (!directory) {
      ensure(this.directories.size < 128, 'Open checkout resource limit reached. Restart after preserving recovery to release retained checkout descriptors.');
      directory = new Directory(target.root, approved.identity, this.run, this.config.gitExecutable ?? '/usr/bin/git');
      this.directories.set(target.checkoutId, directory);
    }
    directory.check();
    ensure(same(this.gitEntry(target.root), approved.gitEntry), 'Checkout Git metadata identity changed. Restore the original repository.');
    const fd = openSync(approved.common.path, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    try { ensure(identity(fstatSync(fd)) === approved.common.identity, 'Repository common directory identity changed.'); } finally { closeSync(fd); }
    return directory;
  }
  gitEntry(root: string) {
    const fd = openSync(join(root, '.git'), constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
    try {
      const info = fstatSync(fd); ensure(info.isDirectory() || info.isFile() && info.size < 4096 && info.nlink === 1, 'Invalid checkout Git metadata.');
      return {identity: identity(info), pointer: info.isFile() ? readFileSync(fd, 'utf8') : null};
    } finally { closeSync(fd); }
  }
  policy(target: CheckoutTarget) {
    const common = this.approval(target).common;
    for (const p of ['info', 'info/exclude']) {
      let fd: number;
      try { fd = openSync(join(common.path, p), constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      try { const info = fstatSync(fd); ensure(p === 'info' ? info.isDirectory() : info.isFile(), 'Invalid repository ignore policy.'); } finally { closeSync(fd); }
    }
  }
  async open(root: string, signal: AbortSignal) {
    ensure(typeof root === 'string' && isAbsolute(root) && !root.includes('\0'), 'Choose an absolute checkout root through the native picker.');
    root = realpathSync(root); this.protected(root);
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    const id = identity(fstatSync(fd)); closeSync(fd);
    const gitEntry = this.gitEntry(root);
    const directory = new Directory(root, id, this.run, this.config.gitExecutable ?? '/usr/bin/git');
    try {
      const top = (await directory.git(['rev-parse', '--show-toplevel'], undefined, signal)).toString().trim();
      ensure(realpathSync(top) === root, 'Choose the repository checkout root.');
      const common = realpathSync(resolve(root, (await directory.git(['rev-parse', '--git-common-dir'], undefined, signal)).toString().trim()));
      const commonFd = openSync(common, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
      const commonIdentity = identity(fstatSync(commonFd));
      const projectId = hash(canonical([this.config.hostId, common, commonIdentity])); closeSync(commonFd);
      const previous = this.store.all<Approval>('approvals').find(a => a.target.root === root);
      if (previous) { ensure(previous.identity === id && previous.target.projectId === projectId, 'Checkout or repository identity changed. Restore the original directory.'); return previous.target; }
      const branch = await this.branch(directory, signal);
      const target = {hostId: this.config.hostId, checkoutId: hash(canonical([this.config.hostId, root, id])), projectId, root, branch};
      this.store.put('approvals', target.checkoutId, { target, identity: id, common: {path: common, identity: commonIdentity}, gitEntry }); return target;
    } finally { directory.close(); }
  }
  async branch(directory: Directory, signal?: AbortSignal) {
    try { return (await directory.git(['symbolic-ref', '--short', 'HEAD'], undefined, signal)).toString().trim(); }
    catch { return (await directory.git(['rev-parse', '--short', 'HEAD'], undefined, signal)).toString().trim() + ' (detached)'; }
  }
  saveRecord(id: string) { return this.volatileSaves.get(id) ?? this.store.get<SaveRecord>('saves', id); }
  operation(id: string) { return this.volatileOperations.get(id) ?? this.store.get<OperationRecord>('operations', id); }
  operations() {
    const records = new Map(this.store.all<OperationRecord>('operations').map(r => [key(r.input.clientId, r.input.id), r]));
    for (const [id, record] of this.volatileOperations) records.set(id, record); return [...records.values()];
  }
  assertSettled(target: CheckoutTarget, paths: string[], clientId: string) {
    if (this.operations().some(r => r.input.checkout.checkoutId === target.checkoutId && this.overlaps(paths, this.footprint(r.input)) && (!r.acknowledgedBy.includes(clientId) || r.result.outcome === 'uncertain')) || this.store.all<SaveRecord>('saves').some(r => r.input.target.checkout.checkoutId === target.checkoutId && this.overlaps(paths, [r.input.target.path]) && !r.result))
      fail('Uncertain', 'An operation awaits recovery publication or inspection. Query its status; do not repeat the mutation.');
  }
  async save(input: CommandInput<'saveFile'>): Promise<SaveResult> {
    identifier(input.clientId); identifier(input.requestId); path(input.target.path); this.approval(input.target.checkout);
    const proposed = textDocument(input.text); ensure(typeof input.expectedVersion === 'string' && /^[a-f0-9]{64}$/.test(input.expectedVersion), 'Invalid expected content version.');
    const id = key(input.clientId, input.requestId), previous = this.saveRecord(id);
    if (previous) {
      if (!same(previous.input, input)) fail('Conflict', 'Save request ID already belongs to a different payload or target.');
      if (previous.result) { if (this.volatileSaves.has(id)) this.publishSave(id, previous); return previous.result; }
      return fail('Uncertain', 'Interrupted save retained its intent. Inspect disk and recovered draft before a new deliberate save.');
    }
    this.assertSettled(input.target.checkout, [input.target.path], input.clientId);
    const directory = await this.directory(input.target.checkout), disk = await directory.read(input.target.path);
    if (disk.version !== input.expectedVersion) {
      const result = {kind: 'conflict', disk} as const;
      this.store.put('saves', id, {input, result, started: false}); return result;
    }
    const temporary = join(dirname(input.target.path), '.moonbase-save-' + randomUUID());
    const record: SaveRecord = {input, started: true, temporary, baseline: disk, recoveryRevision: this.store.readRecovery(input.clientId)?.revision ?? 0};
    this.store.put('saves', id, record);
    try {
      const stagingIdentity = (await directory.io(['stage', input.target.path, temporary], input.text)).toString();
      const current = await directory.read(input.target.path);
      if (current.version !== input.expectedVersion) record.result = {kind: 'conflict', disk: current};
      else { await directory.io(['replace', input.target.path, temporary, stagingIdentity]); record.result = {kind: 'saved', disk: proposed, recoveryChanges: []}; }
      try { this.publishSave(id, record); }
      catch (error) {
        if (record.result.kind === 'saved') record.result = {...record.result, persistencePending: true, message: 'Saved to disk; durable request publication failed: ' + errorText(error)};
        this.volatileSaves.set(id, record);
      }
      return record.result;
    } catch (error) {
      record.message = errorText(error); this.volatileSaves.set(id, record);
      return fail('Uncertain', 'Save may have changed disk. Request retained; inspect disk and recovery. ' + errorText(error));
    }
  }
  async capture(input: { checkout: CheckoutTarget; clientId: string; paths: string[] }, signal: AbortSignal) {
    identifier(input.clientId); const directory = await this.directory(input.checkout);
    ensure(Array.isArray(input.paths) && input.paths.length > 0 && input.paths.length <= 128 && this.native.size + input.paths.length <= 256, 'Native import selection limit reached.');
    const references: string[] = [];
    try {
      for (const p of input.paths) {
        const source = new NativeImport(p, p => this.protected(p));
        try {
          await directory.io(['import-check', source.path, source.parents], undefined, signal, [source.fd]);
          const token = randomUUID();
          const expires = setTimeout(() => this.releaseNative(token), 5 * 60 * 1000); expires.unref();
          this.native.set(token, {source, clientId: input.clientId, checkoutId: input.checkout.checkoutId, expires}); references.push(token);
        } catch (error) { source.close(); throw error; }
      }
      return references;
    } catch (error) { references.forEach(token => this.releaseNative(token)); throw error; }
  }
  releaseNative(token: string) { const entry = this.native.get(token); if (entry) { clearTimeout(entry.expires); entry.source.close(); this.native.delete(token); } }
  async mutate(input: WorkspaceOperation, signal: AbortSignal): Promise<OperationResult> {
    identifier(input.clientId); identifier(input.id); this.approval(input.checkout);
    ensure(['create-file', 'create-directory', 'move', 'copy', 'trash', 'import'].includes(input.kind) && Array.isArray(input.sources) && input.sources.length <= 128 && (input.replacements === undefined || Array.isArray(input.replacements)), 'Invalid file operation.');
    ensure(input.text === undefined || input.kind === 'create-file', 'Text belongs only to file creation.');
    if (input.text !== undefined) textDocument(input.text);
    const id = key(input.clientId, input.id), previous = this.operation(id);
    if (previous) { if (!same(previous.input, input)) fail('Conflict', 'Operation ID already belongs to another payload/client/checkout.'); if (this.volatileOperations.has(id)) this.publishOperation(id, previous); return previous.result; }
    this.assertSettled(input.checkout, this.footprint(input), input.clientId);
    if (signal.aborted) fail('Cancelled', 'Operation cancelled before admission.');
    const directory = await this.directory(input.checkout);
    const create = input.kind.startsWith('create-');
    const importing = input.kind === 'import';
    const tokens = input.nativeReferences ?? [];
    ensure(Array.isArray(tokens) && tokens.length <= 128 && new Set(tokens).size === tokens.length, 'Invalid native references.');
    ensure(importing ? input.sources.length === 0 && tokens.length > 0 : tokens.length === 0 && (create ? input.sources.length === 0 : input.sources.length > 0), 'Invalid operation source selection.');
    const sources: {path: string; identity: string; directory: boolean; native?: NativeImport}[] = [];
    for (const entry of input.sources) {
      ensure(entry && same(entry.target.checkout, input.checkout), 'Source target belongs to another checkout.'); path(entry.target.path);
      const actual = await directory.entry(entry.target.path, signal);
      if (!same(actual, {identity: entry.identity, directory: entry.directory})) fail('Conflict', 'Source changed. Capture a fresh selection before continuing.');
      ensure(!sources.some(s => affected(entry.target.path, s.path) || affected(s.path, entry.target.path)), 'Overlapping sources are not one selection.');
      sources.push({path: entry.target.path, ...actual});
    }
    for (const token of tokens) {
      const ref = this.native.get(token);
      if (!ref || ref.clientId !== input.clientId || ref.checkoutId !== input.checkout.checkoutId) fail('Unauthorized', 'Native reference expired, used or belongs to another client/checkout.');
      const captured = ref!; captured.source.validate(); sources.push({path: captured.source.source, identity: captured.source.identity, directory: captured.source.directory, native: captured.source});
    }
    if (create) sources.push({path: '', identity: '', directory: input.kind === 'create-directory'});
    if (input.kind !== 'trash') path(input.destination, sources.length > 1);
    const destinations = sources.map(source => input.kind === 'trash' ? undefined : sources.length === 1 ? input.destination! : join(input.destination!, basename(source.path)));
    if (sources.length > 1 && input.kind !== 'trash') ensure((await directory.entry(input.destination!, signal)).directory, 'Batch destination must be an existing folder.');
    ensure(new Set(destinations.filter(Boolean).map(p => folded(p!))).size === destinations.filter(Boolean).length, 'Selection has colliding destination names.');
    const replacements = input.replacements ?? [];
    ensure(replacements.length <= sources.length, 'Invalid replacement selection.');
    for (const replacement of replacements) {
      ensure(replacement && same(replacement.target.checkout, input.checkout) && destinations.includes(replacement.target.path), 'Replacement must name the exact captured destination.');
      const actual = await directory.entry(replacement.target.path, signal);
      if (!same(actual, {identity: replacement.identity, directory: replacement.directory})) fail('Conflict', 'Replacement changed. Confirm a freshly captured destination.');
    }
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i], destination = destinations[i];
      if (!destination) continue;
      path(destination); await directory.destination(destination);
      if (!source.native && !create) ensure(!affected(folded(destination), folded(source.path)) || (input.kind === 'move' && destination !== source.path && folded(destination) === folded(source.path)), 'Choose a destination outside the source.');
      ensure(!sources.some(s => s.path !== source.path && affected(folded(destination), folded(s.path))), 'Destination overlaps another selected source.');
      for (const row of this.store.db.prepare('SELECT client, body FROM recovery').all()) {
        const state = JSON.parse(row.body as string) as EditorRecovery;
        ensure(!state.drafts.some(d => d.target.checkout.checkoutId === input.checkout.checkoutId && affected(folded(d.target.path), folded(destination)) && (source.native || !affected(d.target.path, source.path))), 'Destination has recovery drafts. Preserve them before replacement.');
      }
    }
    const staging = destinations.map(destination => destination && ['copy', 'import'].includes(input.kind) ? join(dirname(destination), '.moonbase-copy-' + randomUUID()) : '');
    const publicationRevisions: Record<string, number> = {[input.clientId]: this.store.readRecovery(input.clientId)?.revision ?? 0};
    for (const row of this.store.db.prepare('SELECT client, revision, body FROM recovery').all()) if ((JSON.parse(row.body as string) as EditorRecovery).checkouts.some(c => same(c, input.checkout))) publicationRevisions[row.client as string] = Number(row.revision);
    const record: OperationRecord = { input, staging, publicationRevisions, acknowledgedBy: [],
      result: {id: input.id, clientId: input.clientId, recoveryChanges: [], checkout: input.checkout, kind: input.kind, outcome: 'uncertain', items: [], message: 'Admitted operation. Interrupted items must be inspected, never repeated automatically.'} };
    // The complete immutable selection is durable before the first native mutation.
    this.store.put('operations', id, record);
    try {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i], destination = destinations[i];
        if (signal.aborted) { record.result.items.push({source: source.path, destination, outcome: 'failed', message: 'Cancelled before this item started.'}); continue; }
        const replacement = replacements.find(r => r.target.path === destination);
        try {
          if (replacement) {
            const trashLocation = (await directory.io(['trash', replacement.target.path, '-', replacement.identity], undefined, signal)).toString();
            record.result.items.push({source: replacement.target.path, outcome: 'completed', message: 'Explicit replacement moved to macOS Trash: ' + trashLocation});
            this.store.put('operations', id, record);
          }
          if (create) {
            await directory.io(['create', dirname(destination!) === '.' ? '.' : dirname(destination!), basename(destination!), source.directory ? 'folder' : 'file', await directory.destination(destination!)], input.text, signal);
          } else if (input.kind === 'move') {
            await directory.io(['move', source.path, destination!, source.identity], undefined, signal);
            ensure((await directory.entry(destination!)).identity === source.identity, 'Move destination identity changed after native success.');
          } else if (input.kind === 'trash') {
            const trashPath = (await directory.io(['trash', source.path, '-', source.identity], undefined, signal)).toString();
            record.result.items.push({source: source.path, outcome: 'completed', message: trashPath ? 'macOS Trash: ' + trashPath : 'Moved to macOS Trash.'});
            this.store.put('operations', id, record); continue;
          } else {
            const temporary = staging[i];
            await directory.io([importing ? 'import' : 'copy', source.path, destination!, source.identity, temporary, await directory.destination(destination!), ...(source.native ? [source.native.path, source.native.parents, input.checkout.root] : [])], undefined, signal, source.native ? [source.native.fd] : []);
          }
          record.result.items.push({source: source.path, destination, outcome: 'completed'});
        } catch (error) {
          let outcome: 'failed' | 'uncertain' = 'uncertain';
          // A preflight error is known only while the original object still occupies its exact path.
          if (!(error as {uncertain?: boolean}).uncertain && !create && !['copy', 'import'].includes(input.kind) && !replacement) {
            try { if ((await directory.entry(source.path)).identity === source.identity) outcome = 'failed'; } catch { /* Keep uncertain evidence. */ }
          }
          record.result.items.push({source: source.path, destination, outcome, message: errorText(error)});
        }
        try { this.store.put('operations', id, record); }
        catch (error) { record.result.message = 'Filesystem outcome retained in memory; durable publication failed: ' + errorText(error); this.volatileOperations.set(id, record); return record.result; }
        if (record.result.items.some(item => item.outcome === 'uncertain')) break;
      }
      record.result.outcome = record.result.items.some(i => i.outcome === 'uncertain') || record.result.items.length < sources.length ? 'uncertain' : record.result.items.every(i => i.outcome === 'completed') ? 'completed' : 'failed';
      if (record.result.outcome === 'uncertain') record.result.message = 'Inspect original, destination, Finder Trash and staging: ' + staging.filter(Boolean).join(', ') + '. Drafts and journal retained; no automatic retry.'; else delete record.result.message;
      try { this.publishOperation(id, record); } catch (error) { record.result.message = 'Filesystem results known; persistence pending: ' + errorText(error); this.volatileOperations.set(id, record); }
      return record.result;
    } finally { tokens.forEach(token => this.releaseNative(token)); }
  }
  reconcile(state: EditorRecovery, records: OperationRecord[]) {
    for (const record of records) {
      if (!state.checkouts.some(c => same(c, record.input.checkout))) continue;
      for (const item of record.result.items) {
        if (item.outcome !== 'completed') continue;
        const kind = record.input.kind;
        if (!['move', 'copy', 'trash'].includes(kind)) continue;
        if (kind !== 'trash' && !item.destination) continue;
        const matches = (target: {checkout: CheckoutTarget; path: string}) => same(target.checkout, record.input.checkout) && affected(target.path, item.source);
        const move = (p: string) => item.destination! + p.slice(item.source.length);
        if (kind === 'copy') {
          for (const draft of [...state.drafts]) if (matches(draft.target) && !state.drafts.some(d => same(d.target.checkout, draft.target.checkout) && d.target.path === move(draft.target.path)))
            state.drafts.push({...draft, target: {...draft.target, path: move(draft.target.path)}});
          continue;
        }
        // Trash never proves permission to discard another client's dirty work.
        if (kind === 'move') {
          state.drafts = state.drafts.map(d => matches(d.target) ? {...d, target: {...d.target, path: move(d.target.path)}} : d);
          state.recentFiles = state.recentFiles.map(t => matches(t) ? {...t, path: move(t.path)} : t);
          const view = state.views[record.input.checkout.checkoutId];
          if (view) {
            const rename = (p: string) => affected(p, item.source) ? move(p) : p;
            view.openFiles = [...new Set(view.openFiles.map(rename))]; view.active = rename(view.active); if (view.preview) view.preview = rename(view.preview);
            view.fileViews = Object.fromEntries(Object.entries(view.fileViews).map(([p, mode]) => [rename(p), mode]));
            view.positions = Object.fromEntries(Object.entries(view.positions).map(([p, positions]) => [rename(p), positions]));
            view.tree.expanded = view.tree.expanded.map(rename); view.tree.selected = view.tree.selected.map(rename); view.tree.focus = rename(view.tree.focus);
          }
        }
      }
    }
  }
  publishOperation(id: string, record: OperationRecord) {
    const fresh = record.result.items.filter(item => item.outcome === 'completed' && !(record.publishedItems ?? []).includes(canonical(item)));
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const changes: OperationResult['recoveryChanges'] = [];
      const publicationRevisions = {...record.publicationRevisions};
      for (const row of this.store.db.prepare('SELECT client, revision, body FROM recovery').all()) {
        const state = JSON.parse(row.body as string) as EditorRecovery;
        if (row.client !== record.input.clientId && !state.checkouts.some(c => same(c, record.input.checkout))) continue;
        let revision = Number(row.revision);
        if (fresh.length) this.reconcile(state, [{...record, result: {...record.result, items: fresh}}]);
        if (JSON.stringify(state) !== row.body) {
          this.store.db.prepare('UPDATE recovery SET revision=revision+1, body=? WHERE client=?').run(JSON.stringify(state), row.client as string);
          changes.push({clientId: row.client as string, previousRevision: revision, revision: revision + 1}); revision++;
        }
        publicationRevisions[row.client as string] = revision;
      }
      const updated = {...record, publicationRevisions, publishedItems: [...(record.publishedItems ?? []), ...fresh.map(canonical)], result: {...record.result, recoveryChanges: [...record.result.recoveryChanges, ...changes]}};
      this.store.put('operations', id, updated); this.store.db.exec('COMMIT'); Object.assign(record, updated); this.volatileOperations.delete(id);
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  publishSave(id: string, record: SaveRecord, restore = false) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const changes: OperationResult['recoveryChanges'] = [];
      if (!record.published) {
        const stored = this.store.readRecovery(record.input.clientId);
        const state = (stored?.state ?? emptyRecovery(record.input.clientId)) as EditorRecovery, before = JSON.stringify(state);
        if (restore && record.baseline && (stored?.revision ?? 0) === record.recoveryRevision) {
          if (!state.checkouts.some(c => same(c, record.input.target.checkout))) state.checkouts.push(record.input.target.checkout);
          const existing = state.drafts.find(d => same(d.target, record.input.target));
          if (existing) existing.text = record.input.text;
          else state.drafts.push({target: record.input.target, text: record.input.text, disk: record.baseline});
        }
        if (record.result?.kind === 'saved') for (const draft of state.drafts) if (same(draft.target, record.input.target)) draft.disk = record.result.disk;
        if (JSON.stringify(state) !== before) {
          const previousRevision = stored?.revision ?? 0;
          this.store.db.prepare('INSERT INTO recovery VALUES(?,?,?) ON CONFLICT(client) DO UPDATE SET revision=excluded.revision, body=excluded.body').run(record.input.clientId, previousRevision + 1, JSON.stringify(state));
          changes.push({clientId: record.input.clientId, previousRevision, revision: previousRevision + 1});
        }
      }
      const result = record.result?.kind === 'saved' ? {kind: 'saved' as const, disk: record.result.disk, recoveryChanges: [...record.result.recoveryChanges, ...changes]} : record.result;
      const updated = {...record, result, published: !!result};
      this.store.put('saves', id, updated); this.store.db.exec('COMMIT'); Object.assign(record, updated); this.volatileSaves.delete(id);
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  async recoverEvidence() {
    for (const [id, record] of this.volatileSaves) if (record.result) this.publishSave(id, record);
    for (const record of this.operations()) {
      if (this.active(record.input.checkout.checkoutId)) continue;
      const items = record.result.items.filter(item => !item.message?.startsWith('Explicit replacement'));
      if (items.length === (record.input.sources.length || record.input.nativeReferences?.length || 1) && items.every(item => item.outcome !== 'uncertain')) {
        const outcome = items.every(item => item.outcome === 'completed') ? 'completed' : 'failed';
        const id = key(record.input.clientId, record.input.id);
        if (record.result.outcome !== outcome || record.result.items.some(item => item.outcome === 'completed' && !(record.publishedItems ?? []).includes(canonical(item))) || this.volatileOperations.has(id)) { record.result.outcome = outcome; this.publishOperation(id, record); }
      }
      if (record.result.outcome !== 'uncertain' || this.active(record.input.checkout.checkoutId)) continue;
      const kind = record.input.kind;
      if (kind !== 'move') continue;
      let directory: Directory;
      try { directory = await this.directory(record.input.checkout); } catch { continue; }
      for (const source of record.input.sources) {
        if (record.result.items.some(i => i.source === source.target.path && i.destination && i.outcome === 'completed')) continue;
        const destination = record.input.sources.length === 1 ? record.input.destination! : join(record.input.destination!, basename(source.target.path));
        const inspect = async (p: string) => { try { return (await directory.entry(p)).identity; } catch { return null; } };
        const from = await inspect(source.target.path), to = await inspect(destination);
        if (to === source.identity && from !== source.identity) {
          record.result.items = record.result.items.filter(i => i.source !== source.target.path || !i.destination);
          record.result.items.push({source: source.target.path, destination, outcome: 'completed', message: 'Recovered exact moved object identity; no mutation repeated.'});
        } else if (from === source.identity && to !== source.identity && !record.input.replacements?.length) {
          record.result.items = record.result.items.filter(i => i.source !== source.target.path);
          record.result.items.push({source: source.target.path, destination, outcome: 'failed', message: 'Original object remains at source; no mutation repeated.'});
        }
      }
      if (record.result.items.length >= record.input.sources.length && !record.result.items.some(i => i.outcome === 'uncertain')) record.result.outcome = record.result.items.every(i => i.outcome === 'completed') ? 'completed' : 'failed';
      this.publishOperation(key(record.input.clientId, record.input.id), record);
    }
    for (const record of this.store.all<SaveRecord>('saves')) {
      if (record.result || this.active(record.input.target.checkout.checkoutId)) continue;
      try {
        const disk = await (await this.directory(record.input.target.checkout)).read(record.input.target.path);
        if (disk.version === textDocument(record.input.text).version) record.result = {kind: 'saved', disk, recoveryChanges: []};
        else if (disk.version === record.input.expectedVersion) record.result = {kind: 'conflict', disk};
        else continue;
        this.publishSave(key(record.input.clientId, record.input.requestId), record, true);
      } catch { /* Unavailable/changed path retains save intent. */ }
    }
  }
  async load(clientId: string) {
    identifier(clientId); await this.recoverEvidence();
    const stored = this.store.readRecovery(clientId), state = (stored?.state ?? emptyRecovery(clientId)) as EditorRecovery;
    recovery(state, clientId); const errors: string[] = [];
    for (const target of state.checkouts) { try { await this.directory(target); } catch (error) { errors.push(target.root + ': ' + errorText(error)); } }
    const relevant = this.operations().filter(r => !r.acknowledgedBy.includes(clientId) && (r.input.clientId === clientId || state.checkouts.some(c => same(c, r.input.checkout))));
    for (const record of relevant) if (record.publicationRevisions[clientId] === undefined) { record.publicationRevisions[clientId] = stored?.revision ?? 0; this.store.put('operations', key(record.input.clientId, record.input.id), record); }
    const operations = relevant.map(r => r.result);
    for (const operation of operations) if (operation.outcome === 'uncertain') errors.push('Uncertain operation ' + operation.id + ': ' + (operation.message ?? 'inspect original, destination, staging and Finder Trash; drafts retained.'));
    for (const record of this.store.all<SaveRecord>('saves')) if (record.input.clientId === clientId && !record.result) {
      errors.push('Uncertain save ' + record.input.requestId + ' for ' + record.input.target.path + ': inspect disk and staging ' + record.temporary + '; saved draft and intent retained.');
      if (record.baseline && !state.drafts.some(d => same(d.target, record.input.target))) {
        if (!state.checkouts.some(c => same(c, record.input.target.checkout))) state.checkouts.push(record.input.target.checkout);
        state.drafts.push({target: record.input.target, text: record.input.text, disk: record.baseline});
      }
    }
    return {revision: stored?.revision ?? 0, state, errors, operations};
  }
  async list(input: CommandInput<'listDirectory'>, signal: AbortSignal) {
    path(input.path, true); const directory = await this.directory(input.checkout);
    const entries = (await directory.io(['list', input.path || '.'], undefined, signal)).toString().split('\0').filter(Boolean).slice(0, 20000).map(row => ({path: input.path ? input.path + '/' + row.slice(1) : row.slice(1), directory: row[0] === 'd', ignored: false}));
    let error: string | undefined;
    try {
      this.policy(input.checkout);
      const output = await directory.io(['lookup', this.config.gitExecutable ?? '/usr/bin/git', '-c', 'core.excludesFile=/dev/null', 'check-ignore', '-z', '--stdin'], entries.map(e => e.path).join('\0') + (entries.length ? '\0' : ''), signal).catch(error => { if (error.status === 1) return Buffer.alloc(0); throw error; });
      const ignored = new Set(output.toString().split('\0')); entries.forEach(e => { e.ignored = ignored.has(e.path); });
    } catch (failure) { error = 'Git ignore policy unavailable; all entries shown. ' + errorText(failure); }
    return {entries: entries.filter(e => !input.hideIgnored || !e.ignored).sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path)), partial: entries.length === 20000 || !!error, error};
  }
  async status(target: CheckoutTarget, signal: AbortSignal) {
    const directory = await this.directory(target);
    try {
      const records = (await directory.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], undefined, signal)).toString().split('\0').filter(Boolean);
      const changes: CommandOutput<'gitStatus'>['changes'] = [];
      for (const row of records) {
        const p = row.slice(3); path(p);
        if (row.startsWith('??')) changes.push({path: p, area: 'untracked'});
        else { if (row[0] !== ' ') changes.push({path: p, area: 'staged'}); if (row[1] !== ' ') changes.push({path: p, area: 'unstaged'}); }
      }
      return {branch: await this.branch(directory, signal), changes};
    } catch (error) { return {branch: target.branch, changes: [], error: 'Git status unavailable. ' + errorText(error)}; }
  }
  async comparison(input: CommandInput<'readComparison'>, signal: AbortSignal) {
    path(input.target.path); ensure(['staged', 'unstaged', 'untracked'].includes(input.area), 'Invalid comparison area.');
    const directory = await this.directory(input.target.checkout), p = input.target.path;
    let working = null;
    try { working = await directory.read(p, signal); } catch (error) { if (!errorText(error).includes('No such file')) throw error; }
    try {
      let original = '';
      if (input.area === 'staged') {
        const exists = await directory.git(['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, signal).then(() => true).catch(error => { if (error.status === 1) return false; throw error; });
        const entries = exists ? (await directory.git(['ls-tree', '-z', 'HEAD', '--', p], undefined, signal)).toString() : '';
        if (entries) original = document(await directory.git(['cat-file', 'blob', entries.split(' ')[2].split('\t')[0]], undefined, signal)).text;
      } else if (input.area === 'unstaged') {
        const entries = (await directory.git(['ls-files', '--stage', '-z', '--', p], undefined, signal)).toString();
        if (entries) {
          const rows = entries.split('\0').filter(Boolean); const stage = rows.find(row => row.split(' ')[2]?.startsWith('0\t'));
          if (!stage) fail('Unavailable', 'Index contains unresolved merge stages; no single index baseline is available.');
          original = document(await directory.git(['cat-file', 'blob', stage!.split(' ')[1]], undefined, signal)).text;
        }
      }
      return {original, working, title: input.area === 'staged' ? 'HEAD ↔ working buffer' : input.area === 'unstaged' ? 'Index ↔ working buffer' : 'Untracked file'};
    } catch (error) { return {original: '', working, title: input.area, error: 'Git comparison unavailable. ' + errorText(error)}; }
  }
  async lookup(input: CommandInput<'lookupFiles'>, signal: AbortSignal) {
    ensure(typeof input.query === 'string' && input.query.length <= 256 && !input.query.includes('\0') && (input.limit === undefined || Number.isInteger(input.limit) && input.limit > 0 && input.limit <= 100), 'Invalid lookup query/limit.');
    const directory = await this.directory(input.checkout), limit = input.limit ?? 100;
    const supplied = input.history ?? [];
    ensure(Array.isArray(supplied) && supplied.length <= 1000 && supplied.reduce((n, p) => n + (typeof p === 'string' ? p.length : 1000000), 0) <= 256 * 1024, 'Lookup history exceeds its limit.');
    supplied.forEach(p => path(p));
    const excluded = (p: string) => ['.git', '.svn', '.hg', '.jj', '.DS_Store', 'Thumbs.db', 'node_modules', 'bower_components'].includes(p) || p.endsWith('.code-search');
    let cells = 0, partial = false;
    const rank = (paths: string[], history: boolean) => {
      const matches = [];
      for (const p of new Set(paths)) {
        if (history ? excluded(basename(p)) : p.split('/').some(excluded)) continue;
        cells += p.length * Math.max(input.query.length, 1);
        if (cells > 16 * 1024 * 1024) { partial = true; break; }
        const match = matchPath(p, input.query); if (match) matches.push(match);
      }
      matches.sort(compareMatches); if (matches.length > limit) partial = true; return matches.slice(0, limit);
    };
    const history = rank(supplied, true);
    if (!input.query.trim()) return {matches: [], history, partial};
    try {
      this.policy(input.checkout);
      if (!this.ripgrep) fail('Unavailable', 'Standalone ripgrep is unavailable. Supply the packaged ripgrepExecutable asset.');
      const args = ['--files', '--hidden', '--null', '--no-config', '--no-ignore-parent', '--no-ignore-global', '--threads', '1'];
      for (const name of ['.git', '.svn', '.hg', '.jj', '.DS_Store', 'Thumbs.db', 'node_modules', 'bower_components', '*.code-search']) args.push('--glob', '!**/' + name);
      let enumerationError: string | undefined;
      const bytes = await directory.io(['lookup', this.ripgrep!, ...args, '.'], undefined, signal).catch(error => {
        const output = (error as {output?: Buffer}).output;
        if (output?.length && output.lastIndexOf(0) >= 0) { partial = true; enumerationError = errorText(error); return output.subarray(0, output.lastIndexOf(0) + 1); }
        if (error.status === 1 && !error.stderr) return Buffer.alloc(0);
        throw error;
      });
      const candidates = [...new Set(bytes.toString().split('\0').filter(Boolean).map(p => p.replace(/^\.\//, '')))];
      if (candidates.length > 20000) partial = true;
      const eligible: string[] = [];
      for (const p of candidates.slice(0, 20000)) {
        if (signal.aborted) fail('Cancelled', 'Lookup cancelled.');
        path(p);
        try { if (!(await directory.entry(p, signal)).directory) eligible.push(p); } catch { partial = true; }
        if (eligible.length % 32 === 0) await new Promise<void>(done => setImmediate(done));
      }
      // Exact entered paths have a scoped no-follow exception to discovery ignore/exclusions.
      try { path(input.query); if (!(await directory.entry(input.query, signal)).directory && !eligible.includes(input.query)) eligible.unshift(input.query); } catch { /* Ordinary fuzzy queries need not be exact paths. */ }
      const recent = new Set(history.map(match => match.path));
      const exact = eligible[0] === input.query ? matchPath(input.query, input.query) : null;
      const matches = rank(eligible.filter(p => !recent.has(p)), false);
      if (exact && !recent.has(exact.path) && !matches.some(m => m.path === exact.path)) { matches.unshift(exact); if (matches.length > limit) { matches.pop(); partial = true; } }
      return {matches, history, partial, ...(partial ? {error: enumerationError ?? 'Discovery or ranking capped; refine query.'} : {})};
    } catch (error) { return {matches: [], history, partial: true, error: 'Discovery or ignore policy unavailable. ' + errorText(error)}; }
  }
  watch(input: {checkout: CheckoutTarget; paths: string[]}) {
    const self = this;
    return Stream.unwrap(Effect.gen(function* () {
      const queue = yield* Queue.sliding<WorkspaceEvent>(1);
      yield* Effect.acquireRelease(self.effect(async () => {
      ensure(Array.isArray(input.paths) && input.paths.length > 0 && input.paths.length <= 128 && self.subscriptions.size < 64, 'Watch subscription limit reached.');
      const directory = await self.directory(input.checkout);
      ensure(!self.closed, 'Workspace scope closed during watch acquisition.');
      const watchers: FSWatcher[] = []; let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, error: string | undefined;
      const changed = (failure?: string) => {
        if (disposed) return; error = failure ?? error;
        if (!timer) timer = setTimeout(() => { timer = undefined; if (disposed) return; try { directory.check(); } catch (e) { error = errorText(e); } Queue.offerUnsafe(queue, {checkout: input.checkout, paths: input.paths, error}); error = undefined; }, 100);
      };
      const stop = () => { if (disposed) return; disposed = true; clearTimeout(timer); watchers.forEach(w => w.close()); self.subscriptions.delete(stop); };
      try {
        for (const p of new Set(input.paths)) {
          path(p, true); const before = await directory.entry(p);
          ensure(before.directory, 'Watch directory paths, including parent directories of files.');
          const watcher = fsWatch(resolve(directory.root, p), {persistent: false, recursive: true}, () => changed()).on('error', e => changed(errorText(e)));
          watchers.push(watcher);
          ensure(same(before, await directory.entry(p)), 'Watch directory changed during subscription.');
        }
        const common = self.approval(input.checkout).common.path;
        if (!common.startsWith(directory.root + '/')) watchers.push(fsWatch(common, {persistent: false, recursive: true}, () => changed()).on('error', e => changed(errorText(e))));
        self.subscriptions.add(stop); Queue.offerUnsafe(queue, {checkout: input.checkout, paths: input.paths, ready: true}); return stop;
      } catch (error) { stop(); throw error; }
      }), stop => Effect.sync(stop));
      return Stream.fromQueue(queue);
    }));
  }
}
