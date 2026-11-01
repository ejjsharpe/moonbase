import { Effect, Exit, Fiber, Scope } from 'effect';
import {
  ApplicationError,
  type CheckoutTarget,
  type EntryReference,
  type LookupMatch,
  type CommandOutput,
  type WorkspaceOperation,
  type OperationResult,
} from '@moonbase/application/client';
import { fileKey } from './references.ts';

type Run = <A>(effect: Effect.Effect<A, ApplicationError>) => Promise<A>;
export type LookupRow = LookupMatch & { checkout: CheckoutTarget; recent: boolean };
export type LookupSnapshot = { rows: LookupRow[]; message: string; busy: boolean };

/** A popup owns queries; replacing it cannot replace a captured editor mutation. */
export class EditorLookup {
  private scope: Scope.Closeable;
  private queryScope?: Scope.Closeable;
  private generation = 0;
  private closed = false;
  private completion?: Promise<void>;
  private listeners = new Set<() => void>();
  private snapshot: LookupSnapshot = { rows: [], message: 'Type a filename or path.', busy: false };
  private execute: Run;
  private search: (
    checkout: CheckoutTarget,
    query: string,
    signal: AbortSignal,
  ) => Promise<CommandOutput<'lookupFiles'>>;
  constructor(scope: Scope.Scope, execute: Run, search: EditorLookup['search']) {
    this.scope = Scope.forkUnsafe(scope);
    this.execute = execute;
    this.search = search;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<LookupSnapshot>) {
    if (this.closed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  query(query: string, checkouts: CheckoutTarget[]) {
    if (this.closed) return;
    const generation = ++this.generation;
    const previous = this.queryScope;
    const scope = (this.queryScope = Scope.forkUnsafe(this.scope));
    this.update({ rows: [], message: 'Searching…' });
    const captured = structuredClone(checkouts);
    const search = this.search;
    const work = Effect.gen({ self: this }, function* () {
      if (previous) yield* Scope.close(previous, Exit.void);
      yield* Effect.sleep('120 millis');
      const results = yield* Effect.all(
        captured.slice(0, 8).map((checkout) =>
          Effect.tryPromise({
            try: (signal) => search(checkout, query, signal),
            catch: ApplicationError.fromUnknown,
          }).pipe(
            Effect.map((result) => ({ checkout, result })),
            Effect.exit,
          ),
        ),
        { concurrency: 8 },
      );
      if (this.closed || generation !== this.generation) return;
      const rows: LookupRow[] = [],
        errors: string[] = [];
      let partial = captured.length > 8;
      for (const result of results) {
        if (Exit.isFailure(result)) {
          // IO errors have already been normalized; no schema/Cause internals reach the view.
          for (const reason of result.cause.reasons)
            if (reason._tag === 'Fail') errors.push(reason.error.message);
          continue;
        }
        const { checkout, result: value } = result.value;
        partial ||= value.partial;
        if (value.error) errors.push(value.error);
        for (const recent of value.history) rows.push({ ...recent, checkout, recent: true });
        for (const match of value.matches) rows.push({ ...match, checkout, recent: false });
      }
      const unique = [
        ...new Map(
          rows.map((row) => [fileKey({ checkout: row.checkout, path: row.path }), row]),
        ).values(),
      ];
      unique.sort(
        (a, b) => Number(b.recent) - Number(a.recent) || (a.recent ? 0 : b.score - a.score),
      );
      this.update({
        rows: unique.slice(0, 100),
        message: `${Math.min(unique.length, 100)} results${partial || unique.length > 100 ? '; partial coverage. Refine the query or Refresh.' : ''}${errors.length ? '; ' + errors.join('; ') : ''}`,
      });
    });
    void this.execute(Effect.forkIn(work, scope)).catch((error) =>
      this.update({ message: ApplicationError.fromUnknown(error).message }),
    );
  }
  async open(open: (current: () => boolean) => Promise<boolean>): Promise<boolean> {
    if (this.closed || this.snapshot.busy) return false;
    const generation = ++this.generation;
    this.update({ busy: true });
    try {
      const current = () => !this.closed && generation === this.generation;
      const result = await this.execute(
        Effect.flatMap(
          Effect.forkIn(
            Effect.tryPromise({ try: () => open(current), catch: ApplicationError.fromUnknown }),
            this.scope,
          ),
          Fiber.join,
        ),
      );
      if (!result && current())
        this.update({
          message:
            'File unavailable. Your current selection and edits are retained. Edit the path or retry.',
        });
      return result && current();
    } catch (error) {
      this.update({ message: ApplicationError.fromUnknown(error).message });
      return false;
    } finally {
      this.update({ busy: false });
    }
  }
  message(message: string) {
    this.update({ message });
  }
  stop() {
    this.closed = true;
    this.generation++;
    this.listeners.clear();
  }
  dispose() {
    this.stop();
    this.closed = true;
    this.generation++;
    this.listeners.clear();
    return (this.completion ??= this.execute(Scope.close(this.scope, Exit.void)));
  }
}

export type MutationAction = {
  checkout: CheckoutTarget;
  kind: WorkspaceOperation['kind'];
  paths: string[];
  nativeReferences?: string[];
};
export type MutationSnapshot = {
  busy: boolean;
  error: string;
  replacements: EntryReference[] | null;
};
type MutationDependencies = {
  inspect(checkout: CheckoutTarget, paths: string[], scope: Scope.Scope): Promise<EntryReference[]>;
  list(
    checkout: CheckoutTarget,
    path: string,
    scope: Scope.Scope,
  ): Promise<CommandOutput<'listDirectory'>>;
  mutate(input: Omit<WorkspaceOperation, 'clientId'>): Promise<OperationResult>;
  resolve(id: string): Promise<OperationResult | null>;
  pending(id: string): boolean;
};

/** Consent/inspection belong to a dialog; admitted work belongs to its editor model. */
export class EditorMutation {
  private scope: Scope.Closeable;
  private execute: Run;
  private dependencies: MutationDependencies;
  private action: MutationAction;
  private sources?: EntryReference[];
  private operationId = crypto.randomUUID();
  private generation = 0;
  private closed = false;
  private completion?: Promise<void>;
  private snapshot: MutationSnapshot = { busy: false, error: '', replacements: null };
  private listeners = new Set<() => void>();
  constructor(
    scope: Scope.Scope,
    execute: Run,
    dependencies: MutationDependencies,
    action: MutationAction,
  ) {
    this.scope = Scope.forkUnsafe(scope);
    this.execute = execute;
    this.dependencies = dependencies;
    this.action = structuredClone(action);
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<MutationSnapshot>) {
    if (this.closed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  invalidate() {
    if (this.snapshot.busy) return;
    this.generation++;
    this.update({ replacements: null });
  }
  async apply(destination: string, replacementPaths: string, consent: boolean): Promise<boolean> {
    if (this.closed || this.snapshot.busy) return false;
    const action = this.action,
      generation = ++this.generation,
      dependencies = this.dependencies;
    const current = () => !this.closed && generation === this.generation;
    const batchImport = action.kind === 'import' && (action.nativeReferences?.length ?? 0) > 1;
    this.update({ busy: true, error: '' });
    try {
      if (dependencies.pending(this.operationId)) {
        const result = await dependencies.resolve(this.operationId);
        if (result?.outcome === 'completed') return current();
        this.update({
          error:
            'Operation remains unresolved. Its original identity is retained; no effects were repeated.',
        });
        return false;
      }
      this.sources ??= action.paths.length
        ? await dependencies.inspect(action.checkout, action.paths, this.scope)
        : [];
      if (!current()) return false;
      let replace = this.snapshot.replacements;
      if (action.kind !== 'trash' && replace === null) {
        if (batchImport) {
          const paths = replacementPaths.split('\n').filter(Boolean);
          replace = paths.length
            ? await dependencies.inspect(action.checkout, paths, this.scope)
            : [];
        } else {
          const parent = destination.split('/').slice(0, -1).join('/');
          const listing = await dependencies.list(action.checkout, parent, this.scope);
          if (!current()) return false;
          const collision = listing.entries.find(
            (entry) =>
              entry.path.normalize('NFC').toLowerCase() ===
              destination.normalize('NFC').toLowerCase(),
          );
          replace = collision
            ? await dependencies.inspect(action.checkout, [collision.path], this.scope)
            : [];
        }
        if (!current()) return false;
        this.update({ replacements: replace });
      }
      if ((replace?.length && !consent) || !current()) return false;
      // The original immutable request transfers to model ownership before dispatch.
      const result = await dependencies.mutate({
        id: this.operationId,
        checkout: action.checkout,
        kind: action.kind,
        sources: this.sources,
        ...(action.kind === 'trash' ? {} : { destination }),
        ...(action.nativeReferences ? { nativeReferences: action.nativeReferences } : {}),
        replacements: replace ?? [],
      });
      if (!current()) return false;
      if (result.outcome !== 'completed') {
        this.update({
          error:
            result.message ??
            'Operation incomplete. Review the recorded outcome before continuing.',
        });
        return false;
      }
      return true;
    } catch (error) {
      this.update({ error: ApplicationError.fromUnknown(error).message });
      return false;
    } finally {
      this.update({ busy: false });
    }
  }
  stop() {
    this.closed = true;
    this.generation++;
    this.listeners.clear();
  }
  dispose() {
    this.stop();
    this.closed = true;
    this.generation++;
    this.listeners.clear();
    return (this.completion ??= this.execute(Scope.close(this.scope, Exit.void)));
  }
}
