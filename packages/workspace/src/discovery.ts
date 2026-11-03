import { normalizeApplicationError } from '@moonbase/effect';
import { accessSync, constants } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { CheckoutTarget, CommandInput, CommandOutput } from '@moonbase/contracts/workspace';
import type { Directory } from './filesystem.ts';
import { matchPath, compareMatches } from './lookup.ts';
import { document, ensure, fail, path } from './validation.ts';

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
            this.gitExecutable,
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
      error =
        'Git ignore policy unavailable; all entries shown. ' +
        normalizeApplicationError(failure).message;
    }
    return {
      entries: entries
        .filter((e) => !input.hideIgnored || !e.ignored)
        .sort((a, b) => Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path)),
      partial: entries.length === 20000 || !!error,
      error,
    };
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
}
