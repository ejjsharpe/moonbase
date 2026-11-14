import { Cause, Deferred, Effect, Exit } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { HostInput, HostOutput } from '@moonbase/contracts/workspace-host';
import {
  isWorkspaceHostError,
  toWireError,
  WorkspaceAccessDeniedError,
  WorkspaceConflictError,
  WorkspaceUnavailableError,
  WorkspaceUnsupportedError,
} from '@moonbase/contracts/workspace-host-errors';
import { join } from 'node:path';
import { attempt } from '../attempt.ts';
import type { HostRequestRecord } from '../schema.ts';
import { ensure, same } from '../validation.ts';
import { makeChatWorktree } from './chat-worktrees.ts';
import { Checkouts } from './checkouts.ts';
import { HostJournal, type RequestOperation } from './host-journal.ts';
import { HostSettings } from './host-settings.ts';
import { WorkspaceWorktrees } from './worktrees.ts';

/** Refusals that repeat for the same input; every other failure may succeed on retry. */
const deterministicRefusals: ReadonlySet<string> = new Set([
  'InvalidInput',
  'Unauthorized',
  'Conflict',
  'Incompatible',
]);
/** The wire code and text a request's failure is recorded with; anything unknown is `Unavailable`. */
const recordedFailure = (error: unknown) =>
  toWireError(
    isWorkspaceHostError(error)
      ? error
      : new WorkspaceUnavailableError({ reason: 'Application effect failed' }),
  );

/**
 * Runs a request not seen before and records its outcome; a repeat gets that outcome, and one
 * that arrives while the first runs waits for it. A reservation nothing in this process runs
 * was left by an earlier process, so its request is reported interrupted.
 */
const once = <K extends RequestOperation>(
  operation: K,
  input: HostInput<K>,
  work: Effect.Effect<
    HostOutput<K>,
    unknown,
    Checkouts | HostJournal | HostSettings | WorkspaceWorktrees
  >,
) =>
  Effect.gen(function* () {
    const journal = yield* HostJournal;
    const requests = journal.runningRequests;
    const id = journal.requestId(operation, input);
    const first = requests.get(id);
    if (first) {
      if (!same(first.input, input))
        return yield* new WorkspaceConflictError({
          reason: 'Request ID already belongs to a different payload.',
        });
      return (yield* Effect.interruptible(Deferred.await(first.outcome))) as HostOutput<K>;
    }
    const record = yield* attempt(() => journal.reserveRequest(id, input));
    if (record)
      return (yield* attempt(() =>
        journal.replayRequest(record, operation, input),
      )) as HostOutput<K>;
    const outcome = Deferred.makeUnsafe<CheckoutTarget, unknown>();
    requests.set(id, { input, outcome });
    const exit = yield* Effect.exit(settleRequest(journal, id, input, work));
    requests.delete(id);
    Deferred.doneUnsafe(outcome, exit);
    return yield* exit;
  });

/**
 * Runs a reserved request. A success or a deterministic refusal is recorded and replayed for the
 * ID. An unresolved outcome (incomplete cleanup) keeps the reservation, so a replay reports the
 * request interrupted instead of retrying over leftovers. Every other failure, cancellation and
 * an unknown failure included, releases the reservation so a retry runs again.
 */
const settleRequest = <A extends CheckoutTarget, R>(
  journal: HostJournal['Service'],
  id: string,
  input: HostRequestRecord['input'],
  work: Effect.Effect<A, unknown, R>,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(work);
    if (Exit.isSuccess(exit)) {
      // The worktree or repository exists; a failed record makes a replay report it interrupted.
      yield* Effect.exit(attempt(() => journal.settleRequest(id, { input, result: exit.value })));
      return exit.value;
    }
    const error = Cause.hasInterruptsOnly(exit.cause) ? undefined : Cause.squash(exit.cause);
    const recorded = error === undefined ? undefined : recordedFailure(error);
    // A failed record makes a replay of this ID report the request interrupted.
    yield* Effect.exit(
      attempt(() => {
        if (recorded && deterministicRefusals.has(recorded.code))
          journal.settleRequest(id, {
            input,
            error: { code: recorded.code, message: recorded.message },
          });
        else if (recorded?.code !== 'Uncertain') journal.releaseRequest(id);
      }),
    );
    return yield* Effect.failCause(exit.cause);
  });

