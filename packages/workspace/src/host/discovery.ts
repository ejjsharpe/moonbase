import { Context, Effect, Layer } from 'effect';
import { accessSync, constants } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { CheckoutTarget, CommandInput, CommandOutput } from '@moonbase/contracts/workspace';
import {
  InvalidPathError,
  InvalidPatternError,
  InvalidRequestError,
  WorkspaceUnavailableError,
} from '@moonbase/contracts/workspace-host-errors';
import { attempt, type HostFailure } from '../attempt.ts';
import { HelperFailure, SystemFailure } from '../system-failures.ts';
import { matchPath, compareMatches } from '@moonbase/contracts/lookup';
import { document, errorText, path, requireGit } from '../validation.ts';
import { Checkouts, readBranch } from './checkouts.ts';
import { HostSettings } from './host-settings.ts';
import { parseGitStatus } from './git-status.ts';

/** Names discovery and text search never descend into, matching the native lookup preflight. */
const excludedNames = [
  '.git',
  '.svn',
  '.hg',
  '.jj',
  '.DS_Store',
  'Thumbs.db',
  'node_modules',
  'bower_components',
];
const ripgrepPolicy = [
  '--hidden',
  '--no-config',
  '--no-ignore-parent',
  '--no-ignore-global',
  ...[...excludedNames, '*.code-search'].flatMap((name) => ['--glob', '!**/' + name]),
];
const searchLimits = { files: 200, perFile: 50, total: 500, context: 3, ranges: 64, line: 512 };
type RipgrepText = { text?: string; bytes?: string };
type RipgrepEvent =
  | {
      type: 'match' | 'context';
      data: {
        path: RipgrepText;
        lines: RipgrepText;
        line_number?: number;
        submatches?: { start: number; end: number }[];
      };
    }
  | { type: 'begin' | 'end' | 'summary'; data: unknown };

/**
 * The reason in ripgrep's report of a pattern it cannot compile, or undefined for other failures.
 * A parse error gives its reason on an `error:` line, followed by a hint paragraph.
 */
export function regexFailure(stderr: string) {
  const lines = stderr.split('\n').map((line) => line.trim());
  const first = (lines[0] ?? '').replace(/^rg: /, '');
  if (!/\bregex\b/.test(first)) return undefined;
  const reason = lines.find((line) => line.startsWith('error: '))?.slice('error: '.length);
  return reason || first.replace(/:$/, '') || undefined;
}

/** What the helper reported, when `error` is its failure. */
const helperFailure = (error: unknown): Partial<HelperFailure> =>
  error instanceof HelperFailure ? error : {};

/** The first standalone ripgrep on `PATH`, when none is configured. */
const findRipgrep = () =>
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

/**
 * Reads a checkout without changing it: directory listings, Git ignore classification, status
 * and comparisons, ranked file lookup and text search.
 */
