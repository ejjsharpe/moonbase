import { Cause, Deferred, Effect, Exit, Option } from 'effect';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { HostInput, HostOutput } from '@moonbase/contracts/workspace-host';
import {
  CheckoutAccessError,
  CheckoutChangedError,
  InvalidRequestError,
  isWorkspaceHostError,
  toWireError,
  WorkspaceConflictError,
  WorkspaceUnavailableError,
  WorkspaceUnsupportedError,
} from '@moonbase/contracts/workspace-host-errors';
import { join } from 'node:path';
import { asWorkspaceFailure, attempt, type WorkspaceFailure } from '../attempt.ts';
import { asSharedOutcome } from '../owned-work.ts';
import type { HostRequestRecord } from '../schema.ts';
import { same } from '../validation.ts';
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
    isWorkspaceHostError(error) ? error : new WorkspaceUnavailableError({ cause: 'failed' }),
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
    WorkspaceFailure,
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
        return yield* new WorkspaceConflictError({ conflict: 'request-payload' });
      return (yield* Effect.interruptible(Deferred.await(first.outcome))) as HostOutput<K>;
    }
    // Reserved and registered as running in one step, so a duplicate waits for it instead of
    // finding a reservation nothing runs and reporting it interrupted.
    const outcome = Deferred.makeUnsafe<CheckoutTarget, WorkspaceFailure>();
    const record = yield* attempt(() => {
      const record = journal.reserveRequest(id, input);
      if (!record) requests.set(id, { input, outcome });
      return record;
    });
    if (record)
      return (yield* attempt(() =>
        journal.replayRequest(record, operation, input),
      )) as HostOutput<K>;
    const exit = yield* Effect.exit(settleRequest(journal, id, input, work));
    requests.delete(id);
    // A duplicate whose first request was cancelled learns that, not that the host closed.
    Deferred.doneUnsafe(outcome, asSharedOutcome(exit, operation));
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
  work: Effect.Effect<A, WorkspaceFailure, R>,
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(work);
    if (Exit.isSuccess(exit)) {
      // The worktree or repository exists; a failed record makes a replay report it interrupted.
      yield* Effect.exit(attempt(() => journal.settleRequest(id, { input, result: exit.value })));
      return exit.value;
    }
    const failure = Cause.findErrorOption(exit.cause);
    const recorded = Option.isSome(failure) ? recordedFailure(failure.value) : undefined;
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
      if (!chats) return yield* new WorkspaceUnsupportedError({ feature: 'chat-projects' });
      const folder = yield* Effect.tryPromise({
        try: () => chats.findOwnFolder(input.target),
        catch: asWorkspaceFailure,
      });
      const target = yield* Effect.interruptible(checkouts.open(folder));
      // `open` resolves links: a folder replaced by one since it was checked opens elsewhere.
      if (target.root !== folder)
        return yield* new CheckoutAccessError({ refusal: 'chat-folder-changed' });
      // Only its own `.git` folder: a `.git` file (or a link) would make it another repository's.
      const { common, gitEntry } = yield* attempt(() => checkouts.approval(target));
      if (common && (gitEntry?.pointer !== null || common.path !== join(folder, '.git')))
        return yield* new CheckoutAccessError({ refusal: 'chat-folder-repository' });
      yield* Effect.tryPromise({
        try: () => chats.markAsProject(input.requestId, input.target),
        catch: asWorkspaceFailure,
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
      if (!(target.vcs === 'none'))
        return yield* new InvalidRequestError({ problem: 'already-git' });
      const directory = yield* checkouts.directory(target);
      if (yield* attempt(() => checkouts.gitEntry(target.root)))
        return yield* new WorkspaceConflictError({ conflict: 'git-entry' });
      yield* attempt(() => {
        if (journal.getPendingSaves(target).length)
          throw new InvalidRequestError({ problem: 'save-pending' });
        if (journal.getUnsettledCheckoutOperations(target, input.installationId).length)
          throw new InvalidRequestError({ problem: 'operation-pending' });
      });
      yield* Effect.interruptible(directory.initializeGit());
      // `open` approves a Git target here only as the main worktree of the folder's own `.git`.
      const initialized = yield* Effect.interruptible(checkouts.open(target.root));
      if (!(initialized.vcs === 'git'))
        return yield* new CheckoutChangedError({ change: 'not-initialized' });
      return initialized as HostOutput<'initializeRepository'>;
    }),
  );
