import { normalizeApplicationError } from '@moonbase/effect';
import { type ApprovalSchema } from './schema.ts';
import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Scope } from 'effect';
import { decodeWorkspaceInput, decodeWorkspaceOutput } from '@moonbase/contracts/workspace-schema';
import { releaseResource } from '@moonbase/effect';
import { type WorkspaceServiceShape } from '@moonbase/contracts/services';
import {
  ApplicationError,
  type CheckoutTarget,
  type CommandInput,
  type CommandOutput,
  type OperationResult,
  type SaveResult,
  type WorkspaceCommand,
  type WorkspaceOperation,
} from '@moonbase/contracts/workspace';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { WorkspaceDiscovery } from './discovery.ts';
import { WorkspaceObservations } from './observations.ts';
import { Directory, identity, makeRunner } from './filesystem.ts';
import type { NativeImport } from './native-import.ts';
import { NativeReferences } from './native-references.ts';
import { WorkspaceWorktrees } from './worktrees.ts';
import {
  canonical,
  checkout,
  ensure,
  fail,
  hash,
  identifier,
  path,
  same,
  textDocument,
} from './validation.ts';

import type { WorkspaceConfiguration } from './index.ts';
import {
  key,
  affected,
  errorText,
  WorkspaceRecovery,
  type SaveRecord,
  type OperationRecord,
} from './recovery.ts';
type Approval = typeof ApprovalSchema.Type;
type OperationSource = {
  path: string;
  identity: string;
  directory: boolean;
  native?: NativeImport;
};
const folded = (p: string) => p.normalize('NFC').toLowerCase();
const containsSelectedSource = (
  entry: { path: string; identity: string; directory: boolean },
  source: { path: string; identity: string; native?: NativeImport },
) =>
  entry.identity === source.identity ||
  (entry.directory &&
    (source.native
      ? source.native.parents.split(',').includes(entry.identity)
      : affected(source.path, entry.path)));
const applicationError = (error: unknown, code: ApplicationError['code'] = 'Unavailable') =>
  ApplicationError.is(error)
    ? error
    : new ApplicationError({ code, message: normalizeApplicationError(error).message });

type WorkspaceOwnership = {
  operations: FiberSet.FiberSet<unknown, ApplicationError>;
  operationScope: Scope.Closeable;
  helperScope: Scope.Closeable;
  referenceScope: Scope.Closeable;
  observationScope: Scope.Closeable;
  runHelper: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  startExpiry: (effect: Effect.Effect<void>) => Fiber.Fiber<void>;
};

