import { isPathAtOrInside } from '@moonbase/contracts/paths';
import {
  decodeEditorRecovery,
  ApplicationError,
  emptyRecovery,
  maximumFileBytes,
  type CheckoutTarget,
  type FileDocument,
  type FileTarget,
  type GitCheckoutTarget,
  type GitChange,
  type WorkspaceCommand,
  type EditorRecovery,
  type OperationResult,
  type SaveResult,
  type WorkspaceEvent,
  type LookupMatch,
  type RecoveryChange,
  type RecoveryPublication,
} from '@moonbase/contracts/workspace';
import { readOwn } from '../features/editor/record.ts';
import { Effect, Layer, Queue, Stream } from 'effect';
import { WorkspaceService, type WorkspaceServiceShape } from '@moonbase/contracts/services';
import { checkoutKey, fileKey, moveRecoveryReferences } from '../features/editor/references.ts';

type Seed = {
  checkout: CheckoutTarget;
  files: Record<string, string>;
  head?: Record<string, string>;
  index?: Record<string, string>;
  ignored?: string[];
  /** Unmerged paths, each reported as one conflicted change; one absent from `files` is `missing`. */
  conflicted?: string[];
};
type Entry = FileDocument & { directory: boolean };
const fail = (message: string, code: ApplicationError['code'] = 'InvalidInput'): never => {
  throw new ApplicationError({ code, message });
};
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
    fail('Invalid relative path.');
};

// Independent subsequence matching, with quoted contiguous terms and basename/adjacency preference.
function match(path: string, query: string): LookupMatch | undefined {
  const value = path.toLocaleLowerCase(),
    positions: number[] = [];
  let casing = 0;
  for (const term of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const requested = term[1] ?? term[2],
      text = requested.toLocaleLowerCase();
    if (term[1]) {
      const start = value.indexOf(text);
      if (start < 0) return;
      for (let i = 0; i < text.length; i++) {
        positions.push(start + i);
        if (path[start + i] === requested[i]) casing += 2;
      }
    } else {
      let start = 0;
      for (let i = 0; i < text.length; i++) {
        const found = value.indexOf(text[i], start);
        if (found < 0) return;
        positions.push(found);
        if (path[found] === requested[i]) casing += 2;
        start = found + 1;
      }
    }
  }
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  return {
    path,
    positions: sorted,
    score: sorted.reduce(
      (score, position, index) =>
        score +
        (index && position === sorted[index - 1] + 1 ? 8 : 0) +
        (position > path.lastIndexOf('/') ? 4 : 0) +
        (position === 0 ||
        /[/_. -]/.test(path[position - 1]) ||
        (/[a-z]/.test(path[position - 1]) && /[A-Z]/.test(path[position]))
          ? 6
          : 0),
      casing - path.length,
    ),
  };
}