/** Replays the first outcome of a `createWorktree` request ID; a new ID creates the worktree. */
export const createWorktree = (input: HostInput<'createWorktree'>) =>
  once(
    'createWorktree',
    input,
    Effect.gen(function* () {
      const checkouts = yield* Checkouts;
      const worktrees = yield* WorkspaceWorktrees;
      yield* attempt(() => checkouts.approval(input.checkout));
      return yield* worktrees.createWorktree(input);
    }),
  );

/**
 * Replays the first outcome of a `createChatWorktree` request ID; a new ID makes the worktree at
 * the location derived from `root`'s repository.
 */
export const createChatWorktree = (input: HostInput<'createChatWorktree'>) =>
  once('createChatWorktree', input, makeChatWorktree(input));

/**
 * Replays the first outcome of a `turnChatIntoProject` request ID. A new ID checks the chat's own
 * folder is one the daemon made, opens it as a checkout and only then marks the chat, so a
 * failure leaves the chat as it was; the checkout it returns is the folder's. The folder must be
 * plain or its own repository: a `.git` file there could name any other repository.
 */
export const turnChatIntoProject = (input: HostInput<'turnChatIntoProject'>) =>
  once(
    'turnChatIntoProject',
    input,
    Effect.gen(function* () {
      const { chats } = yield* HostSettings;
      const checkouts = yield* Checkouts;
      if (!chats)
        return yield* new WorkspaceUnsupportedError({
          reason: 'This host cannot turn a chat into a project.',
        });
      const folder = yield* Effect.tryPromise({
        try: () => chats.findOwnFolder(input.target),
        catch: (error) => error,
      });
      const target = yield* Effect.interruptible(checkouts.open(folder));
      // `open` resolves links: a folder replaced by one since it was checked opens elsewhere.
      if (target.root !== folder)
        return yield* new WorkspaceAccessDeniedError({
          reason: 'The folder changed before it opened as a project. Inspect it.',
        });
      // Only its own `.git` folder: a `.git` file (or a link) would make it another repository's.
      const { common, gitEntry } = yield* attempt(() => checkouts.approval(target));
      if (common && (gitEntry?.pointer !== null || common.path !== join(folder, '.git')))
        return yield* new WorkspaceAccessDeniedError({
          reason: 'The chat folder belongs to another repository. Inspect its .git.',
        });
      yield* Effect.tryPromise({
        try: () => chats.markAsProject(input.requestId, input.target),
        catch: (error) => error,
      });
      return target;
    }),
  );

/**
 * Replays the first outcome of an `initializeRepository` request ID. A new ID runs `git init` in
 * a plain folder with no `.git` entry and no unsettled saves or file operations, then approves
 * and returns it as the main worktree of its own new repository.
 */
export const initializeRepository = (input: HostInput<'initializeRepository'>) =>
  once(
    'initializeRepository',
    input,
    Effect.gen(function* () {
      const checkouts = yield* Checkouts;
      const journal = yield* HostJournal;
      const target = input.checkout;
      yield* attempt(() =>
        ensure(target.vcs === 'none', 'This project is already a Git repository.'),
      );
      const directory = yield* checkouts.directory(target);
      if (yield* attempt(() => checkouts.gitEntry(target.root)))
        return yield* new WorkspaceConflictError({
          reason: 'This folder already has a .git entry. Reopen it to use its repository.',
        });
      yield* attempt(() => {
        ensure(
          !journal.getPendingSaves(target).length,
          'A save awaits recovery. Resolve it before initializing Git.',
        );
        ensure(
          !journal.getUnsettledCheckoutOperations(target, input.installationId).length,
          'A file operation awaits recovery publication or inspection. Resolve it before initializing Git.',
        );
      });
      yield* Effect.interruptible(directory.initializeGit());
      // `open` approves a Git target here only as the main worktree of the folder's own `.git`.
      const initialized = yield* Effect.interruptible(checkouts.open(target.root));
      yield* attempt(() =>
        ensure(initialized.vcs === 'git', 'Git did not initialize this folder. Inspect it.'),
      );
      return initialized as HostOutput<'initializeRepository'>;
    }),
  );
