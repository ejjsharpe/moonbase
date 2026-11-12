import { Cause, Deferred, Effect, Exit, Scope, type Fiber, type FiberSet } from 'effect';
import { decodeHostInput, decodeHostOutput } from '@moonbase/contracts/workspace-host-schema';
import { releaseResource } from '@moonbase/effect';
import { type WorkspaceHostServiceShape } from '@moonbase/contracts/services';
import {
  ApplicationError,
  type CheckoutTarget,
  type GitCheckoutTarget,
} from '@moonbase/contracts/workspace';
import type {
  HostCommand,
  HostInput,
  HostOperationResult,
  HostOutput,
  HostSaveResult,
} from '@moonbase/contracts/workspace-host';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { admit, applicationError, type AdmissionOwner } from './admission.ts';
import { HostJournal, type RequestOperation } from './host-journal.ts';
import { ChatWorktrees } from './chat-worktrees.ts';
import { CheckoutFolders } from './checkout-folders.ts';
import {
  hostDecoders,
  type Approval,
  type HostOperationRecord,
  type HostRequestRecord,
  type HostSaveRecord,
  type ChatFolders,
  type RootPredicate,
  type WorkspaceConfiguration,
} from './schema.ts';
import { WorkspaceDiscovery } from './discovery.ts';
import { WorkspaceObservations } from './observations.ts';
import { createGitGate, Directory, identity, makeRunner } from './filesystem.ts';
import type { NativeImport } from './native-import.ts';
import { NativeReferences } from './native-references.ts';
import { WorkspaceWorktrees } from './worktrees.ts';
import {
  affected,
  canonical,
  checkout,
  ensure,
  errorText,
  fail,
  folded,
  hash,
  identifier,
  overlaps,
  path,
  same,
  textDocument,
} from './validation.ts';

const dayMs = 24 * 60 * 60 * 1000;
type OperationSource = {
  path: string;
  identity: string;
  directory: boolean;
  native?: NativeImport;
};
const containsSelectedSource = (
  entry: { path: string; identity: string; directory: boolean },
  source: { path: string; identity: string; native?: NativeImport },
) =>
  entry.identity === source.identity ||
  (entry.directory &&
    (source.native
      ? source.native.parents.split(',').includes(entry.identity)
      : affected(source.path, entry.path)));
type WorkspaceOwnership = {
  operations: FiberSet.FiberSet<unknown, ApplicationError>;
  operationScope: Scope.Closeable;
  helperScope: Scope.Closeable;
  referenceScope: Scope.Closeable;
  observationScope: Scope.Closeable;
  runHelper: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  startExpiry: (effect: Effect.Effect<void>) => Fiber.Fiber<void>;
};

/**
 * macOS on Node 26.13 or newer, the pinned Electron, or exactly Bun 1.4.4. Bun and Electron are
 * qualified exactly, so upgrading either is a deliberate change; Bun reports an older Node version
 * than it implements, so it is never judged by that version.
 */
export function ensureQualifiedRuntime(platform: string, versions: NodeJS.ProcessVersions) {
  const [major = 0, minor = 0] = versions.node.split('.').map(Number);
  let qualified = major > 26 || (major === 26 && minor >= 13);
  if (versions.electron !== undefined) qualified = versions.electron === '45.1.0';
  if (versions.bun !== undefined) qualified = versions.bun === '1.4.4';
  if (platform !== 'darwin' || !qualified)
    fail(
      'Incompatible',
      'The workspace requires macOS on Node 26.13 or newer, Electron 45.1.0 or exactly Bun 1.4.4.',
    );
}

/** A path's real path, through its nearest existing folder when the path itself doesn't exist. */
function resolveNearest(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(resolveNearest(parent), basename(path));
  }
}
const holdsOrIsInside = (a: string, b: string) => {
  const [x, y] = [folded(a), folded(b)];
  const inside = (outer: string, inner: string) => {
    const p = relative(outer, inner);
    return !p || (p !== '..' && !p.startsWith('../') && !isAbsolute(p));
  };
  return inside(x, y) || inside(y, x);
};

/** Refusals that repeat for the same input; every other failure may succeed on retry. */
const deterministicRefusals: ReadonlySet<string> = new Set([
  'InvalidInput',
  'Unauthorized',
  'Conflict',
  'Incompatible',
]);

