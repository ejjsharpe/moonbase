import { Cache, Cause, Effect, Exit, Fiber, FiberSet, type Scope } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { ChatUnavailableError, type ChatError } from '@moonbase/contracts/chat-errors';
import { chatFileMatchLimit, isChatMentionPath, type ChatOutput } from '@moonbase/contracts/chat';
import { matchPath, compareMatches } from '@moonbase/contracts/lookup';
import { ProcessGroups } from '@moonbase/process-group';
import {
  defaultListingTiming,
  makeRunListing,
  type ChatFileListingRun,
  type ChatFileListingTiming,
} from './file-listing.ts';

export type { ChatFileListingRun, ChatFileListingTiming, ListingOutput } from './file-listing.ts';
export { ListingError } from './file-listing.ts';

/** The most files one listing ranks; a larger folder is searched partially. */
export const chatFileCandidateLimit = 20000;
const fresh = '5 seconds',
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
 * Whether Git can run without side effects. On macOS without the Xcode command-line tools,
 * `/usr/bin/git` is a stub that offers to install them; `xcode-select -p` only asks.
 */
const checkGit = Effect.gen(function* () {
  if (process.platform !== 'darwin') return true;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .exitCode(
      ChildProcess.make('/usr/bin/xcode-select', ['-p'], { stdout: 'ignore', stderr: 'ignore' }),
    )
    .pipe(
      Effect.timeout('5 seconds'),
      Effect.map((code) => code === 0),
      Effect.orElseSucceed(() => false),
    );
});
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
const makeUnavailableError = () => new ChatUnavailableError({ reason: 'file-search' });

export type ChatFileIndexOptions = {
  ripgrepExecutable?: string;
  gitExecutable?: string;
  /** Replaces the listing process; tests inject one. */
  run?: ChatFileListingRun;
  /** Overrides the listing time budget and stop grace; tests shorten them. */
  timing?: Partial<ChatFileListingTiming>;
  /** Whether Git may run; on macOS, whether the command-line tools are installed. */
  canRunGit?: Effect.Effect<boolean>;
};
/** Ranks a folder's files for a mention query. */
export type ChatFileIndex = {
  find(cwd: string, query: string): Effect.Effect<ChatOutput<'findChatFiles'>, ChatError>;
};

/**
 * Lists a working folder's files the way coding agents do: ripgrep's ignore rules when ripgrep is
 * installed, otherwise Git's tracked and unignored files, when Git can run without prompting to
 * install anything. The listing is the agent's view of the folder, so it runs on the chat's host.
 * One listing per folder serves the searches of the next few seconds; it runs as the index's own
 * work, so a search that is cancelled leaves it running for the others, and closing the index
 * stops it and waits for its process group.
 */
export const makeChatFileIndex = (
  options: ChatFileIndexOptions = {},
): Effect.Effect<
  ChatFileIndex,
  never,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | ProcessGroups
> =>
  Effect.gen(function* () {
    const ripgrep = options.ripgrepExecutable ?? 'rg';
    const git = options.gitExecutable ?? 'git';
    const run =
      options.run ??
      makeRunListing({ ...defaultListingTiming, ...options.timing }, yield* ProcessGroups);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const canRunGit =
      options.canRunGit ??
      Effect.provideService(checkGit, ChildProcessSpawner.ChildProcessSpawner, spawner);
    const enumerate = (cwd: string): Effect.Effect<Listing, ChatError> =>
      Effect.gen(function* () {
        const args = ['--files', '--hidden', '--null', '--no-config', '--threads', '1'];
        for (const name of excluded) args.push('--glob', '!**/' + name);
        const output = yield* run(ripgrep, args, cwd).pipe(
          Effect.catch((error) => {
            // ripgrep exits 1 when nothing matched, or 2 with partial output after unreadable
            // entries.
            if (error.status === 1)
              return Effect.succeed({ bytes: Buffer.alloc(0), truncated: false });
            if (error.status === 2 && error.output.length)
              return Effect.succeed({ bytes: error.output, truncated: true });
            if (error.reason !== 'missing') return Effect.fail(makeUnavailableError());
            return Effect.flatMap(canRunGit, (allowed) =>
              allowed
                ? Effect.mapError(
                    run(git, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd),
                    makeUnavailableError,
                  )
                : Effect.fail(makeUnavailableError()),
            );
          }),
        );
        // A file whose path cannot be a mention (quotes, control characters) is never offered.
        const files = [...new Set(splitListing(output.bytes, output.truncated))].filter(
          (path) =>
            isChatMentionPath(path) &&
            !path.split('/').some((segment) => excluded.includes(segment)),
        );
        files.sort((a, b) => countSegments(a) - countSegments(b) || a.localeCompare(b));
        return {
          files: files.slice(0, chatFileCandidateLimit),
          partial: output.truncated || files.length > chatFileCandidateLimit,
        };
      });
    const listings = yield* FiberSet.make<Listing, ChatError>();
    // Holds each folder's listing fiber, so the listing outlives a search that stops waiting.
    const cache = yield* Cache.make<string, Fiber.Fiber<Listing, ChatError>>({
      capacity: retainedFolders,
      timeToLive: fresh,
      lookup: (cwd) => FiberSet.run(listings, enumerate(cwd)),
    });
    const list = (cwd: string) =>
      Effect.gen(function* () {
        const listing = yield* Cache.get(cache, cwd);
        const exit = yield* Fiber.await(listing);
        if (Exit.isSuccess(exit)) return exit.value;
        // A failure is not kept: the next search lists again.
        yield* Cache.invalidateWhen(cache, cwd, (cached) => cached === listing);
        // A listing the closing index stopped fails like any other.
        return yield* Cause.hasInterruptsOnly(exit.cause)
          ? Effect.fail(makeUnavailableError())
          : Effect.failCause(exit.cause);
      });
    return {
      find: (cwd, query) => Effect.map(list(cwd), (listing) => rankFiles(listing, query)),
    };
  });

/** Ranks files with the editor's fuzzy matcher; an empty query lists the shallowest files. */
function rankFiles(listing: Listing, query: string): ChatOutput<'findChatFiles'> {
  if (!query.trim())
    return {
      query,
      matches: listing.files.slice(0, chatFileMatchLimit).map((path) => ({ path, positions: [] })),
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
