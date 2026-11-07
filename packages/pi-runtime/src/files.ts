import { execFile } from 'node:child_process';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { chatFileMatchLimit, type ChatOutput } from '@moonbase/contracts/chat';
import { decodeChatOutput } from '@moonbase/contracts/chat-schema';
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
/** Runs a listing command in the folder; tests inject one. */
export type ChatFileListingRun = (
  executable: string,
  args: string[],
  cwd: string,
) => Promise<Buffer>;

const run: ChatFileListingRun = (executable, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { cwd, encoding: 'buffer', maxBuffer: listingBytes, timeout: listingMs },
      (error, stdout) => (error ? reject(Object.assign(error, { stdout })) : resolve(stdout)),
    );
  });
const missing = (error: unknown) => (error as { code?: unknown }).code === 'ENOENT';
const split = (bytes: Buffer) =>
  bytes
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((path) => path.replace(/^\.\//, ''));

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
    this.run = options.run ?? run;
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
  private async enumerate(cwd: string): Promise<Listing> {
    const args = ['--files', '--hidden', '--null', '--no-config', '--threads', '1'];
    for (const name of excluded) args.push('--glob', '!**/' + name);
    let bytes: Buffer;
    try {
      bytes = await this.run(this.ripgrep, args, cwd);
    } catch (error) {
      // ripgrep exits 1 when nothing matched, or 2 with partial output after unreadable entries.
      const stdout = (error as { stdout?: Buffer }).stdout;
      const status = (error as { code?: unknown }).code;
      if (status === 1 || (status === 2 && stdout?.length)) bytes = stdout ?? Buffer.alloc(0);
      else if (!missing(error)) throw unavailable();
      else
        try {
          bytes = await this.run(
            this.git,
            ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
            cwd,
          );
        } catch {
          throw unavailable();
        }
    }
    const files = [...new Set(split(bytes))].filter(
      (path) => !path.split('/').some((segment) => excluded.includes(segment)),
    );
    files.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    return {
      files: files.slice(0, chatFileCandidateLimit),
      partial: files.length > chatFileCandidateLimit,
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
    let partial = listing.partial;
    const matches = [];
    let cells = 0;
    for (const path of listing.files) {
      // The same ranking budget as the editor's lookup.
      cells += path.length * Math.max(query.length, 1);
      if (cells > rankingCells) {
        partial = true;
        break;
      }
      const match = query.trim() ? matchPath(path, query) : { path, score: 0, positions: [] };
      if (match) matches.push(match);
    }
    if (query.trim()) matches.sort(compareMatches);
    const mentionable = [];
    for (const match of matches) {
      if (mentionable.length === chatFileMatchLimit) {
        partial = true;
        break;
      }
      const result = { path: match.path, positions: match.positions };
      // A file whose path cannot be a mention (quotes, control characters) is not offered.
      try {
        decodeChatOutput('findChatFiles', { query, matches: [result], partial: false });
        mentionable.push(result);
      } catch {
        /* Skipped. */
      }
    }
    return { query, matches: mentionable, partial };
  }
}
const depth = (path: string) => path.split('/').length;
const unavailable = () =>
  new ApplicationError({
    code: 'Unavailable',
    message: 'File search needs ripgrep or Git on the chat host, and a readable working folder.',
  });