export class FileHost implements AdmissionOwner {
  readonly ownership: WorkspaceOwnership;
  readonly store: Store;
  readonly service: WorkspaceHostServiceShape;
  readonly directories = new Map<string, Directory>();
  readonly observations: WorkspaceObservations;
  readonly signals = new Set<AbortController>();
  readonly leases = new Set<{
    checkoutId: string;
    paths: string[];
    done: Deferred.Deferred<void>;
  }>();
  readonly cleanupFailures: Cause.Cause<never>[] = [];
  readonly closeCompletion = Deferred.makeUnsafe<void>();
  closing = false;
  readonly references: NativeReferences;
  readonly journal: HostJournal;
  readonly run;
  readonly discovery: WorkspaceDiscovery;
  readonly worktrees: WorkspaceWorktrees;
  closed = false;
  readonly config: WorkspaceConfiguration;
  get operations() {
    return this.ownership.operations;
  }
  private readonly allowRoot: RootPredicate | undefined;
  private readonly chats: ChatFolders | undefined;
  readonly chatWorktrees: ChatWorktrees;
  readonly checkoutFolders: CheckoutFolders;
  readonly gitReady: () => Promise<void>;
  constructor(
    config: WorkspaceConfiguration,
    ownership: WorkspaceOwnership,
    now = Date.now,
    allowRoot?: RootPredicate,
    chats?: ChatFolders,
  ) {
    this.config = config;
    this.allowRoot = allowRoot;
    this.chats = chats;
    this.gitReady = createGitGate(config.gitExecutable ?? '/usr/bin/git');
    this.ownership = ownership;
    ensureQualifiedRuntime(process.platform, process.versions);
    identifier(config.hostId);
    const helper =
      config.filesystemHelper ?? fileURLToPath(new URL('../dist/filesystem', import.meta.url));
    ensure(
      isAbsolute(helper) && isAbsolute(config.gitExecutable ?? '/usr/bin/git'),
      'Filesystem/Git executables must be absolute.',
    );
    this.discovery = new WorkspaceDiscovery(
      (target) => this.directory(target),
      (target) => this.policy(target),
      config.gitExecutable ?? '/usr/bin/git',
      config.ripgrepExecutable,
    );
    this.worktrees = new WorkspaceWorktrees(
      (target) => this.directory(target),
      // `createWorktree` refuses a plain folder first, so `source`'s approval names its repository.
      (root, source, signal) =>
        this.open(root, signal, { root, common: this.approval(source).common! }),
      (location) => this.permitLocation(location),
      (message) =>
        this.cleanupFailures.push(Cause.die(new ApplicationError({ code: 'Uncertain', message }))),
    );
    this.chatWorktrees = new ChatWorktrees({
      open: (root, signal) => this.open(root, signal),
      list: (target, signal) => this.worktrees.listWorktrees(target, signal),
      create: (input, signal) => this.worktrees.createWorktree(input, signal),
      permitParent: (parent) => this.permitContainer(parent),
    });
    this.checkoutFolders = new CheckoutFolders({
      approvals: () => this.store.all<Approval>('approvals'),
      verify: (target) => this.verifyFolder(target),
      permit: async (root) => {
        this.protected(root);
        await this.permit(root, root);
      },
      // Through a borrowed descriptor, so checking many approvals never fills the retained cap.
      list: (target, signal) =>
        this.borrow(
          target,
          async (directory) =>
            (await this.worktrees.listWorktrees(target, signal, directory)).worktrees,
        ),
      gitEntry: (root) => this.gitEntry(root),
    });
    this.store = new Store(config.dataDirectory, {
      file: 'workspace-host.sqlite',
      applicationId: 1296193364,
      schema:
        "CREATE INDEX IF NOT EXISTS pending_host_saves ON records(bucket) WHERE bucket='saves' AND json_extract(body, '$.result') IS NULL; CREATE INDEX IF NOT EXISTS feed_operation ON records(json_extract(body, '$.operation')) WHERE bucket='feed';",
      decoders: hostDecoders,
    });
    try {
      this.store.claim('host', config.hostId, 'Workspace store belongs to a different host.');
    } catch (error) {
      this.store.close();
      throw error;
    }
    this.run = makeRunner(helper, ownership.runHelper, (cause) => this.cleanupFailures.push(cause));
    this.journal = new HostJournal(
      this.store,
      (target) => this.directory(target),
      (checkoutId) => this.active(checkoutId),
      now,
      config.journalRetentionMs ?? 7 * dayMs,
    );
    this.references = new NativeReferences(
      (target) => this.directory(target),
      (target) => {
        this.approval(target);
      },
      (path) => this.protected(path),
      ownership.startExpiry,
      () => this.closed,
      (cause) => this.cleanupFailures.push(cause),
    );
    this.observations = new WorkspaceObservations(
      (target) => this.directory(target),
      (target) => this.approval(target).common?.path,
      ownership.observationScope,
      (fn) => this.effect(fn),
      () => this.closed,
      (cause) => this.cleanupFailures.push(cause),
    );
    const call =
      <K extends HostCommand>(
        operation: K,
        fn: (input: HostInput<K>, signal: AbortSignal) => Promise<HostOutput<K>>,
        persistence = false,
        lease?: (input: HostInput<K>) => { checkoutId: string; paths: string[] },
        /** Undoes an output nobody will receive, such as a reply to a cancelled request. */
        abandoned?: (output: HostOutput<K>, input: HostInput<K>) => void,
      ) =>
      (input: HostInput<K>) =>
        Effect.flatMap(
          Effect.try({ try: () => decodeHostInput(operation, input), catch: applicationError }),
          (captured) =>
            this.effect(
              async (signal) => decodeHostOutput(operation, await fn(captured, signal)),
              persistence,
              lease?.(captured),
              abandoned && ((output) => abandoned(output, captured)),
            ),
        );
    this.service = {
      openCheckout: call<'openCheckout'>('openCheckout', (input, signal) =>
        this.open(input.root, signal),
      ),
      verifyCheckout: call<'verifyCheckout'>('verifyCheckout', async (input) => {
        await this.directory(input.checkout);
      }),
      readFile: call<'readFile'>('readFile', async (target, signal) =>
        (await this.directory(target.checkout)).read(target.path, signal),
      ),
      saveFile: call<'saveFile'>(
        'saveFile',
        (input, signal) => this.save(input, signal),
        false,
        (input) => ({ checkoutId: input.target.checkout.checkoutId, paths: [input.target.path] }),
      ),
      listDirectory: call<'listDirectory'>('listDirectory', (input, signal) =>
        this.discovery.listDirectory(input, signal),
      ),
      getIgnoredPaths: call<'getIgnoredPaths'>('getIgnoredPaths', (input, signal) =>
        this.discovery.getIgnoredPaths(input, signal),
      ),
      gitStatus: call<'gitStatus'>('gitStatus', (input, signal) =>
        this.discovery.getStatus(input.checkout, signal),
      ),
      listWorktrees: call<'listWorktrees'>('listWorktrees', (input, signal) =>
        this.worktrees.listWorktrees(input.checkout, signal),
      ),
      createWorktree: call<'createWorktree'>('createWorktree', (input, signal) =>
        this.createWorktree(input, signal),
      ),
      initializeRepository: call<'initializeRepository'>(
        'initializeRepository',
        (input, signal) => this.initializeRepositoryOnce(input, signal),
        false,
        // Waits for, and holds off, every save and file operation in the checkout.
        (input) => ({ checkoutId: input.checkout.checkoutId, paths: [''] }),
      ),
      readComparison: call<'readComparison'>('readComparison', (input, signal) =>
        this.discovery.readComparison(input, signal),
      ),
      lookupFiles: call<'lookupFiles'>('lookupFiles', (input, signal) =>
        this.discovery.lookupFiles(input, signal),
      ),
      searchText: call<'searchText'>('searchText', (input, signal) =>
        this.discovery.searchText(input, signal),
      ),
      inspectEntries: call<'inspectEntries'>('inspectEntries', async (input, signal) => {
        ensure(
          Array.isArray(input.paths) && input.paths.length > 0 && input.paths.length <= 256,
          'Inspect between 1 and 256 entries.',
        );
        const directory = await this.directory(input.checkout);
        return Promise.all(
          input.paths.map(async (p) => {
            path(p);
            return {
              target: { checkout: input.checkout, path: p },
              ...(await directory.entry(p, signal)),
            };
          }),
        );
      }),
      mutate: call<'mutate'>(
        'mutate',
        (input, signal) => this.mutate(input, signal),
        false,
        (input) => ({ checkoutId: input.checkout.checkoutId, paths: this.footprint(input) }),
      ),
      operationStatus: call<'operationStatus'>(
        'operationStatus',
        async (input) => this.journal.operationStatus(input),
        true,
      ),
      acknowledgeOperation: call<'acknowledgeOperation'>(
        'acknowledgeOperation',
        async (input) => this.journal.acknowledgeOperation(input),
        true,
      ),
      saveStatus: call<'saveStatus'>(
        'saveStatus',
        async (input) => this.journal.saveStatus(input),
        true,
      ),
      acknowledgeSave: call<'acknowledgeSave'>(
        'acknowledgeSave',
        async (input) => this.journal.acknowledgeSave(input),
        true,
      ),
      listOperations: call<'listOperations'>(
        'listOperations',
        async (input) => {
          this.approval(input.checkout);
          return this.journal.listOperations(input.checkout, input.after);
        },
        true,
      ),
      createChatWorktree: call<'createChatWorktree'>('createChatWorktree', (input, signal) =>
        this.createChatWorktree(input, signal),
      ),
      turnChatIntoProject: call<'turnChatIntoProject'>('turnChatIntoProject', (input, signal) =>
        this.turnChatIntoProject(input, signal),
      ),
      captureImports: call<'captureImports'>(
        'captureImports',
        async (input, signal) => {
          this.requireNativeImports();
          return { references: await this.references.capture(input, signal) };
        },
        false,
        undefined,
        (output, input) => this.references.release({ ...input, references: output.references }),
      ),
      releaseImports: call<'releaseImports'>('releaseImports', async (input) => {
        this.requireNativeImports();
        this.references.release(input);
      }),
      watch: (input) => this.observations.watch(input),
    };
  }
  private requireNativeImports() {
    if (this.config.nativeImports === false)
      fail('Incompatible', 'This host does not accept native imports.');
  }
  effect<A>(
    fn: (signal: AbortSignal) => Promise<A>,
    persistence = false,
    lease?: { checkoutId: string; paths: string[] },
    abandoned?: (result: A) => void,
  ): Effect.Effect<A, ApplicationError> {
    return admit(
      this,
      fn,
      persistence,
      lease ? (signal, work) => this.withLease(lease, signal, work) : undefined,
      abandoned,
    );
  }
  footprint(input: HostInput<'mutate'>) {
    const sources = input.sources.map((s) => s.target.path);
    if (input.destination === undefined) return sources;
    const names = sources.length
      ? sources.map((p) => basename(p))
      : (input.nativeReferences ?? []).map((token) => this.references.getSourceName(token));
    return [
      ...sources,
      ...(names.length > 1
        ? names.map((name) => (name ? join(input.destination!, name) : input.destination!))
        : [input.destination]),
    ];
  }
  active(checkoutId: string) {
    return [...this.leases].some((lock) => lock.checkoutId === checkoutId);
  }
  withLease<A>(
    lease: { checkoutId: string; paths: string[] },
    signal: AbortSignal,
    work: Effect.Effect<A, ApplicationError>,
  ) {
    return Effect.suspend(() => {
      const previous = [...this.leases].filter(
        (active) => active.checkoutId === lease.checkoutId && overlaps(lease.paths, active.paths),
      );
      const entry = { ...lease, done: Deferred.makeUnsafe<void>() };
      this.leases.add(entry);
      const cancelled = Effect.callback<never, ApplicationError>((resume) => {
        const cancel = () =>
          resume(
            Effect.fail(
              new ApplicationError({
                code: 'Cancelled',
                message: 'Workspace command cancelled before admission.',
              }),
            ),
          );
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        return Effect.sync(() => signal.removeEventListener('abort', cancel));
      });
      return Effect.raceFirst(
        Effect.forEach(previous, (active) => Deferred.await(active.done)),
        cancelled,
      ).pipe(
        Effect.interruptible,
        Effect.flatMap(() => {
          if (this.closed)
            return Effect.fail(
              new ApplicationError({ code: 'Unavailable', message: 'Workspace scope is closed.' }),
            );
          if (signal.aborted)
            return Effect.fail(
              new ApplicationError({
                code: 'Cancelled',
                message: 'Workspace command cancelled before admission.',
              }),
            );
          return work;
        }),
        Effect.ensuring(
          Effect.sync(() => {
            this.leases.delete(entry);
            Deferred.doneUnsafe(entry.done, Effect.void);
          }),
        ),
      );
    });
  }
  close(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closing) return Deferred.await(this.closeCompletion);
      this.closing = this.closed = true;
      for (const signal of this.signals) signal.abort();
      return Effect.gen({ self: this }, function* () {
        const releases = [
          this.observations.close(),
          Scope.close(this.ownership.referenceScope, Exit.void),
          Scope.close(this.ownership.operationScope, Exit.void),
          Scope.close(this.ownership.helperScope, Exit.void),
          Effect.suspend(() =>
            Effect.forEach(this.directories.values(), (directory) =>
              Effect.exit(releaseResource(() => directory.close())),
            ).pipe(
              Effect.flatMap((outcomes) => {
                const failures = outcomes.flatMap((exit) =>
                  Exit.isFailure(exit) ? [exit.cause] : [],
                );
                return failures.length
                  ? Effect.failCause(failures.reduce((all, cause) => Cause.combine(all, cause)))
                  : Effect.void;
              }),
            ),
          ),
          releaseResource(() => this.store.close()),
        ];
        const outcomes = yield* Effect.forEach(releases, Effect.exit);
        const failures = [
          ...this.cleanupFailures,
          ...outcomes.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : [])),
        ];
        if (failures.length)
          return yield* Effect.failCause(
            failures.reduce((combined, cause) => Cause.combine(combined, cause)),
          );
      }).pipe(Effect.onExit((exit) => Deferred.done(this.closeCompletion, exit)));
    }).pipe(Effect.uninterruptible);
  }
  /** Refuses a path that holds, or sits inside, a reserved path of the host's owner. */
  private reserve(path: string) {
    const real = resolveNearest(path);
    for (const reserved of this.config.reserved ?? [])
      ensure(
        !holdsOrIsInside(real, resolveNearest(reserved)),
        'This location is reserved by the workspace host.',
      );
  }
  /** Whether the root policy lets the host use `real`; a throwing predicate denies. */
  async permit(real: string, requested: string) {
    if (!this.allowRoot) return;
    let allowed = false;
    try {
      allowed = await this.allowRoot(real, requested);
    } catch {
      // Denied below.
    }
    if (!allowed) fail('Unauthorized', 'This folder is outside what this host may open.');
  }
  /** A new worktree's location: reserved paths and, as it doesn't exist yet, its parent's policy. */
  async permitLocation(location: string) {
    this.protected(location);
    if (this.allowRoot) {
      const parent = dirname(location);
      await this.permit(parent, parent);
    }
  }
  protected(root: string) {
    this.reserve(root);
    const inside = (a: string, b: string) => {
      const p = relative(a, b);
      return !p || (p !== '..' && !p.startsWith('../') && !isAbsolute(p));
    };
    ensure(
      !inside(root, this.store.directory) && !inside(this.store.directory, root),
      'Workspace state and file operations must remain outside one another.',
    );
  }
  approval(target: CheckoutTarget) {
    checkout(target);
    if (target.hostId !== this.config.hostId)
      fail('Unauthorized', 'Remote targets are not local filesystem authority.');
    const stored = this.store.get<Approval>('approvals', target.checkoutId);
    if (!stored || !same(stored.target, target))
      fail(
        'Unauthorized',
        'Exact checkout identity is not approved. Choose the checkout through the native picker.',
      );
    return stored!;
  }
  /** The checkout's open directory, re-checked. */
  async directory(target: CheckoutTarget) {
    const { directory, transient } = await this.checked(target, true);
    transient?.close();
    return directory;
  }
  /** Re-checks a checkout through a descriptor closed again, so folder checks never use up the cap. */
  async verifyFolder(target: CheckoutTarget) {
    (await this.checked(target, false)).transient?.close();
  }
  /** Runs `operate` on the re-checked checkout through a descriptor that is closed afterwards. */
  async borrow<T>(target: CheckoutTarget, operate: (directory: Directory) => Promise<T>) {
    const { directory, transient } = await this.checked(target, false);
    try {
      return await operate(directory);
    } finally {
      transient?.close();
    }
  }
  private async checked(target: CheckoutTarget, retain: boolean) {
    const approved = this.approval(target);
    // Every use re-checks the root policy, so a root replaced since it was approved, or one that
    // a smaller policy no longer allows, grants nothing.
    await this.permit(target.root, target.root);
    let directory = this.directories.get(target.checkoutId);
    let transient: Directory | undefined;
    if (!directory && !retain) {
      directory = transient = new Directory(
        target.root,
        approved.identity,
        this.run,
        this.config.gitExecutable ?? '/usr/bin/git',
        this.gitReady,
      );
    } else if (!directory) {
      ensure(
        this.directories.size < 128,
        'Open checkout resource limit reached. Restart after preserving recovery to release retained checkout descriptors.',
      );
      directory = new Directory(
        target.root,
        approved.identity,
        this.run,
        this.config.gitExecutable ?? '/usr/bin/git',
        this.gitReady,
      );
      this.directories.set(target.checkoutId, directory);
    }
    try {
      directory.check();
      // A plain folder runs no Git, so only its own identity matters.
      if (!approved.common) return { directory, transient };
      ensure(
        same(this.gitEntry(target.root), approved.gitEntry),
        'Checkout Git metadata identity changed. Restore the original repository.',
      );
      const fd = openSync(
        approved.common.path,
        constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000,
      );
      try {
        ensure(
          identity(fstatSync(fd)) === approved.common.identity,
          'Repository common directory identity changed.',
        );
      } finally {
        closeSync(fd);
      }
      return { directory, transient };
    } catch (error) {
      transient?.close();
      throw error;
    }
  }
  /** The root's `.git` entry, or null when it has none. */
  gitEntry(root: string) {
    let fd: number;
    try {
      fd = openSync(join(root, '.git'), constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const info = fstatSync(fd);
      ensure(
        info.isDirectory() || (info.isFile() && info.size < 4096 && info.nlink === 1),
        'Invalid checkout Git metadata.',
      );
      return { identity: identity(info), pointer: info.isFile() ? readFileSync(fd, 'utf8') : null };
    } finally {
      closeSync(fd);
    }
  }
  policy(target: CheckoutTarget) {
    const common = this.approval(target).common;
    if (!common) return;
    for (const p of ['info', 'info/exclude']) {
      let fd: number;
      try {
        fd = openSync(join(common.path, p), constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      try {
        const info = fstatSync(fd);
        ensure(
          p === 'info' ? info.isDirectory() : info.isFile(),
          'Invalid repository ignore policy.',
        );
      } finally {
        closeSync(fd);
      }
    }
  }
  /**
   * Approves a checkout root: a Git checkout's root, or a plain folder in no repository. `created`
   * names a worktree this workspace just made at exactly `root`, in the repository whose common
   * directory is `common`.
   */
  async open(
    root: string,
    signal: AbortSignal,
    created?: { root: string; common: { path: string; identity: string } },
  ): Promise<CheckoutTarget> {
    ensure(
      typeof root === 'string' && isAbsolute(root) && !root.includes('\0'),
      'Choose an absolute checkout root through the native picker.',
    );
    const requested = root;
    root = realpathSync(root);
    if (created) ensure(root === created.root, 'The new worktree location changed. Inspect it.');
    this.protected(root);
    await this.permit(root, requested);
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    const id = identity(fstatSync(fd));
    closeSync(fd);
    const gitEntry = this.gitEntry(root);
    const directory = new Directory(
      root,
      id,
      this.run,
      this.config.gitExecutable ?? '/usr/bin/git',
      this.gitReady,
    );
    try {
      const repository =
        gitEntry || created ? await this.inspectRepository(directory, signal) : null;
      if (created)
        ensure(
          repository?.common.path === created.common.path &&
            repository.common.identity === created.common.identity,
          'The new worktree belongs to another repository. Inspect it.',
        );
      if (!repository) {
        // No `.git` here: a folder inside a repository is not its checkout root.
        // Untranslated, so the refusal below reads the same in every locale.
        const inside = await directory
          .git(['rev-parse', '--git-dir'], undefined, signal, { untranslated: true })
          .then(
            () => true,
            (error: { status?: number; stderr?: string }) => {
              if (error.status === 128 && /not a git repository/i.test(error.stderr ?? ''))
                return false;
              throw error;
            },
          );
        ensure(!inside, 'Choose the repository checkout root.');
      }
      const projectId = hash(
        canonical(
          repository
            ? [this.config.hostId, repository.common.path, repository.common.identity]
            : [this.config.hostId, id],
        ),
      );
      const previous = this.store.all<Approval>('approvals').filter((a) => a.target.root === root);
      const current = previous.find((a) => a.identity === id && a.target.projectId === projectId);
      if (current) return current.target;
      // A plain folder that has since become a repository of its own (its main working tree, with
      // its own `.git` folder) is approved again as Git; a `.git` pointing elsewhere is not.
      const initialized =
        repository?.worktree === 'main' &&
        repository.common.path === join(root, '.git') &&
        previous.some((a) => a.identity === id && a.target.vcs === 'none');
      // A worktree this workspace just made at a removed one's location is approved afresh; the
      // stale approval stays but matches nothing. Anywhere else a replaced directory is refused.
      ensure(
        !previous.length || created !== undefined || initialized,
        'Checkout or repository identity changed. Restore the original directory.',
      );
      const base = {
        hostId: this.config.hostId,
        checkoutId: hash(canonical([this.config.hostId, root, id])),
        projectId,
        root,
      };
      const target: CheckoutTarget = repository
        ? {
            vcs: 'git',
            ...base,
            branch: await this.discovery.getBranch(directory, signal),
            worktree: repository.worktree,
          }
        : { vcs: 'none', ...base };
      this.store.put('approvals', target.checkoutId, {
        target,
        identity: id,
        common: repository?.common ?? null,
        gitEntry,
      });
      return target;
    } finally {
      directory.close();
    }
  }
  /** The repository whose working tree `directory` is the top of. */
  private async inspectRepository(directory: Directory, signal: AbortSignal) {
    const root = directory.root;
    const top = (await directory.git(['rev-parse', '--show-toplevel'], undefined, signal))
      .toString()
      .trim();
    ensure(realpathSync(top) === root, 'Choose the repository checkout root.');
    const [gitDirectory, common] = (
      await directory.git(['rev-parse', '--git-dir', '--git-common-dir'], undefined, signal)
    )
      .toString()
      .trim()
      .split('\n')
      .map((p) => realpathSync(resolve(root, p)));
    const commonFd = openSync(common, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    try {
      return {
        common: { path: common, identity: identity(fstatSync(commonFd)) },
        worktree: gitDirectory === common ? ('main' as const) : ('linked' as const),
      };
    } finally {
      closeSync(commonFd);
    }
  }
  /** Replays the first outcome of a `createWorktree` request ID; a new ID creates the worktree. */
  async createWorktree(input: HostInput<'createWorktree'>, signal: AbortSignal) {
    const id = this.journal.requestId('createWorktree', input);
    const previous = this.journal.replayRequest(id, 'createWorktree', input);
    if (previous) return previous;
    this.approval(input.checkout);
    const occupied = this.journal.reserveRequest(id, { input });
    if (occupied) return this.journal.replayRequest(id, 'createWorktree', input)!;
    return this.settleRequest(id, input, () => this.worktrees.createWorktree(input, signal));
  }
  /**
   * Replays the first outcome of a `createChatWorktree` request ID; a new ID makes the worktree
   * at the location derived from `root`'s repository.
   */
  async createChatWorktree(input: HostInput<'createChatWorktree'>, signal: AbortSignal) {
    return this.once('createChatWorktree', input, () => this.chatWorktrees.create(input, signal));
  }
  /**
   * Replays the first outcome of a `turnChatIntoProject` request ID. A new ID checks the chat's own
   * folder is one the daemon made, opens it as a checkout and only then marks the chat, so a
   * failure leaves the chat as it was; the checkout it returns is the folder's.
   */
  async turnChatIntoProject(input: HostInput<'turnChatIntoProject'>, signal: AbortSignal) {
    return this.once('turnChatIntoProject', input, async () => {
      const chats = this.chats;
      if (!chats) return fail('Incompatible', 'This host cannot turn a chat into a project.');
      const folder = await chats.findOwnFolder(input.target);
      const target = await this.open(folder, signal);
      // `open` resolves links: a folder replaced by one since it was checked opens elsewhere.
      if (target.root !== folder)
        fail('Unauthorized', 'The folder changed before it opened as a project. Inspect it.');
      await chats.markAsProject(input.requestId, input.target);
      return target;
    });
  }
  /** Runs a request not seen before and records its outcome; a repeat gets that outcome. */
  private async once(
    operation: 'createChatWorktree' | 'turnChatIntoProject',
    input: HostInput<'createChatWorktree'> | HostInput<'turnChatIntoProject'>,
    run: () => Promise<CheckoutTarget>,
  ) {
    const id = this.journal.requestId(operation, input);
    const replay = () =>
      this.journal.replayRequest(id, operation as RequestOperation, input as never)!;
    if (this.journal.getRequest(id)) return replay();
    if (this.journal.reserveRequest(id, { input })) return replay();
    return this.settleRequest(id, input, run);
  }
  /** The parent folder a chat's worktrees go in: reserved paths are refused, and so is a folder
   *  whose own parent (where it would be made) is outside what the host may open. */
  async permitContainer(parent: string) {
    this.protected(parent);
    if (this.allowRoot) {
      const container = dirname(parent);
      await this.permit(container, container);
    }
  }
  /** Replays the first outcome of an `initializeRepository` request ID; a new ID runs `git init`. */
  async initializeRepositoryOnce(input: HostInput<'initializeRepository'>, signal: AbortSignal) {
    const id = this.journal.requestId('initializeRepository', input);
    const previous = this.journal.replayRequest(id, 'initializeRepository', input);
    if (previous) return previous as GitCheckoutTarget;
    this.approval(input.checkout);
    const occupied = this.journal.reserveRequest(id, { input });
    if (occupied)
      return this.journal.replayRequest(id, 'initializeRepository', input)! as GitCheckoutTarget;
    return this.settleRequest(id, input, () =>
      this.initializeRepository(input.checkout, signal, input.installationId),
    );
  }
  /**
   * Runs a reserved request. A success or a deterministic refusal is recorded and replayed for
   * the ID. A transient failure (`Unavailable`, `Cancelled`, `Persistence`) releases the
   * reservation so a retry runs again. `Uncertain` (incomplete cleanup) and any other failure keep
   * it, so a replay reports the request interrupted instead of retrying over leftovers; the
   * reservation also stays while the request runs, so a concurrent duplicate never runs it twice.
   */
  private async settleRequest<T extends CheckoutTarget>(
    id: string,
    input: HostRequestRecord['input'],
    run: () => Promise<T>,
  ) {
    try {
      const result = await run();
      try {
        this.journal.settleRequest(id, { input, result });
      } catch {
        /* The worktree or repository exists; a replay of this ID reports it interrupted. */
      }
      return result;
    } catch (error) {
      if (ApplicationError.is(error) && error.code !== 'Uncertain') {
        try {
          if (deterministicRefusals.has(error.code))
            this.journal.settleRequest(id, {
              input,
              error: { code: error.code, message: error.message },
            });
          else this.journal.releaseRequest(id);
        } catch {
          /* A replay of this ID reports the request interrupted. */
        }
      }
      throw error;
    }
  }
  /**
   * Runs `git init` in a plain folder with no `.git` entry and no unsettled saves or file
   * operations, then approves and returns it as the main worktree of its own new repository.
   */
  async initializeRepository(target: CheckoutTarget, signal: AbortSignal, installationId: string) {
    ensure(target.vcs === 'none', 'This project is already a Git repository.');
    const directory = await this.directory(target);
    if (this.gitEntry(target.root))
      fail('Conflict', 'This folder already has a .git entry. Reopen it to use its repository.');
    ensure(
      !this.journal.getPendingSaves(target).length,
      'A save awaits recovery. Resolve it before initializing Git.',
    );
    ensure(
      !this.journal.getUnsettledCheckoutOperations(target, installationId).length,
      'A file operation awaits recovery publication or inspection. Resolve it before initializing Git.',
    );
    await directory.initializeGit(signal);
    // `open` approves a Git target here only as the main worktree of the folder's own `.git`.
    const initialized = await this.open(target.root, signal);
    ensure(initialized.vcs === 'git', 'Git did not initialize this folder. Inspect it.');
    return initialized;
  }
  assertSettled(target: CheckoutTarget, paths: string[], installationId: string, clientId: string) {
    if (
      this.journal
        .getUnsettledOperations(target, installationId, clientId)
        .some((r) => overlaps(paths, this.footprint(r.input))) ||
      this.journal
        .getPendingSaves(target)
        .some((r) => overlaps(paths, [r.input.target.path]) && !r.result)
    )
      fail(
        'Uncertain',
        'An operation awaits recovery publication or inspection. Query its status; do not repeat the mutation.',
      );
  }
  async save(input: HostInput<'saveFile'>, signal: AbortSignal): Promise<HostSaveResult> {
    identifier(input.installationId);
    identifier(input.clientId);
    identifier(input.requestId);
    path(input.target.path);
    this.approval(input.target.checkout);
    const proposed = textDocument(input.text);
    ensure(
      typeof input.expectedVersion === 'string' && /^[a-f0-9]{64}$/.test(input.expectedVersion),
      'Invalid expected content version.',
    );
    const id = this.journal.saveId(input),
      previous = this.journal.getSave(id);
    if (previous) return this.journal.replaySave(id, input, previous);
    this.assertSettled(
      input.target.checkout,
      [input.target.path],
      input.installationId,
      input.clientId,
    );
    const directory = await this.directory(input.target.checkout),
      disk = await directory.read(input.target.path, signal);
    if (signal.aborted) fail('Cancelled', 'Save cancelled before admission.');
    if (disk.version !== input.expectedVersion) {
      const result = { kind: 'conflict', disk } as const;
      const occupied = this.journal.reserveSave(id, { input, result, started: false });
      return occupied
        ? this.journal.replaySave(id, input, this.journal.getSave(id) ?? occupied)
        : result;
    }
    const temporary = join(dirname(input.target.path), '.moonbase-save-' + randomUUID());
    const record: HostSaveRecord = { input, started: true, temporary, baseline: disk };
    const occupied = this.journal.reserveSave(id, record);
    if (occupied) return this.journal.replaySave(id, input, this.journal.getSave(id) ?? occupied);
    this.journal.startSave(id);
    try {
      const stagingIdentity = (
        await directory.io(['stage', input.target.path, temporary], input.text)
      ).toString();
      const current = await directory.read(input.target.path);
      if (current.version !== input.expectedVersion)
        record.result = { kind: 'conflict', disk: current };
      else {
        await directory.io(['replace', input.target.path, temporary, stagingIdentity]);
        record.result = { kind: 'saved', disk: proposed };
      }
      try {
        this.journal.settleSave(id, record);
      } catch (error) {
        if (record.result.kind === 'saved')
          record.result = {
            ...record.result,
            persistencePending: true,
            message: 'Saved to disk; durable request publication failed: ' + errorText(error),
          };
        this.journal.retainSave(id, record);
      }
      return record.result;
    } catch (error) {
      record.message = errorText(error);
      this.journal.retainSave(id, record);
      return fail(
        'Uncertain',
        'Save may have changed disk. Request retained; inspect disk and recovery. ' +
          errorText(error),
      );
    } finally {
      this.journal.finishSave(id);
    }
  }
  async mutate(input: HostInput<'mutate'>, signal: AbortSignal): Promise<HostOperationResult> {
    identifier(input.installationId);
    identifier(input.clientId);
    identifier(input.id);
    this.approval(input.checkout);
    ensure(
      ['create-file', 'create-directory', 'move', 'copy', 'trash', 'import'].includes(input.kind) &&
        Array.isArray(input.sources) &&
        input.sources.length <= 128 &&
        (input.replacements === undefined || Array.isArray(input.replacements)),
      'Invalid file operation.',
    );
    ensure(
      input.text === undefined || input.kind === 'create-file',
      'Text belongs only to file creation.',
    );
    if (input.text !== undefined) textDocument(input.text);
    const id = this.journal.operationId(input),
      previous = this.journal.getOperation(id);
    if (previous) return this.journal.replayOperation(id, input, previous);
    this.assertSettled(input.checkout, this.footprint(input), input.installationId, input.clientId);
    if (signal.aborted) fail('Cancelled', 'Operation cancelled before admission.');
    const directory = await this.directory(input.checkout);
    const { items, tokens, replacements } = await this.prepareMutation(input, directory, signal);
    const create = input.kind.startsWith('create-');
    const importing = input.kind === 'import';
    const staging = items.map((item) => item.staging);
    const record: HostOperationRecord = {
      input,
      result: {
        id: input.id,
        clientId: input.clientId,
        checkout: input.checkout,
        kind: input.kind,
        outcome: 'uncertain',
        items: [],
        message:
          'Admitted operation. Interrupted items must be inspected, never repeated automatically.',
      },
    };
    // The complete immutable selection is durable before the first native mutation.
    const claims = this.references.inspectReferences(tokens, input.checkout, input.clientId);
    if (signal.aborted) fail('Cancelled', 'Operation cancelled before admission.');
    const occupied = this.journal.reserveOperation(id, record);
    if (occupied)
      return this.journal.replayOperation(id, input, this.journal.getOperation(id) ?? occupied);
    this.references.claimReferences(claims);
    try {
      for (const { source, destination, staging: temporary } of items) {
        if (signal.aborted) {
          record.result.items.push({
            source: source.path,
            destination,
            outcome: 'failed',
            message: 'Cancelled before this item started.',
          });
          continue;
        }
        const replacement = replacements.find(
          (r) =>
            destination !== undefined &&
            dirname(r.target.path) === dirname(destination) &&
            folded(r.target.path) === folded(destination),
        );
        try {
          if (replacement) {
            const trashLocation = (
              await directory.io(
                ['trash', replacement.target.path, '-', replacement.identity],
                undefined,
                signal,
              )
            ).toString();
            record.result.items.push({
              source: replacement.target.path,
              outcome: 'completed',
              message: 'Explicit replacement moved to macOS Trash: ' + trashLocation,
            });
            this.journal.writeOperation(id, record);
          }
          if (create) {
            await directory.io(
              [
                'create',
                dirname(destination!) === '.' ? '.' : dirname(destination!),
                basename(destination!),
                source.directory ? 'folder' : 'file',
                await directory.destination(destination!),
              ],
              input.text,
              signal,
            );
          } else if (input.kind === 'move') {
            await directory.io(
              ['move', source.path, destination!, source.identity],
              undefined,
              signal,
            );
            ensure(
              (await directory.entry(destination!)).identity === source.identity,
              'Move destination identity changed after native success.',
            );
          } else if (input.kind === 'trash') {
            const trashPath = (
              await directory.io(['trash', source.path, '-', source.identity], undefined, signal)
            ).toString();
            record.result.items.push({
              source: source.path,
              outcome: 'completed',
              message: trashPath ? 'macOS Trash: ' + trashPath : 'Moved to macOS Trash.',
            });
            this.journal.writeOperation(id, record);
            continue;
          } else {
            await directory.io(
              [
                importing ? 'import' : 'copy',
                source.path,
                destination!,
                source.identity,
                temporary,
                await directory.destination(destination!),
                ...(source.native
                  ? [source.native.path, source.native.parents, input.checkout.root]
                  : []),
              ],
              undefined,
              signal,
              source.native ? [source.native.fd] : [],
            );
          }
          record.result.items.push({ source: source.path, destination, outcome: 'completed' });
        } catch (error) {
          let outcome: 'failed' | 'uncertain' = 'uncertain';
          // A preflight error is known only while the original object still occupies its exact path.
          if (
            !(error as { uncertain?: boolean }).uncertain &&
            !create &&
            !['copy', 'import'].includes(input.kind) &&
            !replacement
          ) {
            try {
              if ((await directory.entry(source.path)).identity === source.identity)
                outcome = 'failed';
            } catch {
              /* Keep uncertain evidence. */
            }
          }
          record.result.items.push({
            source: source.path,
            destination,
            outcome,
            message: errorText(error),
          });
        }
        try {
          this.journal.writeOperation(id, record);
        } catch (error) {
          record.result.message =
            'Filesystem outcome retained in memory; durable publication failed: ' +
            errorText(error);
          this.journal.retainOperation(id, record);
          return record.result;
        }
        if (record.result.items.some((item) => item.outcome === 'uncertain')) break;
      }
      if (
        record.result.items.some((i) => i.outcome === 'uncertain') ||
        record.result.items.length < items.length
      )
        record.result.outcome = 'uncertain';
      else if (record.result.items.every((i) => i.outcome === 'completed'))
        record.result.outcome = 'completed';
      else record.result.outcome = 'failed';
      if (record.result.outcome === 'uncertain')
        record.result.message =
          'Inspect original, destination, Finder Trash and staging: ' +
          staging.filter(Boolean).join(', ') +
          '. Drafts and journal retained; no automatic retry.';
      else delete record.result.message;
      try {
        this.journal.finalizeOperation(id, record);
      } catch (error) {
        record.result.message =
          'Filesystem outcome retained in memory; durable publication failed: ' + errorText(error);
        this.journal.retainOperation(id, record);
      }
      return record.result;
    } finally {
      this.references.releaseClaimedReferences(claims);
    }
  }
  private async prepareMutation(
    input: HostInput<'mutate'>,
    directory: Directory,
    signal: AbortSignal,
  ) {
    const create = input.kind.startsWith('create-');
    const importing = input.kind === 'import';
    const tokens = input.nativeReferences ?? [];
    ensure(
      Array.isArray(tokens) && tokens.length <= 128 && new Set(tokens).size === tokens.length,
      'Invalid native references.',
    );
    ensure(
      importing
        ? input.sources.length === 0 && tokens.length > 0
        : tokens.length === 0 && (create ? input.sources.length === 0 : input.sources.length > 0),
      'Invalid operation source selection.',
    );
    const sources: OperationSource[] = [];
    for (const entry of input.sources) {
      ensure(
        entry && same(entry.target.checkout, input.checkout),
        'Source target belongs to another checkout.',
      );
      path(entry.target.path);
      const actual = await directory.entry(entry.target.path, signal);
      if (!same(actual, { identity: entry.identity, directory: entry.directory }))
        fail('Conflict', 'Source changed. Capture a fresh selection before continuing.');
      ensure(
        !sources.some(
          (s) => affected(entry.target.path, s.path) || affected(s.path, entry.target.path),
        ),
        'Overlapping sources are not one selection.',
      );
      sources.push({ path: entry.target.path, ...actual });
    }
    for (const { ref } of this.references.inspectReferences(
      tokens,
      input.checkout,
      input.clientId,
    )) {
      sources.push({
        path: ref.source.source,
        identity: ref.source.identity,
        directory: ref.source.directory,
        native: ref.source,
      });
    }
    if (create)
      sources.push({ path: '', identity: '', directory: input.kind === 'create-directory' });
    if (input.kind !== 'trash') path(input.destination, sources.length > 1);
    const destinations = sources.map((source) => {
      if (input.kind === 'trash') return undefined;
      if (sources.length === 1) return input.destination!;
      return join(input.destination!, basename(source.path));
    });
    if (sources.length > 1 && input.kind !== 'trash')
      ensure(
        (await directory.entry(input.destination!, signal)).directory,
        'Batch destination must be an existing folder.',
      );
    ensure(
      new Set(destinations.filter(Boolean).map((p) => folded(p!))).size ===
        destinations.filter(Boolean).length,
      'Selection has colliding destination names.',
    );
    const replacements = input.replacements ?? [];
    ensure(replacements.length <= sources.length, 'Invalid replacement selection.');
    const replacementDestinations = new Set<string>();
    for (const replacement of replacements) {
      ensure(
        replacement &&
          same(replacement.target.checkout, input.checkout) &&
          destinations.some(
            (destination) =>
              destination !== undefined &&
              dirname(destination) === dirname(replacement.target.path) &&
              folded(destination) === folded(replacement.target.path),
          ),
        'Replacement must name the exact captured destination.',
      );
      const destination = folded(replacement.target.path);
      ensure(
        !replacementDestinations.has(destination),
        'A destination cannot have multiple replacements.',
      );
      replacementDestinations.add(destination);
      const actual = await directory.entry(replacement.target.path, signal);
      if (!same(actual, { identity: replacement.identity, directory: replacement.directory }))
        fail('Conflict', 'Replacement changed. Confirm a freshly captured destination.');
      ensure(
        !sources.some((source) =>
          containsSelectedSource({ path: replacement.target.path, ...actual }, source),
        ),
        'A replacement cannot contain or replace a selected source.',
      );
    }
    const items = sources.map((source, i) => {
      const destination = destinations[i];
      const staging =
        destination && ['copy', 'import'].includes(input.kind)
          ? join(dirname(destination), '.moonbase-copy-' + randomUUID())
          : '';
      return { source, destination, staging };
    });
    for (const { source, destination } of items) {
      if (!destination) continue;
      path(destination);
      await directory.destination(destination);
      for (const selected of sources.filter((s) => s.native)) {
        const native = selected.native!;
        native.validate();
        ensure(
          !native.containsDirectory(resolve(input.checkout.root, dirname(destination))),
          'Choose a native import destination outside its source directory.',
        );
        let actual: Awaited<ReturnType<Directory['entry']>> | undefined;
        try {
          actual = await directory.entry(destination, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        ensure(
          !actual || !containsSelectedSource({ path: destination, ...actual }, selected),
          'A native import cannot replace itself or an ancestor of its source.',
        );
      }
      if (!source.native && !create)
        ensure(
          !affected(folded(destination), folded(source.path)) ||
            (input.kind === 'move' &&
              destination !== source.path &&
              folded(destination) === folded(source.path)),
          'Choose a destination outside the source.',
        );
      ensure(
        !sources.some(
          (s) => s.path !== source.path && affected(folded(destination), folded(s.path)),
        ),
        'Destination overlaps another selected source.',
      );
    }
    return { items, tokens, replacements };
  }
}
