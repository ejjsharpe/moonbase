import { normalizeApplicationError } from '@moonbase/application/effect-client';
import { type ApprovalSchema, parseRecovery } from './schema.ts';
import { Cause, Deferred, Effect, Exit, Fiber, FiberSet, Queue, Scope, Stream } from 'effect';
import {
  decodeWorkspaceInput,
  decodeWorkspaceOutput,
  decodeWorkspaceEvent,
  decodeWorkspaceWatchInput,
} from '@moonbase/application/workspace-schema';
import { releaseResource, type WorkspaceServiceShape } from '@moonbase/application/services';
import {
  ApplicationError,
  type CheckoutTarget,
  type CommandInput,
  type CommandOutput,
  type EditorRecovery,
  type OperationResult,
  type SaveResult,
  type WorkspaceCommand,
  type WorkspaceOperation,
} from '@moonbase/application/client';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  watch as fsWatch,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store, pendingSaves } from './store.ts';
import { matchPath, compareMatches } from './lookup.ts';
import { Directory, identity, makeRunner } from './filesystem.ts';
import { NativeImport } from './native-import.ts';
import {
  canonical,
  checkout,
  document,
  ensure,
  fail,
  hash,
  identifier,
  path,
  recovery,
  same,
  textDocument,
} from './validation.ts';

