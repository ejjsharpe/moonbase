import { execFile } from 'node:child_process';
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
 * `stdout`, with `killed` set when the timeout stopped it.
 */
export type ChatFileListingRun = (
  executable: string,
  args: string[],
  cwd: string,
) => Promise<Buffer>;
type ListingFailure = { code?: unknown; killed?: boolean; stdout?: Buffer };

const runListing: ChatFileListingRun = (executable, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { cwd, encoding: 'buffer', maxBuffer: listingBytes, timeout: listingMs },
      (error, stdout) => (error ? reject(Object.assign(error, { stdout })) : resolve(stdout)),
    );
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
      return { bytes: await this.run(executable, args, cwd), truncated: false };
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