export class LocalWorkspace {
  readonly ownership: WorkspaceOwnership;
  readonly store: Store;
  readonly service: WorkspaceServiceShape;
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
  readonly recovery: WorkspaceRecovery;
  readonly run;
  readonly discovery: WorkspaceDiscovery;
  readonly worktrees: WorkspaceWorktrees;
  closed = false;
  readonly config: WorkspaceConfiguration;
  constructor(config: WorkspaceConfiguration, ownership: WorkspaceOwnership) {
    this.config = config;
    this.ownership = ownership;
    ensure(process.platform === 'darwin', 'Workspace native implementation requires macOS.');
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
      (root, source, signal) =>
        this.open(root, signal, { root, common: this.approval(source).common }),
      (root) => this.protected(root),
      (message) =>
        this.cleanupFailures.push(Cause.die(new ApplicationError({ code: 'Uncertain', message }))),
    );
    this.store = new Store(config.dataDirectory, config.hostId);
    this.run = makeRunner(helper, ownership.runHelper, (cause) => this.cleanupFailures.push(cause));
    this.recovery = new WorkspaceRecovery(
      this.store,
      (target) => this.directory(target),
      (checkoutId) => this.active(checkoutId),
      (target) => {
        this.approval(target);
      },
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
      (target) => this.approval(target).common.path,
      ownership.observationScope,
      (fn) => this.effect(fn),
      () => this.closed,
      (cause) => this.cleanupFailures.push(cause),
    );
    const call =
      <K extends WorkspaceCommand>(
        operation: K,
        fn: (input: CommandInput<K>, signal: AbortSignal) => Promise<CommandOutput<K>>,
        persistence = false,
        lease?: (input: CommandInput<K>) => { checkoutId: string; paths: string[] },
      ) =>
      (input: CommandInput<K>) =>
        Effect.flatMap(
          Effect.try({
            try: () => decodeWorkspaceInput(operation, input),
            catch: applicationError,
          }),
          (captured) =>
            this.effect(
              async (signal) => decodeWorkspaceOutput(operation, await fn(captured, signal)),
              persistence,
              lease?.(captured),
            ),
        );
    this.service = {
      openCheckout: call<'openCheckout'>('openCheckout', (input, signal) =>
        this.open(input.root, signal),
      ),
      readFile: call<'readFile'>('readFile', async (target, signal) =>
        (await this.directory(target.checkout)).read(target.path, signal),
      ),
      saveFile: (input) =>
        Effect.flatMap(
          Effect.try({
            try: () => ({
              input: decodeWorkspaceInput('saveFile', input),
              publication: this.recovery.getPublication(input.clientId),
            }),
            catch: applicationError,
          }),
          ({ input: captured, publication }) =>
            this.effect(
              async (signal) =>
                decodeWorkspaceOutput('saveFile', await this.save(captured, publication, signal)),
              false,
              { checkoutId: captured.target.checkout.checkoutId, paths: [captured.target.path] },
            ),
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
        this.worktrees.createWorktree(input, signal),
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
        async (input) => this.recovery.getOperationStatus(input),
        true,
      ),
      acknowledgeOperation: call<'acknowledgeOperation'>(
        'acknowledgeOperation',
        async (input) => this.recovery.acknowledgeOperation(input),
        true,
      ),
      loadRecovery: call<'loadRecovery'>(
        'loadRecovery',
        async (input) => this.recovery.loadRecovery(input.clientId),
        true,
      ),
      getRecoveryPublication: call<'getRecoveryPublication'>(
        'getRecoveryPublication',
        async (input) => this.recovery.getRecoveryPublication(input),
        true,
      ),
      persistRecovery: call<'persistRecovery'>(
        'persistRecovery',
        async (input, signal) => this.recovery.persistRecovery(input, signal),
        true,
      ),
      watch: (input) => this.observations.watch(input),
    };
  }
  effect<A>(
    fn: (signal: AbortSignal) => Promise<A>,
    persistence = false,
    lease?: { checkoutId: string; paths: string[] },
    abandoned?: (result: A) => void,
  ): Effect.Effect<A, ApplicationError> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen({ self: this }, function* () {
        if (this.closed)
          return yield* Effect.fail(
            new ApplicationError({ code: 'Unavailable', message: 'Workspace scope is closed.' }),
          );
        const abort = new AbortController();
        this.signals.add(abort);
        let result: { value: A } | undefined;
        const work = Effect.tryPromise({
          try: async () => {
            if (abort.signal.aborted)
              fail('Cancelled', 'Workspace command cancelled before admission.');
            const value = await fn(abort.signal);
            result = { value };
            if (abort.signal.aborted) abandoned?.(value);
            return value;
          },
          catch: (error) => applicationError(error, persistence ? 'Persistence' : 'Unavailable'),
        });
        // Raw OS Promises must settle before the lease, descriptors or Store can be released.
        const owned = (lease ? this.withLease(lease, abort.signal, work) : work).pipe(
          Effect.uninterruptible,
          Effect.ensuring(Effect.sync(() => this.signals.delete(abort))),
        );
        const fiber = yield* FiberSet.run(this.ownership.operations, owned);
        return yield* restore(Fiber.join(fiber)).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              abort.abort();
              if (abandoned) {
                yield* Fiber.await(fiber);
                if (result) yield* releaseResource(() => abandoned(result!.value));
              }
            }),
          ),
        );
      }),
    );
  }
  footprint(input: WorkspaceOperation) {
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
  overlaps(a: string[], b: string[]) {
    return a.some((p) =>
      b.some(
        (q) =>
          p === '' || q === '' || affected(folded(p), folded(q)) || affected(folded(q), folded(p)),
      ),
    );
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
        (active) =>
          active.checkoutId === lease.checkoutId && this.overlaps(lease.paths, active.paths),
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
  protected(root: string) {
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
  async directory(target: CheckoutTarget) {
    const approved = this.approval(target);
    let directory = this.directories.get(target.checkoutId);
    if (!directory) {
      ensure(
        this.directories.size < 128,
        'Open checkout resource limit reached. Restart after preserving recovery to release retained checkout descriptors.',
      );
      directory = new Directory(
        target.root,
        approved.identity,
        this.run,
        this.config.gitExecutable ?? '/usr/bin/git',
      );
      this.directories.set(target.checkoutId, directory);
    }
    directory.check();
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
    return directory;
  }
  gitEntry(root: string) {
    const fd = openSync(join(root, '.git'), constants.O_RDONLY | constants.O_NONBLOCK | 0x20000000);
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
   * Approves a checkout root. `created` names a worktree this workspace just made at exactly
   * `root`, in the repository whose common directory is `common`.
   */
  async open(
    root: string,
    signal: AbortSignal,
    created?: { root: string; common: { path: string; identity: string } },
  ) {
    ensure(
      typeof root === 'string' && isAbsolute(root) && !root.includes('\0'),
      'Choose an absolute checkout root through the native picker.',
    );
    root = realpathSync(root);
    if (created) ensure(root === created.root, 'The new worktree location changed. Inspect it.');
    this.protected(root);
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
    const id = identity(fstatSync(fd));
    closeSync(fd);
    const gitEntry = this.gitEntry(root);
    const directory = new Directory(
      root,
      id,
      this.run,
      this.config.gitExecutable ?? '/usr/bin/git',
    );
    try {
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
      const commonIdentity = identity(fstatSync(commonFd));
      const projectId = hash(canonical([this.config.hostId, common, commonIdentity]));
      closeSync(commonFd);
      if (created)
        ensure(
          common === created.common.path && commonIdentity === created.common.identity,
          'The new worktree belongs to another repository. Inspect it.',
        );
      const previous = this.store.all<Approval>('approvals').filter((a) => a.target.root === root);
      const current = previous.find((a) => a.identity === id && a.target.projectId === projectId);
      if (current) return current.target;
      // A worktree this workspace just made at a removed one's location is approved afresh; the
      // stale approval stays but matches nothing. Anywhere else a replaced directory is refused.
      ensure(
        !previous.length || created !== undefined,
        'Checkout or repository identity changed. Restore the original directory.',
      );
      const branch = await this.discovery.getBranch(directory, signal);
      const target = {
        hostId: this.config.hostId,
        checkoutId: hash(canonical([this.config.hostId, root, id])),
        projectId,
        root,
        branch,
        worktree: gitDirectory === common ? ('main' as const) : ('linked' as const),
      };
      this.store.put('approvals', target.checkoutId, {
        target,
        identity: id,
        common: { path: common, identity: commonIdentity },
        gitEntry,
      });
      return target;
    } finally {
      directory.close();
    }
  }
  assertSettled(target: CheckoutTarget, paths: string[], clientId: string) {
    if (
      this.recovery
        .getUnsettledOperations(target, clientId)
        .some(
          (r) =>
            r.input.checkout.checkoutId === target.checkoutId &&
            this.overlaps(paths, r.paths ?? this.footprint(r.input)) &&
            (!r.acknowledgedBy.includes(clientId) || r.result.outcome === 'uncertain'),
        ) ||
      this.recovery
        .getPendingSaves(target)
        .some(
          (r) =>
            r.input.target.checkout.checkoutId === target.checkoutId &&
            this.overlaps(paths, [r.input.target.path]) &&
            !r.result,
        )
    )
      fail(
        'Uncertain',
        'An operation awaits recovery publication or inspection. Query its status; do not repeat the mutation.',
      );
  }
  async save(
    input: CommandInput<'saveFile'>,
    publication: number,
    signal: AbortSignal,
  ): Promise<SaveResult> {
    identifier(input.clientId);
    identifier(input.requestId);
    path(input.target.path);
    this.approval(input.target.checkout);
    const proposed = textDocument(input.text);
    ensure(
      typeof input.expectedVersion === 'string' && /^[a-f0-9]{64}$/.test(input.expectedVersion),
      'Invalid expected content version.',
    );
    const id = key(input.clientId, input.requestId),
      previous = this.recovery.getSaveRecord(id);
    if (previous) return this.recovery.replaySave(id, input, previous);
    this.assertSettled(input.target.checkout, [input.target.path], input.clientId);
    const directory = await this.directory(input.target.checkout),
      disk = await directory.read(input.target.path, signal);
    if (signal.aborted) fail('Cancelled', 'Save cancelled before admission.');
    if (disk.version !== input.expectedVersion) {
      const result = { kind: 'conflict', disk } as const;
      const previous = this.recovery.reserveSave(id, {
        input,
        result,
        started: false,
      });
      return previous
        ? this.recovery.replaySave(id, input, this.recovery.getSaveRecord(id) ?? previous)
        : result;
    }
    const temporary = join(dirname(input.target.path), '.moonbase-save-' + randomUUID());
    const record: SaveRecord = {
      input,
      started: true,
      temporary,
      baseline: disk,
      recoveryPublication: publication,
    };
    const occupied = this.recovery.reserveSave(id, record);
    if (occupied)
      return this.recovery.replaySave(id, input, this.recovery.getSaveRecord(id) ?? occupied);
    this.recovery.startSave(id);
    try {
      const stagingIdentity = (
        await directory.io(['stage', input.target.path, temporary], input.text)
      ).toString();
      const current = await directory.read(input.target.path);
      if (current.version !== input.expectedVersion)
        record.result = { kind: 'conflict', disk: current };
      else {
        await directory.io(['replace', input.target.path, temporary, stagingIdentity]);
        record.result = { kind: 'saved', disk: proposed, recoveryChanges: [] };
      }
      try {
        this.recovery.publishSaves([record]);
      } catch (error) {
        if (record.result.kind === 'saved')
          record.result = {
            ...record.result,
            persistencePending: true,
            message: 'Saved to disk; durable request publication failed: ' + errorText(error),
          };
        this.recovery.retainSave(id, record);
      }
      return record.result;
    } catch (error) {
      record.message = errorText(error);
      this.recovery.retainSave(id, record);
      return fail(
        'Uncertain',
        'Save may have changed disk. Request retained; inspect disk and recovery. ' +
          errorText(error),
      );
    } finally {
      this.recovery.finishSave(id);
    }
  }
  async mutate(input: WorkspaceOperation, signal: AbortSignal): Promise<OperationResult> {
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
    const id = key(input.clientId, input.id),
      previous = this.recovery.getOperation(id);
    if (previous) return this.recovery.replayOperation(id, input, previous);
    this.assertSettled(input.checkout, this.footprint(input), input.clientId);
    if (signal.aborted) fail('Cancelled', 'Operation cancelled before admission.');
    const directory = await this.directory(input.checkout);
    const { items, tokens, replacements } = await this.prepareMutation(input, directory, signal);
    const create = input.kind.startsWith('create-');
    const importing = input.kind === 'import';
    const staging = items.map((item) => item.staging);
    const publicationRevisions = this.recovery.getPublicationRevisions(input);
    const record: OperationRecord = {
      input,
      paths: [
        ...input.sources.map((source) => source.target.path),
        ...items.flatMap((item) => (item.destination === undefined ? [] : [item.destination])),
      ],
      staging,
      publicationRevisions,
      acknowledgedBy: [],
      result: {
        id: input.id,
        clientId: input.clientId,
        recoveryChanges: [],
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
    const occupied = this.recovery.reserveOperation(id, record);
    if (occupied)
      return this.recovery.replayOperation(id, input, this.recovery.getOperation(id) ?? occupied);
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
            this.recovery.writeOperation(id, record);
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
            this.recovery.writeOperation(id, record);
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
          this.recovery.writeOperation(id, record);
        } catch (error) {
          record.result.message =
            'Filesystem outcome retained in memory; durable publication failed: ' +
            errorText(error);
          this.recovery.retainOperation(id, record);
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
        this.recovery.publishOperation(id, record);
      } catch (error) {
        this.recovery.retainPublication(id, record, error);
      }
      return record.result;
    } finally {
      this.references.releaseClaimedReferences(claims);
    }
  }
  private async prepareMutation(
    input: WorkspaceOperation,
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
      this.recovery.assertDestinationAvailable(
        input.checkout,
        (draftPath) =>
          affected(folded(draftPath), folded(destination)) &&
          (!!source.native || !affected(draftPath, source.path)),
      );
    }
    return { items, tokens, replacements };
  }
}