import type { WorkspaceConfiguration } from './index.ts';
import {
  key,
  affected,
  errorText,
  reconcile,
  retainPublication,
  publishOperation,
  publishSaves,
  recoverEvidence,
  load,
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
  readonly subscriptions = new Set<Scope.Closeable>();
  readonly signals = new Set<AbortController>();
  readonly leases = new Set<{
    checkoutId: string;
    paths: string[];
    done: Deferred.Deferred<void>;
  }>();
  readonly cleanupFailures: Cause.Cause<never>[] = [];
  readonly closeCompletion = Deferred.makeUnsafe<void>();
  closing = false;
  readonly native = new Map<
    string,
    {
      source: NativeImport;
      clientId: string;
      checkout: CheckoutTarget;
      claimed: Deferred.Deferred<void>;
    }
  >();
  activeNative = 0;
  capturing = 0;
  readonly volatileSaves = new Map<string, SaveRecord>();
  readonly activeSaves = new Set<string>();
  readonly volatileOperations = new Map<string, OperationRecord>();
  readonly run;
  readonly ripgrep: string | undefined;
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
    this.ripgrep =
      config.ripgrepExecutable ??
      (process.env.PATH ?? '')
        .split(':')
        .map((p) => join(p, 'rg'))
        .find((p) => {
          try {
            accessSync(p, constants.X_OK);
            return isAbsolute(p);
          } catch {
            return false;
          }
        });
    ensure(
      this.ripgrep === undefined || isAbsolute(this.ripgrep),
      'Ripgrep executable must be absolute.',
    );
    this.store = new Store(config.dataDirectory, config.hostId);
    this.run = makeRunner(helper, ownership.runHelper, (cause) => this.cleanupFailures.push(cause));
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
              publication: this.store.publication(input.clientId),
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
        this.list(input, signal),
      ),
      gitStatus: call<'gitStatus'>('gitStatus', (input, signal) =>
        this.status(input.checkout, signal),
      ),
      readComparison: call<'readComparison'>('readComparison', (input, signal) =>
        this.comparison(input, signal),
      ),
      lookupFiles: call<'lookupFiles'>('lookupFiles', (input, signal) =>
        this.lookup(input, signal),
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
        async (input) => {
          identifier(input.clientId);
          identifier(input.id);
          await this.recoverEvidence();
          return this.operation(key(input.clientId, input.id))?.result ?? null;
        },
        true,
      ),
      acknowledgeOperation: call<'acknowledgeOperation'>(
        'acknowledgeOperation',
        async (input) => {
          identifier(input.clientId);
          identifier(input.operationClientId);
          identifier(input.id);
          const id = key(input.operationClientId, input.id),
            record = this.operation(id);
          if (!record || record.acknowledgedBy.includes(input.clientId)) return;
          const observation = this.store.readRecovery(input.clientId);
          if (
            input.clientId !== input.operationClientId &&
            !(observation?.state as EditorRecovery | undefined)?.checkouts.some((c) =>
              same(c, record.input.checkout),
            )
          )
            fail('Unauthorized', 'Observer has not opened this exact checkout.');
          if (
            record.publicationError ||
            record.result.items.some(
              (item) =>
                item.outcome === 'completed' &&
                !(record.publishedItems ?? []).includes(canonical(item)),
            )
          )
            fail(
              'Persistence',
              'Known operation recovery publication is pending. Preserve the prior valid snapshot before acknowledgement.',
            );
          if (record.result.outcome === 'uncertain')
            fail(
              'Uncertain',
              'Uncertain operation evidence cannot be acknowledged away. Inspect the affected paths.',
            );
          if (
            this.store.publication(input.clientId) <=
            (record.publicationRevisions[input.clientId] ?? observation?.revision ?? 0)
          )
            fail('Persistence', 'Publish reconciled recovery before acknowledging this operation.');
          this.store.put('operations', id, {
            ...record,
            acknowledgedBy: [...record.acknowledgedBy, input.clientId],
          });
          this.volatileOperations.delete(id);
        },
        true,
      ),
      loadRecovery: call<'loadRecovery'>(
        'loadRecovery',
        async (input) => this.load(input.clientId),
        true,
      ),
      getRecoveryPublication: call<'getRecoveryPublication'>(
        'getRecoveryPublication',
        async (input) => {
          identifier(input.clientId);
          identifier(input.requestId);
          return this.store.recoveryPublication(input.clientId, input.requestId)?.receipt ?? null;
        },
        true,
      ),
      persistRecovery: call<'persistRecovery'>(
        'persistRecovery',
        async (input, signal) => {
          identifier(input.clientId);
          identifier(input.requestId);
          ensure(
            Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0,
            'Invalid recovery revision.',
          );
          recovery(input.state, input.clientId);
          if (signal.aborted) fail('Cancelled', 'Recovery publication cancelled before commit.');
          const digest = hash(canonical(input)),
            previous = this.store.replayPublication(input, digest);
          if (previous) return previous;
          for (const target of input.state.checkouts) this.approval(target);
          const state = structuredClone(input.state);
          const retained = this.store.readRecovery(input.clientId)?.state as
            | EditorRecovery
            | undefined;
          for (const record of this.operations(
            "json_extract(body, '$.result.outcome') = 'uncertain'",
          ).filter((r) => r.result.outcome === 'uncertain')) {
            for (const draft of retained?.drafts ?? [])
              if (
                same(draft.target.checkout, record.input.checkout) &&
                record.input.sources.some((s) => affected(draft.target.path, s.target.path))
              )
                if (!state.drafts.some((d) => same(d.target, draft.target)))
                  fail(
                    'Persistence',
                    'An uncertain operation still owns this recovery draft. Inspect/reconcile the original paths before discarding it.',
                  );
          }
          return this.store.persist(input, digest);
        },
        true,
      ),
      watch: (input) => this.watch(input),
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
      : (input.nativeReferences ?? []).map((token) => this.native.get(token)?.source.source ?? '');
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
          Scope.close(this.ownership.observationScope, Exit.void),
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
  async open(root: string, signal: AbortSignal) {
    ensure(
      typeof root === 'string' && isAbsolute(root) && !root.includes('\0'),
      'Choose an absolute checkout root through the native picker.',
    );
    root = realpathSync(root);
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
      const common = realpathSync(
        resolve(
          root,
          (await directory.git(['rev-parse', '--git-common-dir'], undefined, signal))
            .toString()
            .trim(),
        ),
      );
      const commonFd = openSync(common, constants.O_RDONLY | constants.O_DIRECTORY | 0x20000000);
      const commonIdentity = identity(fstatSync(commonFd));
      const projectId = hash(canonical([this.config.hostId, common, commonIdentity]));
      closeSync(commonFd);
      const previous = this.store.all<Approval>('approvals').find((a) => a.target.root === root);
      if (previous) {
        ensure(
          previous.identity === id && previous.target.projectId === projectId,
          'Checkout or repository identity changed. Restore the original directory.',
        );
        return previous.target;
      }
      const branch = await this.branch(directory, signal);
      const target = {
        hostId: this.config.hostId,
        checkoutId: hash(canonical([this.config.hostId, root, id])),
        projectId,
        root,
        branch,
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
  async branch(directory: Directory, signal?: AbortSignal) {
    try {
      return (await directory.git(['symbolic-ref', '--short', 'HEAD'], undefined, signal))
        .toString()
        .trim();
    } catch {
      return (
        (await directory.git(['rev-parse', '--short', 'HEAD'], undefined, signal))
          .toString()
          .trim() + ' (detached)'
      );
    }
  }
  saveRecord(id: string) {
    return this.volatileSaves.get(id) ?? this.store.get<SaveRecord>('saves', id);
  }
  saveRecords(clientId?: string) {
    const records = new Map(
      this.store
        .all<SaveRecord>(
          'saves',
          pendingSaves + (clientId ? " AND json_extract(body, '$.input.clientId') = ?" : ''),
          clientId ? [clientId] : [],
        )
        .map((record) => [key(record.input.clientId, record.input.requestId), record]),
    );
    for (const [id, record] of this.volatileSaves) records.set(id, record);
    return [...records.values()];
  }
  operation(id: string) {
    return this.volatileOperations.get(id) ?? this.store.get<OperationRecord>('operations', id);
  }
  operations(predicate = '1', parameters: string[] = []) {
    const records = new Map(
      this.store
        .all<OperationRecord>('operations', predicate, parameters)
        .map((r) => [key(r.input.clientId, r.input.id), r]),
    );
    for (const [id, record] of this.volatileOperations) records.set(id, record);
    return [...records.values()];
  }
  assertSettled(target: CheckoutTarget, paths: string[], clientId: string) {
    if (
      this.operations(
        "json_extract(body, '$.input.checkout.checkoutId') = ? AND (json_extract(body, '$.result.outcome') = 'uncertain' OR NOT EXISTS (SELECT 1 FROM json_each(body, '$.acknowledgedBy') WHERE value = ?))",
        [target.checkoutId, clientId],
      ).some(
        (r) =>
          r.input.checkout.checkoutId === target.checkoutId &&
          this.overlaps(paths, r.paths ?? this.footprint(r.input)) &&
          (!r.acknowledgedBy.includes(clientId) || r.result.outcome === 'uncertain'),
      ) ||
      this.store
        .all<SaveRecord>(
          'saves',
          pendingSaves +
            " AND json_extract(body, '$.result') IS NULL AND json_extract(body, '$.input.target.checkout.checkoutId') = ?",
          [target.checkoutId],
        )
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
  replaySave(id: string, input: CommandInput<'saveFile'>, record: SaveRecord): SaveResult {
    if (!same(record.input, input))
      fail('Conflict', 'Save request ID already belongs to a different payload or target.');
    if (record.result) {
      if (this.volatileSaves.has(id) || record.restorePending) {
        try {
          this.publishSaves([record]);
        } catch (error) {
          if (record.result.kind !== 'saved')
            return fail(
              'Persistence',
              'Admitted Save recovery publication pending; previous valid snapshot retained. ' +
                errorText(error),
            );
          record.result = {
            ...record.result,
            persistencePending: true,
            message: 'Saved to disk; recovery publication pending. ' + errorText(error),
          };
        }
      }
      return record.result;
    }
    return fail(
      'Uncertain',
      'Interrupted save retained its intent. Inspect disk and recovered draft before a new deliberate save.',
    );
  }
  replayOperation(id: string, input: WorkspaceOperation, record: OperationRecord) {
    if (!same(record.input, input))
      fail('Conflict', 'Operation ID already belongs to another payload/client/checkout.');
    if (this.volatileOperations.has(id)) {
      try {
        this.publishOperation(id, record);
      } catch (error) {
        this.retainPublication(id, record, error);
      }
    }
    return record.result;
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
      previous = this.saveRecord(id);
    if (previous) return this.replaySave(id, input, previous);
    this.assertSettled(input.target.checkout, [input.target.path], input.clientId);
    const directory = await this.directory(input.target.checkout),
      disk = await directory.read(input.target.path, signal);
    if (signal.aborted) fail('Cancelled', 'Save cancelled before admission.');
    if (disk.version !== input.expectedVersion) {
      const result = { kind: 'conflict', disk } as const;
      const previous = this.store.reserve<SaveRecord>('saves', id, {
        input,
        result,
        started: false,
      });
      return previous ? this.replaySave(id, input, this.saveRecord(id) ?? previous) : result;
    }
    const temporary = join(dirname(input.target.path), '.moonbase-save-' + randomUUID());
    const record: SaveRecord = {
      input,
      started: true,
      temporary,
      baseline: disk,
      recoveryPublication: publication,
    };
    const occupied = this.store.reserve('saves', id, record);
    if (occupied) return this.replaySave(id, input, this.saveRecord(id) ?? occupied);
    this.activeSaves.add(id);
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
        this.publishSaves([record]);
      } catch (error) {
        if (record.result.kind === 'saved')
          record.result = {
            ...record.result,
            persistencePending: true,
            message: 'Saved to disk; durable request publication failed: ' + errorText(error),
          };
        this.volatileSaves.set(id, record);
      }
      return record.result;
    } catch (error) {
      record.message = errorText(error);
      this.volatileSaves.set(id, record);
      return fail(
        'Uncertain',
        'Save may have changed disk. Request retained; inspect disk and recovery. ' +
          errorText(error),
      );
    } finally {
      this.activeSaves.delete(id);
    }
  }
  release(input: { checkout: CheckoutTarget; clientId: string; references: string[] }) {
    identifier(input.clientId);
    checkout(input.checkout);
    ensure(
      Array.isArray(input.references) &&
        input.references.length <= 128 &&
        new Set(input.references).size === input.references.length &&
        input.references.every(
          (token) => typeof token === 'string' && token.length > 0 && token.length <= 160,
        ),
      'Invalid native release references.',
    );
    const known = input.references.filter((token) => this.native.has(token));
    for (const token of known) {
      const entry = this.native.get(token)!;
      if (entry.clientId !== input.clientId || !same(entry.checkout, input.checkout))
        fail('Unauthorized', 'Native reference belongs to another client/checkout.');
    }
    if (known.length) this.approval(input.checkout);
    const failures: string[] = [];
    for (const token of known) {
      try {
        this.releaseNative(token);
      } catch {
        failures.push('Native reference cleanup failed.');
      }
    }
    if (failures.length) {
      const error = new ApplicationError({ code: 'Unavailable', message: failures.join('; ') });
      this.cleanupFailures.push(Cause.die(error));
      throw error;
    }
  }
  async capture(
    input: { checkout: CheckoutTarget; clientId: string; paths: string[] },
    signal: AbortSignal,
  ) {
    identifier(input.clientId);
    const directory = await this.directory(input.checkout);
    ensure(
      Array.isArray(input.paths) &&
        input.paths.length > 0 &&
        input.paths.length <= 128 &&
        this.native.size + this.activeNative + this.capturing + input.paths.length <= 256,
      'Native import selection limit reached.',
    );
    const references: string[] = [];
    this.capturing += input.paths.length;
    try {
      for (const p of input.paths) {
        const source = new NativeImport(p, (p) => this.protected(p));
        try {
          await directory.io(['import-check', source.path, source.parents], undefined, signal, [
            source.fd,
          ]);
          const token = randomUUID();
          const claimed = Deferred.makeUnsafe<void>();
          this.native.set(token, {
            source,
            clientId: input.clientId,
            checkout: input.checkout,
            claimed,
          });
          references.push(token);
          this.ownership.startExpiry(
            Effect.raceFirst(Effect.sleep('5 minutes'), Deferred.await(claimed)).pipe(
              Effect.ensuring(
                releaseResource(() => this.releaseNative(token)).pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (Exit.isFailure(exit)) this.cleanupFailures.push(exit.cause);
                    }),
                  ),
                ),
              ),
            ),
          );
        } catch (error) {
          try {
            source.close();
          } catch {
            this.cleanupFailures.push(
              Cause.die(
                new ApplicationError({
                  code: 'Unavailable',
                  message: 'Native capture cleanup failed.',
                }),
              ),
            );
          }
          throw error;
        }
      }
      if (signal.aborted || this.closed)
        fail('Cancelled', 'Native capture cancelled before handoff.');
      return references;
    } catch (error) {
      for (const token of references) {
        try {
          this.releaseNative(token);
        } catch (error) {
          this.cleanupFailures.push(Cause.die(applicationError(error)));
        }
      }
      throw error;
    } finally {
      this.capturing -= input.paths.length;
    }
  }
  releaseNative(token: string) {
    const entry = this.native.get(token);
    if (entry) {
      this.native.delete(token);
      Deferred.doneUnsafe(entry.claimed, Effect.void);
      entry.source.close();
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
      previous = this.operation(id);
    if (previous) return this.replayOperation(id, input, previous);
    this.assertSettled(input.checkout, this.footprint(input), input.clientId);
    if (signal.aborted) fail('Cancelled', 'Operation cancelled before admission.');
    const directory = await this.directory(input.checkout);
    const { items, tokens, replacements } = await this.prepareMutation(input, directory, signal);
    const create = input.kind.startsWith('create-');
    const importing = input.kind === 'import';
    const staging = items.map((item) => item.staging);
    const publicationRevisions: Record<string, number> = {
      [input.clientId]: this.store.readRecovery(input.clientId)?.revision ?? 0,
    };
    for (const row of this.store.db.prepare('SELECT client, revision, body FROM recovery').all())
      if (
        parseRecovery(row.body as string, row.client as string).checkouts.some((c) =>
          same(c, input.checkout),
        )
      )
        publicationRevisions[row.client as string] = Number(row.revision);
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
    const claims = tokens.map((token) => {
      const ref = this.native.get(token);
      if (!ref || ref.clientId !== input.clientId || !same(ref.checkout, input.checkout))
        fail(
          'Unauthorized',
          'Native reference expired, used or belongs to another client/checkout.',
        );
      ref!.source.validate();
      return { token, ref: ref! };
    });
    const occupied = this.store.reserve('operations', id, record);
    if (occupied) return this.replayOperation(id, input, this.operation(id) ?? occupied);
    for (const { token, ref } of claims) {
      this.native.delete(token);
      Deferred.doneUnsafe(ref.claimed, Effect.void);
    }
    this.activeNative += claims.length;
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
        const replacement = replacements.find((r) => r.target.path === destination);
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
            this.store.put('operations', id, record);
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
            this.store.put('operations', id, record);
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
          this.store.put('operations', id, record);
        } catch (error) {
          record.result.message =
            'Filesystem outcome retained in memory; durable publication failed: ' +
            errorText(error);
          this.volatileOperations.set(id, record);
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
        this.publishOperation(id, record);
      } catch (error) {
        this.retainPublication(id, record, error);
      }
      return record.result;
    } finally {
      this.activeNative -= claims.length;
      const failures: string[] = [];
      for (const { ref } of claims) {
        try {
          ref.source.close();
        } catch {
          failures.push('Claimed native reference cleanup failed.');
        }
      }
      if (failures.length)
        this.cleanupFailures.push(
          Cause.die(new ApplicationError({ code: 'Unavailable', message: failures.join('; ') })),
        );
      if (failures.length) fail('Unavailable', failures.join('; '));
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
    for (const token of tokens) {
      const ref = this.native.get(token);
      if (!ref || ref.clientId !== input.clientId || !same(ref.checkout, input.checkout))
        fail(
          'Unauthorized',
          'Native reference expired, used or belongs to another client/checkout.',
        );
      const captured = ref!;
      captured.source.validate();
      sources.push({
        path: captured.source.source,
        identity: captured.source.identity,
        directory: captured.source.directory,
        native: captured.source,
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
    for (const replacement of replacements) {
      ensure(
        replacement &&
          same(replacement.target.checkout, input.checkout) &&
          destinations.includes(replacement.target.path),
        'Replacement must name the exact captured destination.',
      );
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
      for (const row of this.store.db.prepare('SELECT client, body FROM recovery').all()) {
        const state = parseRecovery(row.body as string, row.client as string);
        ensure(
          !state.drafts.some(
            (d) =>
              d.target.checkout.checkoutId === input.checkout.checkoutId &&
              affected(folded(d.target.path), folded(destination)) &&
              (source.native || !affected(d.target.path, source.path)),
          ),
          'Destination has recovery drafts. Preserve them before replacement.',
        );
      }
    }
    return { items, tokens, replacements };
  }
  reconcile = reconcile;
  retainPublication = retainPublication;
  publishOperation = publishOperation;
  publishSaves = publishSaves;
  recoverEvidence = recoverEvidence;
  load = load;
  async list(input: CommandInput<'listDirectory'>, signal: AbortSignal) {
    path(input.path, true);
    const directory = await this.directory(input.checkout);
    await directory.entry(input.path, signal);
    const entries = (await directory.io(['list', input.path || '.'], undefined, signal))
      .toString()
      .split('\0')
      .filter(Boolean)
      .slice(0, 20000)
      .map((row) => ({
        path: input.path ? input.path + '/' + row.slice(1) : row.slice(1),
        directory: row[0] === 'd',
        ignored: false,
      }));
    let error: string | undefined;
    try {
      this.policy(input.checkout);
      const output = await directory
        .io(
          [
            'lookup',
            this.config.gitExecutable ?? '/usr/bin/git',
            '-c',
            'core.excludesFile=/dev/null',
            'check-ignore',
            '-z',
            '--stdin',
          ],
          entries.map((e) => e.path).join('\0') + (entries.length ? '\0' : ''),
          signal,
        )
        .catch((error) => {
          if (error.status === 1) return Buffer.alloc(0);
          throw error;
        });
      const ignored = new Set(output.toString().split('\0'));
      entries.forEach((e) => {
        e.ignored = ignored.has(e.path);
      });
    } catch (failure) {
      error = 'Git ignore policy unavailable; all entries shown. ' + errorText(failure);
    }
    return {
      entries: entries
        .filter((e) => !input.hideIgnored || !e.ignored)
        .sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path)),
      partial: entries.length === 20000 || !!error,
      error,
    };
  }
  async status(target: CheckoutTarget, signal: AbortSignal) {
    const directory = await this.directory(target);
    try {
      const records = (
        await directory.git(
          ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
          undefined,
          signal,
        )
      )
        .toString()
        .split('\0')
        .filter(Boolean);
      const changes: CommandOutput<'gitStatus'>['changes'] = [];
      for (const row of records) {
        const p = row.slice(3);
        path(p);
        if (row.startsWith('??')) changes.push({ path: p, area: 'untracked' });
        else {
          if (row[0] !== ' ') changes.push({ path: p, area: 'staged' });
          if (row[1] !== ' ') changes.push({ path: p, area: 'unstaged' });
        }
      }
      return { branch: await this.branch(directory, signal), changes };
    } catch (error) {
      return {
        branch: target.branch,
        changes: [],
        error: 'Git status unavailable. ' + errorText(error),
      };
    }
  }
  async comparison(input: CommandInput<'readComparison'>, signal: AbortSignal) {
    path(input.target.path);
    ensure(['staged', 'unstaged', 'untracked'].includes(input.area), 'Invalid comparison area.');
    const directory = await this.directory(input.target.checkout),
      p = input.target.path;
    let working = null;
    try {
      working = await directory.read(p, signal);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        !(error as { stderr?: string }).stderr?.includes('No such file')
      )
        throw error;
    }
    try {
      let original = '';
      if (input.area === 'staged') {
        const exists = await directory
          .git(['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, signal)
          .then(() => true)
          .catch((error) => {
            if (error.status === 1) return false;
            throw error;
          });
        const entries = exists
          ? (await directory.git(['ls-tree', '-z', 'HEAD', '--', p], undefined, signal)).toString()
          : '';
        if (entries)
          original = document(
            await directory.git(
              ['cat-file', 'blob', entries.split(' ')[2].split('\t')[0]],
              undefined,
              signal,
            ),
          ).text;
      } else if (input.area === 'unstaged') {
        const entries = (
          await directory.git(['ls-files', '--stage', '-z', '--', p], undefined, signal)
        ).toString();
        if (entries) {
          const rows = entries.split('\0').filter(Boolean);
          const stage = rows.find((row) => row.split(' ')[2]?.startsWith('0\t'));
          if (!stage)
            fail(
              'Unavailable',
              'Index contains unresolved merge stages; no single index baseline is available.',
            );
          original = document(
            await directory.git(['cat-file', 'blob', stage!.split(' ')[1]], undefined, signal),
          ).text;
        }
      }
      let title = 'Untracked file';
      if (input.area === 'staged') title = 'HEAD ↔ working buffer';
      else if (input.area === 'unstaged') title = 'Index ↔ working buffer';
      return { original, working, title };
    } catch (error) {
      return {
        original: '',
        working,
        title: input.area,
        error: 'Git comparison unavailable. ' + errorText(error),
      };
    }
  }
  async lookup(input: CommandInput<'lookupFiles'>, signal: AbortSignal) {
    ensure(
      typeof input.query === 'string' &&
        input.query.length <= 256 &&
        !input.query.includes('\0') &&
        (input.limit === undefined ||
          (Number.isInteger(input.limit) && input.limit > 0 && input.limit <= 100)),
      'Invalid lookup query/limit.',
    );
    const directory = await this.directory(input.checkout),
      limit = input.limit ?? 100;
    const supplied = input.history ?? [];
    ensure(
      Array.isArray(supplied) &&
        supplied.length <= 1000 &&
        supplied.reduce((n, p) => n + (typeof p === 'string' ? p.length : 1000000), 0) <=
          256 * 1024,
      'Lookup history exceeds its limit.',
    );
    supplied.forEach((p) => path(p));
    const excluded = (p: string) =>
      [
        '.git',
        '.svn',
        '.hg',
        '.jj',
        '.DS_Store',
        'Thumbs.db',
        'node_modules',
        'bower_components',
      ].includes(p) || p.endsWith('.code-search');
    let cells = 0,
      partial = false;
    const rank = (paths: string[], history: boolean) => {
      const matches = [];
      for (const p of new Set(paths)) {
        if (history ? excluded(basename(p)) : p.split('/').some(excluded)) continue;
        cells += p.length * Math.max(input.query.length, 1);
        if (cells > 16 * 1024 * 1024) {
          partial = true;
          break;
        }
        const match = matchPath(p, input.query);
        if (match) matches.push(match);
      }
      matches.sort(compareMatches);
      if (matches.length > limit) partial = true;
      return matches.slice(0, limit);
    };
    const history = rank(supplied, true);
    if (!input.query.trim()) return { matches: [], history, partial };
    try {
      this.policy(input.checkout);
      if (!this.ripgrep)
        fail(
          'Unavailable',
          'Standalone ripgrep is unavailable. Supply the packaged ripgrepExecutable asset.',
        );
      const args = [
        '--files',
        '--hidden',
        '--null',
        '--no-config',
        '--no-ignore-parent',
        '--no-ignore-global',
        '--threads',
        '1',
      ];
      for (const name of [
        '.git',
        '.svn',
        '.hg',
        '.jj',
        '.DS_Store',
        'Thumbs.db',
        'node_modules',
        'bower_components',
        '*.code-search',
      ])
        args.push('--glob', '!**/' + name);
      let enumerationError: string | undefined;
      const bytes = await directory
        .io(['lookup', this.ripgrep!, ...args, '.'], undefined, signal)
        .catch((error) => {
          const output = (error as { output?: Buffer }).output;
          if (output?.length && output.lastIndexOf(0) >= 0) {
            partial = true;
            enumerationError = errorText(error);
            return output.subarray(0, output.lastIndexOf(0) + 1);
          }
          if (error.status === 1 && !error.stderr) return Buffer.alloc(0);
          throw error;
        });
      const candidates = [
        ...new Set(
          bytes
            .toString()
            .split('\0')
            .filter(Boolean)
            .map((p) => p.replace(/^\.\//, '')),
        ),
      ];
      if (candidates.length > 20000) partial = true;
      const eligible: string[] = [],
        spellings = new Map<string, Set<string>>();
      for (const p of candidates.slice(0, 20000)) {
        if (signal.aborted) fail('Cancelled', 'Lookup cancelled.');
        path(p);
        try {
          if (!(await directory.entry(p, signal, spellings)).directory) eligible.push(p);
        } catch {
          partial = true;
        }
        if (eligible.length % 32 === 0) await new Promise<void>((done) => setImmediate(done));
      }
      // Exact entered paths have a scoped no-follow exception to discovery ignore/exclusions.
      try {
        path(input.query);
        if (
          !(await directory.entry(input.query, signal)).directory &&
          !eligible.includes(input.query)
        )
          eligible.unshift(input.query);
      } catch {
        /* Ordinary fuzzy queries need not be exact paths. */
      }
      const recent = new Set(history.map((match) => match.path));
      const exact = eligible[0] === input.query ? matchPath(input.query, input.query) : null;
      const matches = rank(
        eligible.filter((p) => !recent.has(p)),
        false,
      );
      if (exact && !recent.has(exact.path) && !matches.some((m) => m.path === exact.path)) {
        matches.unshift(exact);
        if (matches.length > limit) {
          matches.pop();
          partial = true;
        }
      }
      return {
        matches,
        history,
        partial,
        ...(partial
          ? { error: enumerationError ?? 'Discovery or ranking capped; refine query.' }
          : {}),
      };
    } catch (error) {
      return {
        matches: [],
        history,
        partial: true,
        error: 'Discovery or ignore policy unavailable. ' + errorText(error),
      };
    }
  }
  watch(input: { checkout: CheckoutTarget; paths: string[] }) {
    // oxlint-disable-next-line no-this-alias -- The Effect generator retains this workspace owner.
    const self = this;
    return Stream.unwrap(
      Effect.gen(function* () {
        const captured = yield* Effect.try({
          try: () => decodeWorkspaceWatchInput(input),
          catch: applicationError,
        });
        const scope = yield* Effect.acquireRelease(
          Scope.fork(self.ownership.observationScope, 'parallel'),
          (scope) => Scope.close(scope, Exit.void),
        );
        const changes = yield* Queue.sliding<boolean>(1);
        let disposed = false,
          error: string | undefined;
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            disposed = true;
            self.subscriptions.delete(scope);
            Queue.shutdownUnsafe(changes);
          }),
        );
        yield* Effect.try({
          try: () => {
            ensure(
              !self.closed &&
                captured.paths.length > 0 &&
                captured.paths.length <= 128 &&
                self.subscriptions.size < 64,
              'Watch subscription limit reached.',
            );
            self.subscriptions.add(scope);
          },
          catch: applicationError,
        });
        const directory = yield* self.effect(() => self.directory(captured.checkout));
        const changed = (failure?: string) => {
          if (disposed || self.closed) return;
          error = failure ?? error;
          Queue.offerUnsafe(changes, true);
        };
        const acquire = (path: string) =>
          Effect.acquireRelease(
            Effect.try({
              try: () => {
                const closed = Deferred.makeUnsafe<void>();
                const watcher = fsWatch(path, { persistent: false, recursive: true }, () =>
                  changed(),
                ).on('error', (error) => {
                  changed(errorText(error));
                  // Node stops a failed watcher without guaranteeing a later close event.
                  Deferred.doneUnsafe(closed, Effect.void);
                });
                watcher.once('close', () => Deferred.doneUnsafe(closed, Effect.void));
                return { watcher, closed };
              },
              catch: applicationError,
            }),
            ({ watcher, closed }) =>
              Effect.gen(function* () {
                yield* releaseResource(() => watcher.close());
                yield* Deferred.await(closed);
                yield* Effect.sync(() => watcher.removeAllListeners());
              }),
          ).pipe(Scope.provide(scope));
        for (const p of new Set(captured.paths)) {
          yield* Effect.try({ try: () => path(p, true), catch: applicationError });
          const before = yield* self.effect(() => directory.entry(p));
          yield* Effect.try({
            try: () =>
              ensure(
                before.directory,
                'Watch directory paths, including parent directories of files.',
              ),
            catch: applicationError,
          });
          yield* acquire(resolve(directory.root, p));
          const after = yield* self.effect(() => directory.entry(p));
          yield* Effect.try({
            try: () => ensure(same(before, after), 'Watch directory changed during subscription.'),
            catch: applicationError,
          });
        }
        const common = self.approval(captured.checkout).common.path;
        if (!common.startsWith(directory.root + '/')) yield* acquire(common);
        const events = Stream.fromQueue(changes).pipe(
          Stream.debounce('100 millis'),
          Stream.map(() => {
            try {
              directory.check();
            } catch (failure) {
              error = errorText(failure);
            }
            const event = decodeWorkspaceEvent({ ...captured, error });
            error = undefined;
            return event;
          }),
        );
        return Stream.concat(
          Stream.succeed(decodeWorkspaceEvent({ ...captured, ready: true })),
          events,
        );
      }),
    );
  }
}