/** Concrete volatile adapter for demos/tests. It makes no filesystem or durability claim. */
export function memoryWorkspace(seeds: Seed[]) {
  let version = 0;
  const files = new Map<string, Map<string, Entry>>();
  const recoveries = new Map<
    string,
    { revision: number; state: EditorRecovery; publishedRevision: number }
  >();
  const publications = new Map<string, { payload: string; receipt: RecoveryPublication }>();
  const saves = new Map<string, { payload: string; result: SaveResult }>();
  const operations = new Map<
    string,
    { payload: string; result: OperationResult; bounds: Map<string, number>; acks: Set<string> }
  >();
  const watchers = new Set<{ checkout: CheckoutTarget; notify: (event: WorkspaceEvent) => void }>();
  const faults = new Map<WorkspaceCommand, { error: ApplicationError; after: boolean }>();
  const stats = {
    subscriptions: 0,
    released: 0,
    active: 0,
    mutations: 0,
    saves: 0,
    publications: 0,
  };
  const document = (text: string): FileDocument => {
    if (new TextEncoder().encode(text).length > maximumFileBytes || text.includes('\0'))
      fail('Only UTF-8 text up to 2 MiB is editable.');
    return { text, version: String(++version) };
  };
  const exact = (checkout: CheckoutTarget) => {
    const seed = seeds.find((seed) => checkoutKey(seed.checkout) === checkoutKey(checkout));
    if (!seed) fail('Exact checkout unavailable.', 'Unavailable');
    return seed!;
  };
  const entries = (checkout: CheckoutTarget) => {
    exact(checkout);
    return files.get(checkoutKey(checkout))!;
  };
  const read = (target: FileTarget) => {
    pathCheck(target.path);
    const entry = entries(target.checkout).get(target.path);
    if (!entry || entry.directory) return fail('File unavailable.', 'Unavailable');
    return { text: entry.text, version: entry.version };
  };
  const notify = (checkout: CheckoutTarget, paths: string[]) => {
    for (const watcher of watchers)
      if (checkoutKey(watcher.checkout) === checkoutKey(checkout))
        watcher.notify({ checkout, paths });
  };
  function validateRecovery(state: EditorRecovery) {
    try {
      decodeEditorRecovery(state);
    } catch {
      fail('Invalid recovery state.');
    }
    const known = new Map(state.checkouts.map((checkout) => [checkout.checkoutId, checkout]));
    if (known.size !== state.checkouts.length) fail('Duplicate known checkout ID.');
    for (const checkout of state.checkouts) exact(checkout);
    if (
      new Set(state.openCheckoutIds).size !== state.openCheckoutIds.length ||
      state.openCheckoutIds.some((id) => !known.has(id))
    )
      fail('Open checkout IDs must be a unique subset of known targets.');
    if (
      state.selectedCheckoutId !== null &&
      !state.openCheckoutIds.includes(state.selectedCheckoutId)
    )
      fail('Selected checkout must be open.');
    for (const [id, view] of Object.entries(state.views)) {
      if (!known.has(id)) fail('View key must be a known checkoutId.');
      for (const path of [
        ...view.openFiles,
        ...Object.keys(view.fileViews),
        ...Object.keys(view.positions),
        ...view.tree.expanded,
        ...view.tree.selected,
      ])
        pathCheck(path);
      if (
        (view.active && !view.openFiles.includes(view.active)) ||
        (view.preview !== null && !view.openFiles.includes(view.preview))
      )
        fail('Active/preview file must belong to its retained checkout view.');
      pathCheck(view.tree.focus, true);
    }
    for (const target of [...state.drafts.map((draft) => draft.target), ...state.recentFiles]) {
      if (
        !known.has(target.checkout.checkoutId) ||
        checkoutKey(known.get(target.checkout.checkoutId)!) !== checkoutKey(target.checkout)
      )
        fail('Recovery file target must match its known exact checkout.');
      pathCheck(target.path);
    }
    if (new Set(state.drafts.map((draft) => fileKey(draft.target))).size !== state.drafts.length)
      fail('Duplicate recovery draft.');
    for (const draft of state.drafts)
      if (new TextEncoder().encode(draft.text).length > maximumFileBytes) fail('Draft too large.');
  }
  function revise(clientId: string, transform: (state: EditorRecovery) => void): RecoveryChange[] {
    const previous = recoveries.get(clientId);
    if (!previous) return [];
    const state = structuredClone(previous.state);
    transform(state);
    validateRecovery(state);
    if (JSON.stringify(state) === JSON.stringify(previous.state)) return [];
    const revision = previous.revision + 1;
    recoveries.set(clientId, { ...previous, revision, state });
    return [{ clientId, previousRevision: previous.revision, revision }];
  }
  function remapCollides(state: EditorRecovery, result: OperationResult) {
    if (result.kind !== 'move') return false;
    const targets = state.drafts.map((draft) => {
      let target = draft.target;
      if (checkoutKey(target.checkout) === checkoutKey(result.checkout))
        for (const item of result.items)
          if (
            item.outcome === 'completed' &&
            item.destination &&
            isPathAtOrInside(target.path, item.source)
          )
            target = { ...target, path: item.destination + target.path.slice(item.source.length) };
      return fileKey(target);
    });
    return new Set(targets).size !== targets.length;
  }
  function operationRecovery(result: OperationResult, proposed: Map<string, Entry>) {
    const bounds = new Map<string, number>();
    const updates = new Map<
      string,
      { revision: number; state: EditorRecovery; publishedRevision: number }
    >();
    for (const [clientId, stored] of recoveries) {
      if (
        clientId !== result.clientId &&
        !stored.state.checkouts.some(
          (checkout) => checkoutKey(checkout) === checkoutKey(result.checkout),
        )
      )
        continue;
      const state = structuredClone(stored.state);
      if (remapCollides(state, result)) {
        result.message =
          'Recovery remap collision. Original drafts retained; resolve them before acknowledging.';
        bounds.set(clientId, stored.revision);
        continue;
      }
      for (const item of result.items.filter((item) => item.outcome === 'completed')) {
        const move = (path: string) =>
          item.destination && isPathAtOrInside(path, item.source)
            ? item.destination + path.slice(item.source.length)
            : path;
        if (result.kind === 'move') {
          state.drafts = state.drafts.map((draft) =>
            checkoutKey(draft.target.checkout) === checkoutKey(result.checkout)
              ? { ...draft, target: { ...draft.target, path: move(draft.target.path) } }
              : draft,
          );
          if (item.destination)
            moveRecoveryReferences(state, result.checkout, item.source, item.destination);
        }
        if (result.kind === 'copy' && item.destination)
          // oxlint-disable-next-line no-useless-spread -- Copies append drafts; visit only the original snapshot.
          for (const draft of [...state.drafts]) {
            if (
              checkoutKey(draft.target.checkout) !== checkoutKey(result.checkout) ||
              !isPathAtOrInside(draft.target.path, item.source)
            )
              continue;
            const target = { checkout: result.checkout, path: move(draft.target.path) };
            if (!state.drafts.some((existing) => fileKey(existing.target) === fileKey(target))) {
              const disk =
                proposed.get(target.path) ?? fail('Copied file unavailable.', 'Unavailable');
              state.drafts.push({
                target,
                disk: { text: disk.text, version: disk.version },
                text: draft.text,
              });
            }
          }
      }
      validateRecovery(state);
      const revision =
        stored.revision + Number(JSON.stringify(state) !== JSON.stringify(stored.state));
      if (revision !== stored.revision) {
        updates.set(clientId, { ...stored, revision, state });
        result.recoveryChanges.push({ clientId, previousRevision: stored.revision, revision });
      }
      bounds.set(clientId, revision);
    }
    return { bounds, updates };
  }
  const addSeed = (seed: Seed) => {
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
  seeds = [...seeds];
  for (const seed of seeds) addSeed(seed);
  const projectSeeds = (checkout: CheckoutTarget) =>
    seeds.filter((seed) => seed.checkout.projectId === exact(checkout).checkout.projectId);
  const requireGit = (checkout: CheckoutTarget): GitCheckoutTarget =>
    checkout.vcs === 'git'
      ? checkout
      : fail('This project is not a Git repository. Initialize Git first.');
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
      catch: (error) =>
        error instanceof ApplicationError
          ? error
          : new ApplicationError({ code: 'Unavailable', message: String(error) }),
    });
  const service: WorkspaceServiceShape = {
    openCheckout: ({ root }) =>
      call(
        'openCheckout',
        () =>
          seeds.find((seed) => seed.checkout.root === root)?.checkout ??
          fail('Checkout unavailable.', 'Unavailable'),
      ),
    readFile: (target) => call('readFile', () => read(target)),
    saveFile: (input) =>
      call('saveFile', () => {
        if (!input.clientId || !input.requestId)
          fail('Save requires immutable request and client IDs.');
        const key = JSON.stringify([input.clientId, input.requestId]),
          payload = JSON.stringify(input),
          previous = saves.get(key);
        if (previous)
          return previous.payload === payload
            ? previous.result
            : fail('Save ID reused with changed payload.', 'Conflict');
        const disk = read(input.target);
        const result: SaveResult =
          disk.version !== input.expectedVersion
            ? { kind: 'conflict', disk }
            : { kind: 'saved', disk: document(input.text), recoveryChanges: [] };
        saves.set(key, { payload, result });
        if (result.kind === 'saved') {
          entries(input.target.checkout).set(input.target.path, {
            ...result.disk,
            directory: false,
          });
          stats.saves++;
          result.recoveryChanges = revise(input.clientId, (state) => {
            state.drafts = state.drafts.flatMap((draft) => {
              if (fileKey(draft.target) !== fileKey(input.target)) {
                return [draft];
              } else {
                if (draft.text === input.text) {
                  return [];
                } else {
                  return [{ ...draft, disk: result.disk }];
                }
              }
            });
          });
          notify(input.target.checkout, [input.target.path]);
        }
        return result;
      }),
    listDirectory: ({ checkout, path, hideIgnored, includeIgnoredStatus }) =>
      call('listDirectory', () => {
        pathCheck(path, true);
        if (includeIgnoredStatus === false && hideIgnored)
          fail('Ignore filtering requires ignore classification.');
        const seed = exact(checkout),
          prefix = path ? path + '/' : '';
        if (path && !entries(checkout).get(path)?.directory)
          fail('Directory unavailable.', 'Unavailable');
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
        if (paths.length > 20000) fail('Ignore paths exceed their limit.');
        for (const item of paths) {
          pathCheck(item);
          if (item.split('/').slice(0, -1).join('/') !== path)
            fail('Ignore paths must be immediate directory children.');
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
            ...Object.keys(seed.head ?? {}),
            ...Object.keys(seed.index ?? {}),
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
          const head = readOwn(seed.head, path),
            staged = readOwn(seed.index, path),
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
        const branchOf = (seed: Seed) => seed.checkout.vcs === 'git' && seed.checkout.branch;
        const source = project.find((seed) => branchOf(seed) === base);
        if (!source) fail(`Base ${base} is not a commit.`);
        if (project.some((seed) => branchOf(seed) === branch))
          fail(`Branch ${branch} already exists.`, 'Conflict');
        if (seeds.some((seed) => seed.checkout.root === location))
          fail('The worktree location already exists.', 'Conflict');
        const head = { ...(source!.head ?? source!.files) };
        const seed: Seed = {
          checkout: {
            ...from,
            checkoutId: `${checkout.projectId}:${location}`,
            root: location,
            branch,
            worktree: 'linked',
          },
          files: head,
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
        if (checkout.vcs !== 'none') fail('This project is already a Git repository.');
        const { vcs: _, ...identity } = checkout;
        const initialized: GitCheckoutTarget = {
          ...identity,
          vcs: 'git',
          projectId: `${checkout.projectId}:git`,
          branch: 'main',
          worktree: 'main',
        };
        seeds[seeds.indexOf(seed)] = { ...seed, checkout: initialized, head: {}, index: {} };
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
            original = readOwn(seed.head, target.path);
          } else {
            original = readOwn(seed.index, target.path) ?? readOwn(seed.head, target.path);
          }
        }
        if (original === undefined) fail('Git baseline unavailable.', 'Unavailable');
        const working = entries(target.checkout).get(target.path);
        return {
          original: original!,
          working: working && !working.directory ? read(target) : null,
          title: `${area} · ${target.path}`,
        };
      }),
    lookupFiles: ({ checkout, query, limit = 100, history = [] }) =>
      call('lookupFiles', () => {
        const seed = exact(checkout);
        const eligible = (path: string) =>
          entries(checkout).has(path) &&
          !entries(checkout).get(path)!.directory &&
          !seed.ignored?.some((item) => isPathAtOrInside(path, item));
        const recent = [...new Set(history)]
          .filter((path) => entries(checkout).has(path) && !entries(checkout).get(path)!.directory)
          .map((path) => match(path, query))
          .filter((row): row is LookupMatch => !!row);
        const matches = query.trim()
          ? [...entries(checkout).keys()]
              .filter((path) => eligible(path) && !history.includes(path))
              .map((path) => match(path, query))
              .filter((row): row is LookupMatch => !!row)
              .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
          : [];
        return {
          matches: matches.slice(0, Math.max(1, Math.min(limit, 100))),
          history: recent.slice(0, 100),
          partial: matches.length > limit || recent.length > 100,
        };
      }),
    searchText: ({ checkout, query, matchCase, wholeWord, regex }) =>
      call('searchText', () => {
        const seed = exact(checkout);
        let pattern: RegExp;
        try {
          const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          pattern = new RegExp(wholeWord ? `\\b(?:${source})\\b` : source, matchCase ? 'g' : 'gi');
        } catch {
          return fail('Invalid regular expression.', 'InvalidInput');
        }
        let capped = false;
        const files = [...entries(checkout)]
          .filter(
            ([path, entry]) =>
              !entry.directory && !seed.ignored?.some((item) => isPathAtOrInside(path, item)),
          )
          .map(([path]) => {
            // The same limits as the workspace: 512-character lines, 64 ranges, 50 matches a file.
            const lines = read({ checkout, path })
              .text.split('\n')
              .map((line) => line.slice(0, 512));
            const matches = lines.flatMap((text, index) => {
              const ranges = [...text.matchAll(pattern)]
                .map((found) => ({ start: found.index, end: found.index + found[0].length }))
                .filter((range) => range.end > range.start)
                .slice(0, 64);
              return ranges.length
                ? [
                    {
                      line: index + 1,
                      text,
                      ranges,
                      before: lines.slice(Math.max(0, index - 3), index),
                      after: lines.slice(index + 1, index + 4),
                    },
                  ]
                : [];
            });
            if (matches.length > 50) capped = true;
            return { path, matches: matches.slice(0, 50) };
          })
          .filter((file) => file.matches.length)
          .sort((a, b) => a.path.localeCompare(b.path));
        return { files: files.slice(0, 200), partial: capped || files.length > 200 };
      }),
    inspectEntries: ({ checkout, paths }) =>
      call('inspectEntries', () => {
        if (!Array.isArray(paths) || paths.length < 1 || paths.length > 256)
          fail('Inspect between 1 and 256 entries.');
        return paths.map((path) => {
          pathCheck(path);
          const entry = entries(checkout).get(path) ?? fail('Entry unavailable.', 'Unavailable');
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
            : fail('Operation ID reused with changed payload.', 'Conflict');
        if (!operation.id || !operation.clientId) fail('Operation requires immutable IDs.');
        const map = new Map(entries(operation.checkout));
        const result: OperationResult = {
          id: operation.id,
          clientId: operation.clientId,
          recoveryChanges: [],
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
            fail('Entry identity changed.', 'Conflict');
        }
        if (operation.kind === 'import')
          fail('Memory adapter has no native file authority.', 'Unavailable');
        // Like the workspace, several sources move or copy into an existing folder ('' is the
        // root), keeping their names; one source goes to its exact destination path.
        const batch =
          (operation.kind === 'move' || operation.kind === 'copy') && operation.sources.length > 1;
        if (operation.destination) pathCheck(operation.destination);
        if (batch) {
          const folder = operation.destination ?? fail('Destination required.');
          if (folder && !map.get(folder)?.directory)
            fail('Batch destination must be an existing folder.');
          const names = operation.sources.map((source) =>
            source.target.path.split('/').at(-1)!.normalize('NFC').toLowerCase(),
          );
          if (new Set(names).size !== names.length)
            fail('Selection has colliding destination names.');
          if (
            operation.sources.some((source) =>
              operation.sources.some(
                (other) =>
                  other !== source && isPathAtOrInside(source.target.path, other.target.path),
              ),
            )
          )
            fail('Overlapping sources are not one selection.');
        }
        const destinationOf = (source: string) =>
          batch
            ? [operation.destination, source.split('/').at(-1)].filter(Boolean).join('/')
            : operation.destination;
        const replace = (destination: string, source?: string) => {
          const collision = [...map.keys()].find(
            (path) =>
              path.normalize('NFC').toLowerCase() === destination.normalize('NFC').toLowerCase() &&
              // Like a case-insensitive disk, a move may change only its name's case.
              !(operation.kind === 'move' && path === source),
          );
          if (collision && !operation.replacements?.some((ref) => ref.target.path === collision))
            fail('Destination exists. Explicit replacement consent required.', 'Conflict');
          if (collision)
            for (const path of map.keys()) if (isPathAtOrInside(path, collision)) map.delete(path);
          const parent = destination.split('/').slice(0, -1).join('/');
          if (parent && !map.get(parent)?.directory)
            fail('Destination parent unavailable.', 'Unavailable');
        };
        if (operation.kind === 'create-file' || operation.kind === 'create-directory') {
          const destination = operation.destination ?? fail('Destination required.');
          replace(destination);
          map.set(destination, {
            ...document(operation.text ?? ''),
            directory: operation.kind === 'create-directory',
          });
          result.items.push({ source: '', destination, outcome: 'completed' });
        } else
          for (const source of operation.sources) {
            const destination = destinationOf(source.target.path);
            if (operation.kind !== 'trash' && !destination) fail('Destination required.');
            if (destination && isPathAtOrInside(destination, source.target.path))
              fail('Cannot transfer an entry into itself.');
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
        const recovery = operationRecovery(result, map);
        files.set(checkoutKey(operation.checkout), map);
        for (const [clientId, state] of recovery.updates) recoveries.set(clientId, state);
        operations.set(key, { payload, result, bounds: recovery.bounds, acks: new Set() });
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
        if (!entry) fail('Unknown operation.');
        if (entry!.acks.has(clientId)) return;
        const state = recoveries.get(clientId)?.state;
        if (state && remapCollides(state, entry!.result))
          fail('Resolve the retained recovery collision before acknowledging.', 'Conflict');
        if (
          !entry!.bounds.has(clientId) ||
          (recoveries.get(clientId)?.publishedRevision ?? 0) <= entry!.bounds.get(clientId)!
        )
          fail('Publish reconciled recovery before acknowledging.', 'Conflict');
        entry!.acks.add(clientId);
      }),
    loadRecovery: ({ clientId }) =>
      call('loadRecovery', () => {
        const { revision, state } = recoveries.get(clientId) ?? {
          revision: 0,
          state: emptyRecovery(clientId),
        };
        return {
          revision,
          state,
          errors: [],
          operations: [...operations.values()]
            .filter((item) => item.bounds.has(clientId) && !item.acks.has(clientId))
            .map((item) => item.result),
        };
      }),
    persistRecovery: (input) =>
      call('persistRecovery', () => {
        const { clientId, requestId, expectedRevision, state } = input;
        if (
          typeof clientId !== 'string' ||
          !clientId.trim() ||
          typeof requestId !== 'string' ||
          !requestId.trim() ||
          !Number.isSafeInteger(expectedRevision) ||
          expectedRevision < 0 ||
          !state ||
          state.clientId !== clientId ||
          state.version !== 1
        )
          fail('Invalid recovery publication identity.');
        validateRecovery(state);
        const payload = JSON.stringify(input, (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, value[key]]),
              )
            : value,
        );
        const key = JSON.stringify([clientId, requestId]),
          previous = publications.get(key);
        if (previous)
          return previous.payload === payload
            ? previous.receipt
            : fail('Recovery request ID reused with changed input.');
        if ((recoveries.get(clientId)?.revision ?? 0) !== expectedRevision)
          fail('Recovery revision changed.', 'Conflict');
        const revision = expectedRevision + 1,
          receipt = { clientId, requestId, previousRevision: expectedRevision, revision };
        recoveries.set(clientId, {
          revision,
          state: structuredClone(state),
          publishedRevision: revision,
        });
        publications.set(key, { payload, receipt });
        stats.publications++;
        return receipt;
      }),
    getRecoveryPublication: ({ clientId, requestId }) =>
      call('getRecoveryPublication', () => {
        if (
          typeof clientId !== 'string' ||
          !clientId.trim() ||
          typeof requestId !== 'string' ||
          !requestId.trim()
        )
          fail('Invalid recovery publication identity.');
        return publications.get(JSON.stringify([clientId, requestId]))?.receipt ?? null;
      }),
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
    failNext(
      name: WorkspaceCommand,
      message = 'Injected IO failure',
      after = false,
      code: ApplicationError['code'] = after ? 'Uncertain' : 'Persistence',
    ) {
      faults.set(name, {
        error: new ApplicationError({ code, message }),
        after,
      });
    },
  };
}
