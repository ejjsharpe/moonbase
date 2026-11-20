import { Cache, Duration, Effect, Equal, Exit, Fiber, FiberMap, Hash, Option } from 'effect';
import { areJsonValuesEqual } from '@moonbase/contracts/common';
import { UnauthorizedError } from '@moonbase/contracts/errors';
import { IncompatibleHostError, RequestReusedError } from '@moonbase/contracts/host-errors';
import {
  ChatAccessError,
  ChatBusyError,
  InvalidChatRequestError,
} from '@moonbase/contracts/chat-errors';
import { FolderMissingError, FolderRefusedError } from '@moonbase/contracts/folder-errors';
import { ProviderSetupRefusedError } from '@moonbase/contracts/provider-errors';

/** Request IDs of recent daemon mutations; a repeat of one returns its outcome instead of rerunning. */
const rememberedDaemonRequests = 256;
// Errors a daemon raises only before it applies anything, so a refused request may be sent again.
const refusals = [
  FolderRefusedError,
  FolderMissingError,
  ProviderSetupRefusedError,
  InvalidChatRequestError,
  ChatAccessError,
  ChatBusyError,
  IncompatibleHostError,
  UnauthorizedError,
  RequestReusedError,
];
const isRefused = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.every(
    (reason) =>
      reason._tag === 'Fail' && refusals.some((refusal) => reason.error instanceof refusal),
  );

/** A mutation's input, which its request ID binds whole. */
type MutationInput = { requestId?: string; ownerId?: string };
/** A mutation's outcome, with the request that ran it. */
type Outcome = { operation: string; input: MutationInput; exit: Exit.Exit<unknown, unknown> };

/**
 * A mutation's request ID, scoped to its owner so one owner's IDs never answer for another's.
 * Equal by ID alone; it carries the request that runs when the ID is new.
 */
class RequestKey implements Equal.Equal {
  readonly id: string;
  constructor(
    readonly operation: string,
    readonly input: MutationInput,
    readonly run: Effect.Effect<unknown, unknown>,
  ) {
    this.id = JSON.stringify([input.ownerId ?? null, input.requestId]);
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof RequestKey && that.id === this.id;
  }
  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

/**
 * Runs each daemon mutation once per request ID. A repeat with the same operation and input joins
 * the first run, or returns its outcome once it settled, unless the daemon refused it outright,
 * so nothing of it applied; a repeat with another is `RequestReusedError`. The last
 * `rememberedDaemonRequests` outcomes are kept, and a run still going is joined however many
 * requests came after it. Runs belong to the scope, and finish even if their callers go.
 */
export const makeMutationReplay = Effect.gen(function* () {
  const running = yield* FiberMap.make<string, Outcome>();
  // Finding a request's run and starting it if there is none happen in one synchronous step:
  // `FiberMap.run` forks and records the run without yielding, so no other lookup comes between.
  const findOrStart = (key: RequestKey) =>
    Effect.suspend(() => {
      const run = FiberMap.getUnsafe(running, key.id);
      if (Option.isSome(run)) return Effect.succeed(run.value);
      const outcome = Effect.map(Effect.exit(key.run), (exit) => ({
        operation: key.operation,
        input: key.input,
        exit,
      }));
      return FiberMap.run(running, key.id, Effect.uninterruptible(outcome));
    });
  const outcomes = yield* Cache.makeWith(
    (key: RequestKey) => Effect.flatMap(findOrStart(key), Fiber.join),
    {
      capacity: rememberedDaemonRequests,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && isRefused(exit.value.exit) ? Duration.zero : Duration.infinity,
    },
  );
  return <A>(operation: string, input: MutationInput, run: Effect.Effect<A, unknown>) =>
    Effect.gen(function* () {
      const outcome = yield* Cache.get(outcomes, new RequestKey(operation, input, run));
      if (outcome.operation !== operation || !areJsonValuesEqual(outcome.input, input))
        return yield* new RequestReusedError();
      return (yield* outcome.exit) as A;
    });
});

/** Runs a daemon mutation once per request ID; see `makeMutationReplay`. */
export type MutationReplay = Effect.Success<typeof makeMutationReplay>;