export class Discovery {
  private readonly checkouts: Checkouts['Service'];
  private readonly gitExecutable: string;
  private readonly ripgrep: string | undefined;
  constructor({
    checkouts,
    ripgrepExecutable,
  }: {
    checkouts: Checkouts['Service'];
    ripgrepExecutable: string | undefined;
  }) {
    this.checkouts = checkouts;
    this.gitExecutable = checkouts.git;
    this.ripgrep = ripgrepExecutable ?? findRipgrep();
  }
  listDirectory(input: CommandInput<'listDirectory'>) {
    return Effect.gen({ self: this }, function* () {
      yield* attempt(() => {
        path(input.path, true);
        if (!(input.includeIgnoredStatus !== false || !input.hideIgnored))
          throw new InvalidRequestError({ problem: 'ignore-filtering' });
      });
      const directory = yield* this.checkouts.directory(input.checkout);
      yield* directory.entry(input.path);
      const entries = (yield* directory.io(['list', input.path || '.']))
        .toString()
        .split('\0')
        .filter(Boolean)
        .slice(0, 20000)
        .map((row) => ({
          path: input.path ? input.path + '/' + row.slice(1) : row.slice(1),
          directory: row[0] === 'd',
        }));
      if (input.includeIgnoredStatus === false)
        return {
          entries: entries.sort(
            (a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path),
          ),
          partial: entries.length === 20000,
        };
      const ignored = yield* this.getIgnoredPaths({
        checkout: input.checkout,
        path: input.path,
        paths: entries.map((entry) => entry.path),
      });
      const ignoredPaths = new Set(ignored.paths);
      return {
        entries: entries
          .map((entry) => ({ ...entry, ignored: ignoredPaths.has(entry.path) }))
          .filter((entry) => !input.hideIgnored || !entry.ignored)
          .sort(
            (a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path),
          ),
        partial: entries.length === 20000 || !!ignored.error,
        error: ignored.error,
      };
    });
  }
  getIgnoredPaths(
    input: CommandInput<'getIgnoredPaths'>,
  ): Effect.Effect<CommandOutput<'getIgnoredPaths'>, HostFailure> {
    return Effect.gen({ self: this }, function* () {
      yield* attempt(() => {
        path(input.path, true);
        input.paths.forEach((item) => {
          path(item);
          if (!(dirname(item) === (input.path || '.')))
            throw new InvalidPathError({ problem: 'ignore-not-child' });
        });
      });
      const directory = yield* this.checkouts.directory(input.checkout);
      yield* directory.entry(input.path);
      // A plain folder has no Git ignore policy, so nothing in it is ignored.
      if (input.checkout.vcs === 'none') return { paths: [] };
      return yield* Effect.gen({ self: this }, function* () {
        yield* this.checkouts.policy(input.checkout);
        yield* directory.gitReady();
        const output = yield* directory
          .io(
            [
              'check-ignore',
              input.path || '.',
              this.gitExecutable,
              '-c',
              'core.excludesFile=/dev/null',
              'check-ignore',
              '-z',
              '--stdin',
            ],
            input.paths.join('\0') + (input.paths.length ? '\0' : ''),
          )
          .pipe(
            Effect.catch((error) =>
              helperFailure(error).status === 1 && !helperFailure(error).stderr
                ? Effect.succeed(Buffer.alloc(0))
                : Effect.fail(error),
            ),
          );
        return { paths: output.toString().split('\0').filter(Boolean) };
      }).pipe(
        Effect.catch((failure) =>
          Effect.succeed({
            paths: [],
            error: 'Git ignore policy unavailable; all entries shown. ' + errorText(failure),
          }),
        ),
      );
    });
  }
  /** A plain folder's status is empty, so a caller that polls it keeps working. */
  getStatus(target: CheckoutTarget) {
    return Effect.gen({ self: this }, function* () {
      const directory = yield* this.checkouts.directory(target);
      if (target.vcs === 'none') return { branch: '', changes: [] };
      return yield* Effect.gen(function* () {
        const output = yield* directory.git([
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--no-renames',
        ]);
        const changes = yield* attempt(() => {
          const changes = parseGitStatus(output.toString());
          for (const change of changes) path(change.path);
          return changes;
        });
        return { branch: yield* readBranch(directory), changes };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            branch: target.branch,
            changes: [],
            error: 'Git status unavailable. ' + errorText(error),
          }),
        ),
      );
    });
  }
  readComparison(input: CommandInput<'readComparison'>) {
    return Effect.gen({ self: this }, function* () {
      yield* attempt(() => {
        path(input.target.path);
        requireGit(input.target.checkout);
      });
      const directory = yield* this.checkouts.directory(input.target.checkout),
        p = input.target.path;
      const working = yield* directory
        .read(p)
        .pipe(
          Effect.catch((error) =>
            !(error instanceof SystemFailure && error.code === 'ENOENT') &&
            !helperFailure(error).stderr?.includes('No such file')
              ? Effect.fail(error)
              : Effect.succeed(null),
          ),
        );
      return yield* Effect.gen(function* () {
        let original = '';
        if (input.area === 'staged') {
          const exists = yield* directory.git(['rev-parse', '--verify', '--quiet', 'HEAD']).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              helperFailure(error).status === 1 ? Effect.succeed(false) : Effect.fail(error),
            ),
          );
          const entries = exists
            ? (yield* directory.git(['ls-tree', '-z', 'HEAD', '--', p])).toString()
            : '';
          if (entries) {
            const blob = yield* directory.git([
              'cat-file',
              'blob',
              entries.split(' ')[2].split('\t')[0],
            ]);
            original = (yield* attempt(() => document(blob))).text;
          }
        } else if (input.area === 'unstaged') {
          const entries = (yield* directory.git(['ls-files', '--stage', '-z', '--', p])).toString();
          if (entries) {
            const rows = entries.split('\0').filter(Boolean);
            const stage = rows.find((row) => row.split(' ')[2]?.startsWith('0\t'));
            if (!stage) return yield* new WorkspaceUnavailableError({ cause: 'merge-stages' });
            const blob = yield* directory.git(['cat-file', 'blob', stage.split(' ')[1]]);
            original = (yield* attempt(() => document(blob))).text;
          }
        }
        let title = 'Untracked file';
        if (input.area === 'staged') title = 'HEAD ↔ working buffer';
        else if (input.area === 'unstaged') title = 'Index ↔ working buffer';
        return { original, working, title };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            original: '',
            working,
            title: input.area,
            error: 'Git comparison unavailable. ' + errorText(error),
          }),
        ),
      );
    });
  }
  lookupFiles(input: CommandInput<'lookupFiles'>) {
    return Effect.gen({ self: this }, function* () {
      const directory = yield* this.checkouts.directory(input.checkout),
        limit = input.limit ?? 100;
      const supplied = input.history ?? [];
      yield* attempt(() => supplied.forEach((p) => path(p)));
      const excluded = (p: string) => excludedNames.includes(p) || p.endsWith('.code-search');
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
      return yield* Effect.gen({ self: this }, function* () {
        yield* this.checkouts.policy(input.checkout);
        const args = ['--files', '--null', '--threads', '1', ...ripgrepPolicy];
        let enumerationError: string | undefined;
        const ripgrep = yield* this.requireRipgrep();
        const bytes = yield* directory.io(['lookup', ripgrep, ...args, '.']).pipe(
          Effect.catch((error) => {
            const output = helperFailure(error).output;
            if (output?.length && output.lastIndexOf(0) >= 0) {
              partial = true;
              enumerationError = errorText(error);
              return Effect.succeed(output.subarray(0, output.lastIndexOf(0) + 1));
            }
            if (helperFailure(error).status === 1 && !helperFailure(error).stderr)
              return Effect.succeed(Buffer.alloc(0));
            return Effect.fail(error);
          }),
        );
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
        for (const [index, p] of candidates.slice(0, 20000).entries()) {
          // Lets other work run, and a cancelled lookup stop, between batches.
          if (index % 32 === 0) yield* Effect.interruptible(Effect.yieldNow);
          yield* attempt(() => path(p));
          const entry = yield* Effect.exit(directory.entry(p, spellings));
          if (entry._tag === 'Failure') partial = true;
          else if (!entry.value.directory) eligible.push(p);
        }
        // Exact entered paths have a scoped no-follow exception to discovery ignore/exclusions.
        const exactEntry = yield* Effect.exit(
          Effect.andThen(
            attempt(() => path(input.query)),
            directory.entry(input.query),
          ),
        );
        if (
          exactEntry._tag === 'Success' &&
          !exactEntry.value.directory &&
          !eligible.includes(input.query)
        )
          eligible.unshift(input.query);
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
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            matches: [],
            history,
            partial: true,
            error: 'Discovery or ignore policy unavailable. ' + errorText(error),
          }),
        ),
      );
    });
  }
  private requireRipgrep() {
    return this.ripgrep
      ? Effect.succeed(this.ripgrep)
      : Effect.fail(new WorkspaceUnavailableError({ cause: 'ripgrep' }));
  }
  /** Searches file contents with ripgrep, honouring ignore files like `lookupFiles`. */
  searchText(
    input: CommandInput<'searchText'>,
  ): Effect.Effect<CommandOutput<'searchText'>, HostFailure> {
    return Effect.gen({ self: this }, function* () {
      const directory = yield* this.checkouts.directory(input.checkout);
      yield* this.checkouts.policy(input.checkout);
      const args = [
        '--json',
        // Sorted (and so single-threaded) output keeps a capped result the same on every run.
        '--sort',
        'path',
        '--max-filesize',
        '2M',
        // One past the cap, so a file that reaches it is reported as partial.
        '--max-count',
        String(searchLimits.perFile + 1),
        '--context',
        String(searchLimits.context),
        ...ripgrepPolicy,
        input.matchCase ? '--case-sensitive' : '--ignore-case',
        ...(input.regex ? [] : ['--fixed-strings']),
        ...(input.wholeWord ? ['--word-regexp'] : []),
        '--regexp',
        input.query,
        '--',
        '.',
      ];
      let partial = false,
        error: string | undefined,
        received = false,
        // The file whose match passed the total cap: its trailing context still arrives.
        overflow: string | undefined;
      const clip = (line: string) => line.replace(/\r?\n$/, '').slice(0, searchLimits.line);
      const files = new Map<
        string,
        {
          lines: Map<number, string>;
          matches: { line: number; text: string; ranges: { start: number; end: number }[] }[];
        }
      >();
      let total = 0;
      // Parsed as ripgrep writes, so a broad query stops it once the result is full.
      const accept = (row: Buffer): 'stop' | void => {
        received = true;
        if (!row.length) return;
        let event: RipgrepEvent;
        try {
          event = JSON.parse(row.toString());
        } catch {
          partial = true;
          return;
        }
        if (event.type === 'end' && overflow !== undefined) return 'stop';
        if (event.type !== 'match' && event.type !== 'context') return;
        const { data } = event;
        // Paths or lines that are not UTF-8 arrive as bytes; they cannot be shown faithfully.
        if (data.path.text === undefined || data.lines.text === undefined || !data.line_number)
          return;
        const p = data.path.text.replace(/^\.\//, '');
        try {
          path(p);
        } catch {
          return;
        }
        let file = files.get(p);
        if (!file) {
          // Output is sorted by path, so every later file is past the cap too.
          if (files.size >= searchLimits.files || overflow !== undefined) {
            partial = true;
            return 'stop';
          }
          file = { lines: new Map(), matches: [] };
          files.set(p, file);
        }
        const text = clip(data.lines.text);
        file.lines.set(data.line_number, text);
        if (event.type === 'context') return;
        if (total >= searchLimits.total) {
          partial = true;
          overflow ??= p;
          return;
        }
        // `--max-count` still reports matching lines inside the trailing context, so cap here too.
        if (file.matches.length >= searchLimits.perFile) {
          partial = true;
          return;
        }
        total++;
        // ripgrep reports byte offsets; the renderer highlights UTF-16 offsets.
        const raw = Buffer.from(data.lines.text);
        const offset = (bytes: number) =>
          Math.min(raw.subarray(0, bytes).toString().length, text.length);
        file.matches.push({
          line: data.line_number,
          text,
          ranges: (data.submatches ?? [])
            .slice(0, searchLimits.ranges)
            .map((range) => ({ start: offset(range.start), end: offset(range.end) }))
            .filter((range) => range.end > range.start),
        });
      };
      const ripgrep = yield* this.requireRipgrep();
      yield* directory.lines(['lookup', ripgrep, ...args], accept).pipe(
        Effect.catch((cause) => {
          const failure = helperFailure(cause);
          // Exit 1 is "no matches".
          if (failure.status === 1 && !failure.stderr) return Effect.void;
          const stderr = String(failure.stderr ?? '').trim();
          if (!received) {
            // A bad pattern fails before any file is searched, so it leaves no JSON behind.
            const reason = failure.status === 2 ? regexFailure(stderr) : undefined;
            return Effect.fail(reason ? new InvalidPatternError({ reason }) : cause);
          }
          // Exit 2 after searching means some files could not be read; the rest are complete.
          if (failure.status === 2)
            error = 'Some files could not be searched. ' + stderr.split('\n')[0];
          else {
            partial = true;
            error = failure.uncertain
              ? 'Search stopped at its time or output limit; refine the query to see every match.'
              : 'Search ended early. ' + (stderr.split('\n')[0] || 'ripgrep failed.');
          }
          return Effect.void;
        }),
      );
      const nearby = (lines: Map<number, string>, line: number, step: 1 | -1) => {
        const found: string[] = [];
        for (let n = line + step; Math.abs(n - line) <= searchLimits.context; n += step) {
          const text = lines.get(n);
          if (text === undefined) break;
          found.push(text);
        }
        return step < 0 ? found.reverse() : found;
      };
      const results = [...files]
        .filter(([, file]) => file.matches.length)
        .map(([p, file]) => ({
          path: p,
          matches: file.matches.map((match) => ({
            ...match,
            before: nearby(file.lines, match.line, -1),
            after: nearby(file.lines, match.line, 1),
          })),
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      return { files: results, partial, ...(error ? { error } : {}) };
    });
  }
}

/** The host's read-only views of a checkout. */
export class WorkspaceDiscovery extends Context.Service<WorkspaceDiscovery, Discovery>()(
  'moonbase/workspace/Discovery',
) {
  static readonly layer = Layer.effect(
    WorkspaceDiscovery,
    Effect.gen(function* () {
      const { config } = yield* HostSettings;
      const checkouts = yield* Checkouts;
      return new Discovery({ checkouts, ripgrepExecutable: config.ripgrepExecutable });
    }),
  );
}
