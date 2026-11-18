import { getParentPath, getPathName, isPathAtOrInside, joinPath } from '@moonbase/contracts/paths';
import { checkoutKey } from '../editor/index.ts';
import { Effect, Layer, Queue, Stream } from 'effect';
import {
  WorkspaceService,
  type WorkspaceServiceShape,
} from '@moonbase/contracts/workspace-service';
import { fauxRecovery } from './faux-recovery.ts';
import { UncertainError } from '@moonbase/contracts/errors';
import { isWorkspaceError, type WorkspaceError } from '@moonbase/contracts/workspace-errors';
import {
  BranchTakenError,
  InvalidBaseError,
  InvalidPathError,
  InvalidPatternError,
  InvalidRequestError,
  RecordedRefusalError,
  WorkspaceConflictError,
  WorkspaceStoreError,
  WorkspaceUnavailableError,
  WorkspaceUnsupportedError,
} from '@moonbase/contracts/workspace-host-errors';
import { lookupFauxFiles, searchFauxFiles } from './faux-search.ts';
import {
  maximumFileBytes,
  type CheckoutTarget,
  type FileDocument,
  type FileTarget,
  type GitCheckoutTarget,
  type GitChange,
  type WorkspaceCommand,
  type OperationResult,
  type SaveResult,
  type WorkspaceEvent,
} from '@moonbase/contracts/workspace';

