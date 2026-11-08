import { normalizeApplicationError } from '../../runtime/effect-client.ts';
import { Effect, Exit, Fiber, Scope } from 'effect';
import {
  type ApplicationError,
  type CheckoutTarget,
  type EntryReference,
  type LookupMatch,
  type TextSearchFile,
  type CommandOutput,
  type WorkspaceOperation,
  type OperationResult,
} from '@moonbase/contracts/workspace';
import { checkoutKey, fileKey } from './references.ts';

type Run = <A>(effect: Effect.Effect<A, ApplicationError>) => Promise<A>;
export type LookupRow = LookupMatch & { checkout: CheckoutTarget; recent: boolean };
export type LookupSnapshot = { rows: LookupRow[]; message: string; busy: boolean };

/** A popup owns queries; replacing it cannot replace a captured editor mutation. */
abstract class EditorQuery<Snapshot extends { message: string; busy: boolean }> {
  protected scope: Scope.Closeable;
  protected queryScope?: Scope.Closeable;
  protected generation = 0;
  /** A new query or open bumps it, a refresh never does: only what the user did cancels an open. */
  private openGeneration = 0;
  private queryKey?: string;
  private settled = true;
  private rerun?: () => void;
  /** Why the last open failed, shown until the next query or open the user starts. */
  private failedOpen?: string;
  protected closed = false;
  private completion?: Promise<void>;
  private listeners = new Set<() => void>();
  protected snapshot: Snapshot;
  protected execute: Run;
  protected admits: () => boolean;
  constructor(admits: () => boolean, scope: Scope.Scope, execute: Run, initial: Snapshot) {
    this.admits = admits;
    this.scope = Scope.forkUnsafe(scope);
    this.execute = execute;
    this.snapshot = initial;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  protected update(patch: Partial<Snapshot>) {
    if (this.closed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  /** Whether `key` repeats the last query, as the refresh after a change on disk does. */
  protected repeats(key: string) {
    return key === this.queryKey;
  }
  /** A query's message, unless a failed open is still on screen: a refresh only updates rows. */
  protected resultMessage(message: string) {
    return this.failedOpen ?? message;
  }
  /**
   * Replaces the running query: the previous one's scope closes before the next debounced run.
   * Repeating the last query refreshes it. A refresh leaves an open running, and one that arrives
   * while the query still runs waits for it and reruns once, so a stream of refreshes (a watcher
   * reports several a second while an agent works) cannot keep restarting the query.
   */
  protected replaceQuery(
    key: string,
    work: (current: () => boolean) => Effect.Effect<void, ApplicationError>,
  ) {
    const refresh = this.repeats(key);
    if (refresh && !this.settled) {
      this.rerun = () => this.replaceQuery(key, work);
      return;
    }
    if (!refresh) {
      this.openGeneration++;
      this.failedOpen = undefined;
    }
    this.queryKey = key;
    this.settled = false;
    this.rerun = undefined;
    const generation = ++this.generation;
    const current = () => !this.closed && generation === this.generation;
    const previous = this.queryScope;
    const scope = (this.queryScope = Scope.forkUnsafe(this.scope));
    const run = Effect.gen({ self: this }, function* () {
      if (previous) yield* Scope.close(previous, Exit.void);
      yield* Effect.sleep('120 millis');
      yield* work(current);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (!current()) return;
          this.settled = true;
          const rerun = this.rerun;
          this.rerun = undefined;
          if (rerun && this.admits()) rerun();
        }),
      ),
    );
    void this.execute(Effect.forkIn(run, scope)).catch((error) =>
      this.update({ message: normalizeApplicationError(error).message } as Partial<Snapshot>),
    );
  }
  async open(open: (current: () => boolean) => Promise<boolean>): Promise<boolean> {
    if (!this.admits() || this.closed || this.snapshot.busy) return false;
    const generation = ++this.openGeneration;
    this.failedOpen = undefined;
    this.update({ busy: true } as Partial<Snapshot>);
    const current = () => !this.closed && generation === this.openGeneration;
    const fail = (message: string) => {
      this.failedOpen = message;
      this.update({ message } as Partial<Snapshot>);
    };
    try {
      const result = await this.execute(
        Effect.flatMap(
          Effect.forkIn(
            Effect.tryPromise({ try: () => open(current), catch: normalizeApplicationError }),
            this.scope,
          ),
          Fiber.join,
        ),
      );
      if (!result && current())
        fail(
          'File unavailable. Your current selection and edits are retained. Edit the path or retry.',
        );
      return result && current();
    } catch (error) {
      if (current()) fail(normalizeApplicationError(error).message);
      return false;
    } finally {
      this.update({ busy: false } as Partial<Snapshot>);
    }
  }
  message(message: string) {
    if (!this.admits()) return;
    this.update({ message } as Partial<Snapshot>);
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

export class EditorLookup extends EditorQuery<LookupSnapshot> {
  private search: (
    checkout: CheckoutTarget,
    query: string,
    signal: AbortSignal,
  ) => Promise<CommandOutput<'lookupFiles'>>;
  constructor(
    admits: () => boolean,
    scope: Scope.Scope,
    execute: Run,
    search: EditorLookup['search'],
  ) {
    super(admits, scope, execute, { rows: [], message: 'Type a filename or path.', busy: false });
    this.search = search;
  }
  query(query: string, checkouts: CheckoutTarget[]) {
    if (!this.admits() || this.closed) return;
    const key = JSON.stringify([query, checkouts.map(checkoutKey)]);
    // Earlier rows stay until the new ones arrive, so the list does not flicker while typing. A
    // refresh keeps its message too: the rows on screen already answer the same query.
    if (!this.repeats(key)) this.update({ message: 'Searching…' });
    const captured = structuredClone(checkouts);
    const search = this.search;
    this.replaceQuery(key, (current) =>
      Effect.gen({ self: this }, function* () {
        const results = yield* Effect.all(
          captured.slice(0, 8).map((checkout) =>
            Effect.tryPromise({
              try: (signal) => search(checkout, query, signal),
              catch: normalizeApplicationError,
            }).pipe(
              Effect.map((result) => ({ checkout, result })),
              Effect.exit,
            ),
          ),
          { concurrency: 8 },
        );
        if (!current()) return;
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
          message: this.resultMessage(
            `${Math.min(unique.length, 100)} results${partial || unique.length > 100 ? '; partial coverage. Refine the query or Refresh.' : ''}${errors.length ? '; ' + errors.join('; ') : ''}`,
          ),
        });
      }),
    );
  }
}

export type TextSearchOptions = { matchCase: boolean; wholeWord: boolean; regex: boolean };
export type TextSearchSnapshot = {
  files: TextSearchFile[];
  checkout?: CheckoutTarget;
  message: string;
  busy: boolean;
};

/** Searches one checkout's file contents; a newer query cancels the running one. */
export class EditorTextSearch extends EditorQuery<TextSearchSnapshot> {
  private search: (
    input: { checkout: CheckoutTarget; query: string } & TextSearchOptions,
    signal: AbortSignal,
  ) => Promise<CommandOutput<'searchText'>>;
  constructor(
    admits: () => boolean,
    scope: Scope.Scope,
    execute: Run,
    search: EditorTextSearch['search'],
  ) {
    super(admits, scope, execute, { files: [], message: 'Type text to search for.', busy: false });
    this.search = search;
  }
  query(query: string, options: TextSearchOptions, checkout: CheckoutTarget) {
    if (!this.admits() || this.closed) return;
    const { matchCase, wholeWord, regex } = options;
    const key = JSON.stringify([query, matchCase, wholeWord, regex, checkoutKey(checkout)]);
    if (!query) {
      this.replaceQuery(key, () => Effect.void);
      this.update({ files: [], checkout, message: this.resultMessage('Type text to search for.') });
      return;
    }
    if (!this.repeats(key)) this.update({ message: 'Searching…' });
    const input = { ...structuredClone(options), checkout: structuredClone(checkout), query };
    const search = this.search;
    this.replaceQuery(key, (current) =>
      Effect.gen({ self: this }, function* () {
        const result = yield* Effect.tryPromise({
          try: (signal) => search(input, signal),
          catch: normalizeApplicationError,
        }).pipe(Effect.exit);
        if (!current()) return;
        if (Exit.isFailure(result)) {
          const reason = result.cause.reasons.find((item) => item._tag === 'Fail');
          this.update({
            files: [],
            checkout: input.checkout,
            message: this.resultMessage(
              reason?._tag === 'Fail' ? reason.error.message : 'Search failed.',
            ),
          });
          return;
        }
        const { files, partial, error } = result.value;
        const count = files.reduce((n, file) => n + file.matches.length, 0);
        let message = count
          ? `${count} ${count === 1 ? 'match' : 'matches'} in ${files.length} ${files.length === 1 ? 'file' : 'files'}`
          : 'No matches.';
        if (partial) message += '; capped. Refine the query.';
        if (error) message += '; ' + error;
        this.update({ files, checkout: input.checkout, message: this.resultMessage(message) });
      }),
    );
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

export function getMutationDestinations(sources: readonly EntryReference[], destination: string) {
  const batch = sources.length > 1;
  return {
    parent: batch ? destination : destination.split('/').slice(0, -1).join('/'),
    destinations: batch
      ? sources.map((source) =>
          [destination, source.target.path.split('/').at(-1)].filter(Boolean).join('/'),
        )
      : [destination],
  };
}

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
  private admits: () => boolean;
  constructor(
    admits: () => boolean,
    scope: Scope.Scope,
    execute: Run,
    dependencies: MutationDependencies,
    action: MutationAction,
  ) {
    this.admits = admits;
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
    if (!this.admits() || this.snapshot.busy) return;
    this.generation++;
    this.update({ replacements: null });
  }
  async apply(destination: string, replacementPaths: string, consent: boolean): Promise<boolean> {
    if (!this.admits() || this.closed || this.snapshot.busy) return false;
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
          const { parent, destinations } = getMutationDestinations(this.sources, destination);
          const listing = await dependencies.list(action.checkout, parent, this.scope);
          if (!current()) return false;
          const matchingDestinations = new Set(
            destinations.map((path) => path.normalize('NFC').toLowerCase()),
          );
          const collisions = listing.entries.filter((entry) =>
            matchingDestinations.has(entry.path.normalize('NFC').toLowerCase()),
          );
          replace = collisions.length
            ? await dependencies.inspect(
                action.checkout,
                collisions.map((entry) => entry.path),
                this.scope,
              )
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
      this.update({ error: normalizeApplicationError(error).message });
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
