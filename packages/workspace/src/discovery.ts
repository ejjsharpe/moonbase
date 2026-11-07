import { normalizeApplicationError } from '@moonbase/effect';
import { accessSync, constants } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { CheckoutTarget, CommandInput, CommandOutput } from '@moonbase/contracts/workspace';
import type { Directory } from './filesystem.ts';
import { matchPath, compareMatches } from './lookup.ts';
import { document, ensure, fail, path } from './validation.ts';

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

export class WorkspaceDiscovery {
  private readonly directory: (target: CheckoutTarget) => Promise<Directory>;
  private readonly policy: (target: CheckoutTarget) => void;
  private readonly gitExecutable: string;
  private readonly ripgrep: string | undefined;
  constructor(
    directory: (target: CheckoutTarget) => Promise<Directory>,
    policy: (target: CheckoutTarget) => void,
    gitExecutable: string,
    ripgrepExecutable: string | undefined,
  ) {
    this.directory = directory;
    this.policy = policy;
    this.gitExecutable = gitExecutable;
    this.ripgrep =
      ripgrepExecutable ??
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
  }
  async getBranch(directory: Directory, signal?: AbortSignal) {
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
  async listDirectory(input: CommandInput<'listDirectory'>, signal: AbortSignal) {
    path(input.path, true);
    ensure(
      input.includeIgnoredStatus !== false || !input.hideIgnored,
      'Ignore filtering requires ignore classification.',
    );
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
      }));
    if (input.includeIgnoredStatus === false)
      return {
        entries: entries.sort(
          (a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path),
        ),
        partial: entries.length === 20000,
      };
    const ignored = await this.getIgnoredPaths(
      { checkout: input.checkout, path: input.path, paths: entries.map((entry) => entry.path) },
      signal,
    );
    const ignoredPaths = new Set(ignored.paths);
    return {
      entries: entries
        .map((entry) => ({ ...entry, ignored: ignoredPaths.has(entry.path) }))
        .filter((entry) => !input.hideIgnored || !entry.ignored)
        .sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path)),
      partial: entries.length === 20000 || !!ignored.error,
      error: ignored.error,
    };
  }
  async getIgnoredPaths(
    input: CommandInput<'getIgnoredPaths'>,
    signal: AbortSignal,
  ): Promise<CommandOutput<'getIgnoredPaths'>> {
    path(input.path, true);
    input.paths.forEach((item) => {
      path(item);
      ensure(
        dirname(item) === (input.path || '.'),
        'Ignore paths must be immediate directory children.',
      );
    });
    const directory = await this.directory(input.checkout);
    await directory.entry(input.path, signal);
    let error: string | undefined;
    try {
      this.policy(input.checkout);
      const output = await directory
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
          signal,
        )
        .catch((error) => {
          if (error.status === 1 && !error.stderr) return Buffer.alloc(0);
          throw error;
        });
      return { paths: output.toString().split('\0').filter(Boolean) };
    } catch (failure) {
      error =
        'Git ignore policy unavailable; all entries shown. ' +
        normalizeApplicationError(failure).message;
    }
    return { paths: [], error };
  }
  async getStatus(target: CheckoutTarget, signal: AbortSignal) {
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
      return { branch: await this.getBranch(directory, signal), changes };
    } catch (error) {
      return {
        branch: target.branch,
        changes: [],
        error: 'Git status unavailable. ' + normalizeApplicationError(error).message,
      };
    }
  }
  async readComparison(input: CommandInput<'readComparison'>, signal: AbortSignal) {
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
        error: 'Git comparison unavailable. ' + normalizeApplicationError(error).message,
      };
    }
  }
  async lookupFiles(input: CommandInput<'lookupFiles'>, signal: AbortSignal) {
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
    try {
      this.policy(input.checkout);
      const args = ['--files', '--null', '--threads', '1', ...ripgrepPolicy];
      let enumerationError: string | undefined;
      const bytes = await directory
        .io(['lookup', this.requireRipgrep(), ...args, '.'], undefined, signal)
        .catch((error) => {
          const output = (error as { output?: Buffer }).output;
          if (output?.length && output.lastIndexOf(0) >= 0) {
            partial = true;
            enumerationError = normalizeApplicationError(error).message;
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
        error:
          'Discovery or ignore policy unavailable. ' + normalizeApplicationError(error).message,
      };
    }
  }
  private requireRipgrep() {
    if (!this.ripgrep)
      fail(
        'Unavailable',
        'Standalone ripgrep is unavailable. Supply the packaged ripgrepExecutable asset.',
      );
    return this.ripgrep!;
  }
  /** Searches file contents with ripgrep, honouring ignore files like `lookupFiles`. */
  async searchText(
    input: CommandInput<'searchText'>,
    signal: AbortSignal,
  ): Promise<CommandOutput<'searchText'>> {
    ensure(
      typeof input.query === 'string' &&
        input.query.length > 0 &&
        input.query.length <= 256 &&
        !/[\0\n\r]/.test(input.query),
      'Invalid search query.',
    );
    const directory = await this.directory(input.checkout);
    this.policy(input.checkout);
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
      error: string | undefined;
    const bytes = await directory
      .io(['lookup', this.requireRipgrep(), ...args], undefined, signal)
      .catch((failure) => {
        // Exit 1 is "no matches"; other exits may still carry complete JSON lines.
        if (failure.status === 1 && !failure.stderr) return Buffer.alloc(0);
        const output = (failure as { output?: Buffer }).output;
        const end = output?.lastIndexOf(10) ?? -1;
        const stderr = String(failure.stderr ?? '').trim();
        if (!output || end < 0) {
          // A bad pattern fails before any file is searched, so it leaves no JSON behind.
          if (failure.status === 2 && /^(rg: )?regex parse error/.test(stderr))
            fail(
              'InvalidInput',
              'Invalid regular expression: ' +
                stderr
                  .split('\n')
                  .at(-1)!
                  .replace(/^error: /, ''),
            );
          throw failure;
        }
        // Exit 2 after searching means some files could not be read; the rest are complete.
        if (failure.status === 2)
          error = 'Some files could not be searched. ' + stderr.split('\n')[0];
        else {
          partial = true;
          error = normalizeApplicationError(failure).message;
        }
        return output.subarray(0, end + 1);
      });
    const clip = (line: string) => line.replace(/\r?\n$/, '').slice(0, searchLimits.line);
    const files = new Map<
      string,
      {
        lines: Map<number, string>;
        matches: { line: number; text: string; ranges: { start: number; end: number }[] }[];
      }
    >();
    let total = 0;
    for (const row of bytes.toString().split('\n')) {
      if (!row) continue;
      let event: RipgrepEvent;
      try {
        event = JSON.parse(row);
      } catch {
        partial = true;
        continue;
      }
      if (event.type !== 'match' && event.type !== 'context') continue;
      const { data } = event;
      // Paths or lines that are not UTF-8 arrive as bytes; they cannot be shown faithfully.
      if (data.path.text === undefined || data.lines.text === undefined || !data.line_number)
        continue;
      const p = data.path.text.replace(/^\.\//, '');
      try {
        path(p);
      } catch {
        continue;
      }
      let file = files.get(p);
      if (!file) {
        if (files.size >= searchLimits.files) {
          partial = true;
          continue;
        }
        file = { lines: new Map(), matches: [] };
        files.set(p, file);
      }
      const text = clip(data.lines.text);
      file.lines.set(data.line_number, text);
      if (event.type === 'context') continue;
      // `--max-count` still reports matching lines inside the trailing context, so cap here too.
      if (total >= searchLimits.total || file.matches.length >= searchLimits.perFile) {
        partial = true;
        continue;
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
    }
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
  }
}