type Seed = {
  checkout: CheckoutTarget;
  files: Record<string, string>;
  head?: Record<string, string>;
  index?: Record<string, string>;
  ignored?: string[];
  /** Unmerged paths, each reported as one conflicted change; one absent from `files` is `missing`. */
  conflicted?: string[];
};
/** A seed as the faux workspace holds it: its Git baselines by path. */
type HeldSeed = Omit<Seed, 'head' | 'index'> & {
  head?: ReadonlyMap<string, string>;
  index?: ReadonlyMap<string, string>;
};
const holdSeed = ({ head, index, ...seed }: Seed): HeldSeed => ({
  ...seed,
  ...(head && { head: new Map(Object.entries(head)) }),
  ...(index && { index: new Map(Object.entries(index)) }),
});
type Entry = FileDocument & { directory: boolean };
// It fails as the file host does, with the host's tagged errors.
const fail = (error: WorkspaceError): never => {
  throw error;
};
const invalid = () => new InvalidRequestError({ problem: 'invalid-input' });
const unavailable = () => new WorkspaceUnavailableError({ cause: 'failed' });
const pathCheck = (path: string, directory = false) => {
  if (directory && path === '') return;
  if (
    !path ||
    path.startsWith('/') ||
    /[\\\0]/.test(path) ||
    path
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    fail(new InvalidPathError({ problem: 'not-relative' }));
};

/** Concrete volatile adapter for demos/tests. It makes no filesystem or durability claim. */
export function fauxWorkspace(given: Seed[]) {
  let version = 0;
  const files = new Map<string, Map<string, Entry>>();
  const saves = new Map<string, { payload: string; result: SaveResult }>();
  /** Each operation, with the clients whose recovery it touched and those that acknowledged it. */
  const operations = new Map<
    string,
    { payload: string; result: OperationResult; owners: Set<string>; acks: Set<string> }
  >();
  const watchers = new Set<{ checkout: CheckoutTarget; notify: (event: WorkspaceEvent) => void }>();
  const faults = new Map<WorkspaceCommand, { error: WorkspaceError; after: boolean }>();
  const stats = {
    subscriptions: 0,
    released: 0,
    active: 0,
    mutations: 0,
    saves: 0,
    /** Recovery edits applied. */
    get edits() {
      return recovery.stats.edits;
    },
  };
  const document = (text: string): FileDocument => {
    if (new TextEncoder().encode(text).length > maximumFileBytes || text.includes('\0'))
      fail(new InvalidRequestError({ problem: 'text-too-large' }));
    return { text, version: String(++version) };
  };
  const exact = (checkout: CheckoutTarget) => {
    const seed = seeds.find((seed) => checkoutKey(seed.checkout) === checkoutKey(checkout));
    if (!seed) fail(unavailable());
    return seed!;
  };
  const entries = (checkout: CheckoutTarget) => {
    exact(checkout);
    return files.get(checkoutKey(checkout))!;
  };
  const read = (target: FileTarget) => {
    pathCheck(target.path);
    const entry = entries(target.checkout).get(target.path);
    if (!entry || entry.directory) return fail(unavailable());
    return { text: entry.text, version: entry.version };
  };
  const notify = (checkout: CheckoutTarget, paths: string[]) => {
    for (const watcher of watchers)
      if (checkoutKey(watcher.checkout) === checkoutKey(checkout))
        watcher.notify({ checkout, paths });
  };
  const recovery = fauxRecovery({ exact, fail });
  const addSeed = (seed: HeldSeed) => {
    const map = new Map<string, Entry>();
    files.set(checkoutKey(seed.checkout), map);
    for (const [path, text] of Object.entries(seed.files)) {
      pathCheck(path);
      map.set(path, { ...document(text), directory: false });
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++)
        map.set(parts.slice(0, i).join('/'), {
          text: '',
          version: String(++version),
          directory: true,
        });
    }
  };
  const seeds = given.map(holdSeed);
  for (const seed of seeds) addSeed(seed);
  const projectSeeds = (checkout: CheckoutTarget) =>
    seeds.filter((seed) => seed.checkout.projectId === exact(checkout).checkout.projectId);
  const requireGit = (checkout: CheckoutTarget): GitCheckoutTarget =>
    checkout.vcs === 'git' ? checkout : fail(new InvalidRequestError({ problem: 'not-git' }));
  const call = <A>(name: WorkspaceCommand, action: () => A) =>
    Effect.try({
      try: () => {
        const fault = faults.get(name);
        faults.delete(name);
        if (fault && !fault.after) throw fault.error;
        const value = action();
        if (fault) throw fault.error;
        return structuredClone(value);
      },
      catch: (error) => (isWorkspaceError(error) ? error : unavailable()),
    });
  const service: WorkspaceServiceShape = {
    openCheckout: ({ root }) =>
      call(
        'openCheckout',
        () => seeds.find((seed) => seed.checkout.root === root)?.checkout ?? fail(unavailable()),
      ),
    readFile: (target) => call('readFile', () => read(target)),
    saveFile: (input) =>
      call('saveFile', () => {
        if (!input.clientId || !input.requestId) fail(invalid());
        const key = JSON.stringify([input.clientId, input.requestId]),
          payload = JSON.stringify(input),
          previous = saves.get(key);
        if (previous)
          return previous.payload === payload
            ? previous.result
            : fail(new WorkspaceConflictError({ conflict: 'save-payload' }));
        const disk = read(input.target);
        const result: SaveResult =
          disk.version !== input.expectedVersion
            ? { kind: 'conflict', disk }
            : { kind: 'saved', disk: document(input.text) };
        saves.set(key, { payload, result });
        if (result.kind === 'saved') {
          entries(input.target.checkout).set(input.target.path, {
            ...result.disk,
            directory: false,
          });
          stats.saves++;
          recovery.applySave(input.clientId, input.target, result.disk);
          notify(input.target.checkout, [input.target.path]);
        }
        return result;
      }),
    listDirectory: ({ checkout, path, hideIgnored, includeIgnoredStatus }) =>
      call('listDirectory', () => {
        pathCheck(path, true);
        if (includeIgnoredStatus === false && hideIgnored)
          fail(new InvalidRequestError({ problem: 'ignore-filtering' }));
        const seed = exact(checkout),
          prefix = path ? path + '/' : '';
        if (path && !entries(checkout).get(path)?.directory) fail(unavailable());
        const values = [...entries(checkout)]
          .filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
          .map(([name, entry]) => ({
            path: name,
            directory: entry.directory,
            ...(includeIgnoredStatus === false
              ? {}
              : { ignored: seed.ignored?.some((item) => isPathAtOrInside(name, item)) ?? false }),
          }));
        return {
          entries: values
            .filter((entry) => !hideIgnored || !entry.ignored)
            .sort(
              (a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path),
            ),
          partial: false,
        };
      }),
    getIgnoredPaths: ({ checkout, path, paths }) =>
      call('getIgnoredPaths', () => {
        pathCheck(path, true);
        const seed = exact(checkout);
        if (paths.length > 20000) fail(invalid());
        for (const item of paths) {
          pathCheck(item);
          if (getParentPath(item) !== path)
            fail(new InvalidPathError({ problem: 'ignore-not-child' }));
        }
        return {
          paths: paths.filter((name) => seed.ignored?.some((item) => isPathAtOrInside(name, item))),
        };
      }),
    gitStatus: ({ checkout }) =>
      call('gitStatus', () => {
        const seed = exact(checkout),
          working = entries(checkout),
          changes: GitChange[] = [],
          paths = new Set([
            ...working.keys(),
            ...(seed.head?.keys() ?? []),
            ...(seed.index?.keys() ?? []),
          ]);
        if (checkout.vcs === 'none') return { branch: '', changes: [] };
        for (const path of paths) {
          const entry = working.get(path);
          if (entry?.directory) continue;
          if (seed.conflicted?.includes(path)) {
            changes.push(
              entry
                ? { path, area: 'conflicted', kind: 'conflicted' }
                : { path, area: 'conflicted', kind: 'conflicted', missing: true },
            );
            continue;
          }
          const head = seed.head?.get(path),
            staged = seed.index?.get(path),
            index = staged ?? head;
          if (index === undefined) {
            if (!seed.ignored?.some((item) => isPathAtOrInside(path, item)))
              changes.push({ path, area: 'untracked', kind: 'untracked' });
          } else if (!entry) changes.push({ path, area: 'unstaged', kind: 'deleted' });
          else if (entry.text !== index) changes.push({ path, area: 'unstaged', kind: 'modified' });
          if (staged !== undefined && staged !== head)
            changes.push({ path, area: 'staged', kind: head === undefined ? 'added' : 'modified' });
        }
        return { branch: checkout.branch, changes };
      }),
    listWorktrees: ({ checkout }) =>
      call('listWorktrees', () => ({
        worktrees: projectSeeds(checkout)
          .flatMap(({ checkout }) => (checkout.vcs === 'git' ? [checkout] : []))
          .map((checkout) => ({
            root: checkout.root,
            branch: checkout.branch,
            main: checkout.worktree === 'main',
            locked: false,
            prunable: false,
          }))
          .sort((a, b) => Number(b.main) - Number(a.main)),
      })),
    // Seeds the new linked worktree with the base branch's committed files.
    createWorktree: ({ checkout, base, branch, location }) =>
      call('createWorktree', () => {
        const from = requireGit(checkout);
        const project = projectSeeds(checkout).filter((seed) => seed.checkout.vcs === 'git');
        const branchOf = (seed: HeldSeed) => seed.checkout.vcs === 'git' && seed.checkout.branch;
        const source = project.find((seed) => branchOf(seed) === base);
        if (!source) fail(new InvalidBaseError({ base }));
        if (project.some((seed) => branchOf(seed) === branch))
          fail(new BranchTakenError({ branch, inside: false }));
        if (seeds.some((seed) => seed.checkout.root === location))
          fail(new WorkspaceConflictError({ conflict: 'location-exists' }));
        const head = new Map(source!.head ?? Object.entries(source!.files));
        const seed: HeldSeed = {
          checkout: {
            ...from,
            checkoutId: `${checkout.projectId}:${location}`,
            root: location,
            branch,
            worktree: 'linked',
          },
          files: Object.fromEntries(head),
          head,
        };
        seeds.push(seed);
        addSeed(seed);
        return seed.checkout;
      }),
    // The folder's files become untracked in a repository with no commits.
    initializeRepository: ({ checkout }) =>
      call('initializeRepository', () => {
        const seed = exact(checkout);
        if (checkout.vcs !== 'none') fail(new InvalidRequestError({ problem: 'already-git' }));
        const { vcs: _, ...identity } = checkout;
        const initialized: GitCheckoutTarget = {
          ...identity,
          vcs: 'git',
          projectId: `${checkout.projectId}:git`,
          branch: 'main',
          worktree: 'main',
        };
        seeds[seeds.indexOf(seed)] = {
          ...seed,
          checkout: initialized,
          head: new Map(),
          index: new Map(),
        };
        files.set(checkoutKey(initialized), files.get(checkoutKey(checkout))!);
        files.delete(checkoutKey(checkout));
        return initialized;
      }),
    readComparison: ({ target, area }) =>
      call('readComparison', () => {
        const seed = exact(target.checkout);
        requireGit(target.checkout);
        pathCheck(target.path);
        let original;
        if (area === 'untracked') {
          original = '';
        } else {
          if (area === 'staged') {
            original = seed.head?.get(target.path);
          } else {
            original = seed.index?.get(target.path) ?? seed.head?.get(target.path);
          }
        }
        if (original === undefined) fail(unavailable());
        const working = entries(target.checkout).get(target.path);
        return {
          original: original!,
          working: working && !working.directory ? read(target) : null,
          title: `${area} · ${target.path}`,
        };
      }),
    lookupFiles: ({ checkout, ...query }) =>
      call('lookupFiles', () => lookupFauxFiles(entries(checkout), exact(checkout).ignored, query)),
    searchText: ({ checkout, ...query }) =>
      call(
        'searchText',
        () =>
          searchFauxFiles(entries(checkout), exact(checkout).ignored, query) ??
          fail(new InvalidPatternError({})),
      ),
    inspectEntries: ({ checkout, paths }) =>
      call('inspectEntries', () => {
        if (!Array.isArray(paths) || paths.length < 1 || paths.length > 256) fail(invalid());
        return paths.map((path) => {
          pathCheck(path);
          const entry = entries(checkout).get(path) ?? fail(unavailable());
          return {
            target: { checkout, path },
            identity: entry.version,
            directory: entry.directory,
          };
        });
      }),
    mutate: (operation) =>
      call('mutate', () => {
        const key = JSON.stringify([operation.clientId, operation.id]),
          payload = JSON.stringify(operation),
          previous = operations.get(key);
        if (previous)
          return previous.payload === payload
            ? previous.result
            : fail(new WorkspaceConflictError({ conflict: 'operation-payload' }));
        if (!operation.id || !operation.clientId) fail(invalid());
        const map = new Map(entries(operation.checkout));
        const result: OperationResult = {
          id: operation.id,
          clientId: operation.clientId,
          checkout: operation.checkout,
          kind: operation.kind,
          outcome: 'completed',
          items: [],
        };
        for (const ref of [...operation.sources, ...(operation.replacements ?? [])]) {
          pathCheck(ref.target.path);
          if (
            checkoutKey(ref.target.checkout) !== checkoutKey(operation.checkout) ||
            map.get(ref.target.path)?.version !== ref.identity
          )
            fail(new WorkspaceConflictError({ conflict: 'source-changed' }));
        }
        if (operation.kind === 'import')
          fail(new WorkspaceUnsupportedError({ feature: 'native-imports' }));
        // Like the workspace, several sources move or copy into an existing folder ('' is the
        // root), keeping their names; one source goes to its exact destination path.
        const batch =
          (operation.kind === 'move' || operation.kind === 'copy') && operation.sources.length > 1;
        if (operation.destination) pathCheck(operation.destination);
        if (batch) {
          const folder = operation.destination ?? fail(invalid());
          if (folder && !map.get(folder)?.directory)
            fail(new InvalidRequestError({ problem: 'batch-destination' }));
          const names = operation.sources.map((source) =>
            getPathName(source.target.path).normalize('NFC').toLowerCase(),
          );
          if (new Set(names).size !== names.length)
            fail(new InvalidRequestError({ problem: 'colliding-destinations' }));
          if (
            operation.sources.some((source) =>
              operation.sources.some(
                (other) =>
                  other !== source && isPathAtOrInside(source.target.path, other.target.path),
              ),
            )
          )
            fail(new InvalidRequestError({ problem: 'overlapping-sources' }));
        }
        const destinationOf = (source: string) =>
          batch
            ? joinPath(operation.destination ?? '', getPathName(source))
            : operation.destination;
        const replace = (destination: string, source?: string) => {
          const collision = [...map.keys()].find(
            (path) =>
              path.normalize('NFC').toLowerCase() === destination.normalize('NFC').toLowerCase() &&
              // Like a case-insensitive disk, a move may change only its name's case.
              !(operation.kind === 'move' && path === source),
          );
          if (collision && !operation.replacements?.some((ref) => ref.target.path === collision))
            fail(new WorkspaceConflictError({ conflict: 'replacement-changed' }));
          if (collision)
            for (const path of map.keys()) if (isPathAtOrInside(path, collision)) map.delete(path);
          const parent = getParentPath(destination);
          if (parent && !map.get(parent)?.directory) fail(unavailable());
        };
        if (operation.kind === 'create-file' || operation.kind === 'create-directory') {
          const destination = operation.destination ?? fail(invalid());
          replace(destination);
          map.set(destination, {
            ...document(operation.text ?? ''),
            directory: operation.kind === 'create-directory',
          });
          result.items.push({ source: '', destination, outcome: 'completed' });
        } else
          for (const source of operation.sources) {
            const destination = destinationOf(source.target.path);
            if (operation.kind !== 'trash' && !destination) fail(invalid());
            if (destination && isPathAtOrInside(destination, source.target.path))
              fail(new InvalidRequestError({ problem: 'destination-inside-source' }));
            if (destination) replace(destination, source.target.path);
            const selected = [...map].filter(([path]) =>
              isPathAtOrInside(path, source.target.path),
            );
            for (const [path, entry] of selected) {
              if (destination)
                map.set(destination + path.slice(source.target.path.length), {
                  ...entry,
                  version: String(++version),
                });
              if (operation.kind !== 'copy') map.delete(path);
            }
            result.items.push({
              source: source.target.path,
              ...(destination ? { destination } : {}),
              outcome: 'completed',
            });
          }
        files.set(checkoutKey(operation.checkout), map);
        const owners = new Set([
          operation.clientId,
          ...recovery.clients().filter((client) => recovery.names(client, operation.checkout)),
        ]);
        recovery.applyOperation(result, (path) => {
          const entry = map.get(path);
          return entry && !entry.directory
            ? { text: entry.text, version: entry.version }
            : undefined;
        });
        operations.set(key, { payload, result, owners, acks: new Set() });
        stats.mutations++;
        notify(
          operation.checkout,
          result.items.map((item) => item.destination ?? item.source),
        );
        return result;
      }),
    operationStatus: ({ clientId, id }) =>
      call('operationStatus', () => operations.get(JSON.stringify([clientId, id]))?.result ?? null),
    acknowledgeOperation: ({ clientId, operationClientId, id }) =>
      call('acknowledgeOperation', () => {
        const entry = operations.get(JSON.stringify([operationClientId, id]));
        if (!entry) return fail(invalid());
        entry.acks.add(clientId);
      }),
    loadRecovery: ({ clientId }) =>
      call('loadRecovery', () => ({
        state: recovery.load(clientId),
        errors: [],
        operations: [...operations.values()]
          .filter((item) => item.owners.has(clientId) && !item.acks.has(clientId))
          .map((item) => item.result),
      })),
    openTab: (input) => call('openTab', () => recovery.openTab(input)),
    closeTab: (input) => call('closeTab', () => recovery.closeTab(input)),
    updateDraft: (input) => call('updateDraft', () => recovery.updateDraft(input)),
    updateLayout: (input) => call('updateLayout', () => recovery.updateLayout(input)),
    watchRecovery: ({ clientId }) => recovery.watch(clientId),
    watch: ({ checkout }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.sliding<WorkspaceEvent>(1);
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              exact(checkout);
              const watcher = {
                checkout,
                notify: (event: WorkspaceEvent) => {
                  Queue.offerUnsafe(queue, event);
                },
              };
              watchers.add(watcher);
              stats.subscriptions++;
              stats.active++;
              watcher.notify({ checkout, paths: [], ready: true });
              return watcher;
            }),
            (watcher) =>
              Effect.sync(() => {
                watchers.delete(watcher);
                stats.released++;
                stats.active--;
              }),
          );
          return Stream.fromQueue(queue);
        }),
      ),
  };
  return {
    layer: Layer.succeed(WorkspaceService, service),
    stats,
    externalWrite(target: FileTarget, text: string) {
      read(target);
      entries(target.checkout).set(target.path, { ...document(text), directory: false });
      notify(target.checkout, [target.path]);
    },
    /**
     * Fails `name`'s next call with `failure`, before it runs or, when `after`, once it has run. A
     * string is the failure's text: a store failure, or when `after` an uncertain outcome naming it.
     */
    failNext(
      name: WorkspaceCommand,
      failure: string | WorkspaceError = 'Injected IO failure',
      after = false,
    ) {
      let error: WorkspaceError;
      if (typeof failure !== 'string') error = failure;
      else if (after) error = new UncertainError({ operation: failure });
      else error = new WorkspaceStoreError({ failure: 'publication', detail: failure });
      faults.set(name, { error, after });
    },
    /** Refuses `name`'s next call as given, before it runs, as a host replays a refusal with its text. */
    refuseNext(name: WorkspaceCommand, text: string) {
      faults.set(name, {
        error: new RecordedRefusalError({ refusal: 'invalid', text }),
        after: false,
      });
    },
  };
}
