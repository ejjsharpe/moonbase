import { spawn } from 'node:child_process';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { chatFileMatchLimit, isChatMentionPath, type ChatOutput } from '@moonbase/contracts/chat';
import { matchPath, compareMatches } from '@moonbase/contracts/lookup';

/** The most files one listing ranks; a larger folder is searched partially. */
export const chatFileCandidateLimit = 20000;
const listingMs = 10_000,
  listingBytes = 32 * 1024 * 1024,
  freshMs = 5_000,
  retainedFolders = 4,
  rankingCells = 16 * 1024 * 1024;
// Matches the editor's lookup exclusions, so both offer the same files.
const excluded = [
  '.git',
  '.svn',
  '.hg',
  '.jj',
  '.DS_Store',
  'Thumbs.db',
  'node_modules',
  'bower_components',
  '*.code-search',
];

type Listing = { files: string[]; partial: boolean };
/**
 * Runs a listing command in the folder; tests inject one. A failure carries the output so far as
 * `stdout`, with `killed` set when the timeout stopped it. `signal` aborts when the index closes;
 * the promise then settles once the command has exited.
 */
export type ChatFileListingRun = (
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
) => Promise<Buffer>;
type ListingFailure = { code?: unknown; killed?: boolean; stdout?: Buffer };

/** How long a stopped listing's process group has to exit after SIGTERM before SIGKILL. */
const stopGraceMs = 2_000;
const isGroupAlive = (group: number) => {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
};
const signalGroup = (group: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-group, signal);
  } catch {
    // The group already exited.
  }
};
/** Waits for every process in a stopped group to exit; its SIGKILL comes from `stop`'s timer. */
async function awaitGroupExit(group: number, stoppedAt: number) {
  while (isGroupAlive(group) && Date.now() - stoppedAt < stopGraceMs * 2)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

// Its own process group, so a listing stopped by its budget takes any children with it. The
// negative-PID kill is needed: a spawn signal or timeout reaches only the group leader.
const runListing: ChatFileListingRun = (executable, args, cwd, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('The file index is closed'));
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let length = 0,
      settled = false,
      stoppedAt: number | undefined,
      escalation: NodeJS.Timeout | undefined,
      failure: Record<string, unknown> | undefined;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      clearTimeout(escalation);
      signal.removeEventListener('abort', stopOnClose);
      const stdout = Buffer.concat(chunks);
      if (error) reject(Object.assign(error, { stdout }));
      else resolve(stdout);
    };
    const stop = (reason: Record<string, unknown>) => {
      if (stoppedAt !== undefined || child.pid === undefined) return;
      failure = reason;
      stoppedAt = Date.now();
      signalGroup(child.pid, 'SIGTERM');
      // Armed here, not on exit: a group that ignores SIGTERM may never exit or close its output.
      escalation = setTimeout(() => signalGroup(child.pid!, 'SIGKILL'), stopGraceMs);
    };
    const budget = setTimeout(() => stop({ killed: true }), listingMs);
    const stopOnClose = () => stop({ closed: true });
    signal.addEventListener('abort', stopOnClose, { once: true });
    child.stdout!.on('data', (chunk: Buffer) => {
      if (stoppedAt !== undefined) return;
      if (length + chunk.length > listingBytes) {
        chunks.push(chunk.subarray(0, listingBytes - length));
        length = listingBytes;
        return stop({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      }
      chunks.push(chunk);
      length += chunk.length;
    });
    child.once('error', (error) => {
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
      settle(error);
    });
    child.once('close', async (code, exitSignal) => {
      if (stoppedAt !== undefined) await awaitGroupExit(child.pid!, stoppedAt);
      if (failure) return settle(Object.assign(Error('The file listing was stopped'), failure));
      if (code === 0) return settle();
      settle(Object.assign(Error(`${executable} exited with ${code ?? exitSignal}`), { code }));
    });
  });
const isNotFound = (error: unknown) => (error as ListingFailure).code === 'ENOENT';
/** A listing cut short by its size or time budget: what it printed is a partial listing. */
const isTruncated = (error: unknown) =>
  (error as ListingFailure).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
  !!(error as ListingFailure).killed;
/** The complete NUL-terminated entries of a listing; a truncated one may end mid-entry. */
const splitListing = (bytes: Buffer, truncated: boolean) => {
  const end = truncated ? bytes.lastIndexOf(0) + 1 : bytes.length;
  return bytes
    .subarray(0, end)
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((path) => path.replace(/^\.\//, ''));
};
const countSegments = (path: string) => path.split('/').length;
const makeUnavailableError = () =>
  new ApplicationError({
    code: 'Unavailable',
    message: 'File search needs ripgrep or Git on the chat host, and a readable working folder.',
  });

/**
 * Lists a working folder's files the way coding agents do: ripgrep's ignore rules when ripgrep is
 * installed, otherwise Git's tracked and unignored files. The listing is the agent's view of the
 * folder, so it runs on the chat's host.
 */
export class ChatFileIndex {
  private readonly ripgrep: string;
  private readonly git: string;
  private readonly run: ChatFileListingRun;
  private readonly now: () => number;
  private readonly listings = new Map<string, { at: number; listing: Promise<Listing> }>();
  private readonly closing = new AbortController();
  private readonly running = new Set<Promise<unknown>>();
  constructor(
    options: {
      ripgrepExecutable?: string;
      gitExecutable?: string;
      run?: ChatFileListingRun;
      now?: () => number;
    } = {},
  ) {
    this.ripgrep = options.ripgrepExecutable ?? 'rg';
    this.git = options.gitExecutable ?? 'git';
    this.run = options.run ?? runListing;
    this.now = options.now ?? Date.now;
  }
  private list(cwd: string): Promise<Listing> {
    const retained = this.listings.get(cwd);
    if (retained && this.now() - retained.at < freshMs) return retained.listing;
    // One shared listing per folder; a caller's cancellation never aborts another caller's search.
    const listing = this.enumerate(cwd);
    this.listings.delete(cwd);
    this.listings.set(cwd, { at: this.now(), listing });
    for (const folder of this.listings.keys())
      if (this.listings.size > retainedFolders) this.listings.delete(folder);
    listing.catch(() => {
      if (this.listings.get(cwd)?.listing === listing) this.listings.delete(cwd);
    });
    return listing;
  }
  /** Runs one listing command; output cut short by its budget is kept as a partial listing. */
  private async runPartial(executable: string, args: string[], cwd: string) {
    try {
      const run = this.run(executable, args, cwd, this.closing.signal);
      const forget = () => this.running.delete(run);
      this.running.add(run);
      run.then(forget, forget);
      return { bytes: await run, truncated: false };
    } catch (error) {
      const stdout = (error as ListingFailure).stdout;
      if (isTruncated(error) && stdout) return { bytes: stdout, truncated: true };
      throw error;
    }
  }
  private async enumerate(cwd: string): Promise<Listing> {
    const args = ['--files', '--hidden', '--null', '--no-config', '--threads', '1'];
    for (const name of excluded) args.push('--glob', '!**/' + name);
    let output: { bytes: Buffer; truncated: boolean };
    try {
      output = await this.runPartial(this.ripgrep, args, cwd);
    } catch (error) {
      // ripgrep exits 1 when nothing matched, or 2 with partial output after unreadable entries.
      const stdout = (error as ListingFailure).stdout;
      const status = (error as ListingFailure).code;
      if (status === 1) output = { bytes: Buffer.alloc(0), truncated: false };
      else if (status === 2 && stdout?.length) output = { bytes: stdout, truncated: true };
      else if (!isNotFound(error)) throw makeUnavailableError();
      else
        try {
          output = await this.runPartial(
            this.git,
            ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            cwd,
          );
        } catch {
          throw makeUnavailableError();
        }
    }
    // A file whose path cannot be a mention (quotes, control characters) is never offered.
    const files = [...new Set(splitListing(output.bytes, output.truncated))].filter(
      (path) =>
        isChatMentionPath(path) && !path.split('/').some((segment) => excluded.includes(segment)),
    );
    files.sort((a, b) => countSegments(a) - countSegments(b) || a.localeCompare(b));
    return {
      files: files.slice(0, chatFileCandidateLimit),
      partial: output.truncated || files.length > chatFileCandidateLimit,
    };
  }
  /** Stops running listings and waits for their process groups to exit; later searches fail. */
  async close() {
    this.closing.abort();
    await Promise.allSettled(this.running);
  }
  /** Ranks files with the editor's fuzzy matcher; an empty query lists the shallowest files. */
  async find(
    cwd: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<ChatOutput<'findChatFiles'>> {
    const listing = await this.list(cwd);
    signal?.throwIfAborted();
    if (!query.trim())
      return {
        query,
        matches: listing.files
          .slice(0, chatFileMatchLimit)
          .map((path) => ({ path, positions: [] })),
        partial: listing.partial || listing.files.length > chatFileMatchLimit,
      };
    let partial = listing.partial;
    const matches = [];
    let cells = 0;
    for (const path of listing.files) {
      // The same ranking budget as the editor's lookup.
      cells += path.length * query.length;
      if (cells > rankingCells) {
        partial = true;
        break;
      }
      const match = matchPath(path, query);
      if (match) matches.push(match);
    }
    matches.sort(compareMatches);
    if (matches.length > chatFileMatchLimit) partial = true;
    return {
      query,
      matches: matches
        .slice(0, chatFileMatchLimit)
        .map((match) => ({ path: match.path, positions: match.positions })),
      partial,
    };
  }
}
