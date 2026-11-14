import { isPathAtOrInside } from '@moonbase/contracts/paths';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Cause, Deferred, Effect, Exit, FiberSet, Option, Stream } from 'effect';
import type {
  WorkspaceHostServiceShape,
  WorkspaceServiceShape,
} from '@moonbase/contracts/services';
import type {
  CheckoutTarget,
  CommandInput,
  CommandOutput,
  SaveResult,
  WorkspaceCommand,
  WorkspaceOperation,
} from '@moonbase/contracts/workspace';
import {
  getErrorCode,
  InvalidRecoveryRequestError,
  isWorkspaceError,
  RecoveryConflictError,
  UnexpectedHostReplyError,
  UnreadableRecoveryError,
  type WorkspaceError,
} from '@moonbase/contracts/workspace-errors';
import {
  InvalidRequestError,
  type WorkspaceHostError,
} from '@moonbase/contracts/workspace-host-errors';
import { attempt, type WorkspaceFailure } from '../attempt.ts';
import { cancellationPoint } from '../cancellation.ts';
import { getOperationPaths } from '../operation-paths.ts';
import { asWorkspaceError, runOwned, withWorkspaceErrors } from '../owned-work.ts';
import { canonical, errorText, folded, hash, key, path, same } from '../validation.ts';
import type { OperationRecord, SaveRecord } from './client-schema.ts';
import type { ClientStore } from './client-store.ts';
import {
  acknowledgeOperation,
  adoptHostResult,
  getOperationStatus,
  markOperationAcknowledged,
  publishOperation,
  replayOperation,
} from './operation-recovery.ts';
import { RecoveryContext, type HostPorts, type Recoveries } from './recovery-context.ts';
import { loadRecovery } from './recovery-load.ts';
import { persistRecovery } from './recovery-publication.ts';
import { acknowledgeSaves, getBaseline, publishSaves, replaySave } from './save-recovery.ts';

/**
 * The host as the recovery asks it. `cancellable` calls stop when their caller cancels; the
 * others (a question whose answer settles what a cancelled request did) always finish.
 */
function makePorts(
  host: WorkspaceHostServiceShape,
  installationId: string,
  cancellable: boolean,
): HostPorts {
  const port = <A>(call: Effect.Effect<A, WorkspaceHostError>) =>
    cancellable ? Effect.interruptible(call) : call;
  return {
    readFile: (target) => port(host.readFile(target)),
    verifyCheckout: (checkout) => port(host.verifyCheckout({ checkout })),
    saveStatus: (input) => port(host.saveStatus({ installationId, ...input })),
    acknowledgeSave: (input) => port(host.acknowledgeSave({ installationId, ...input })),
    operationStatus: (input) => port(host.operationStatus({ installationId, ...input })),
    acknowledgeOperation: (input) => port(host.acknowledgeOperation({ installationId, ...input })),
    listOperations: (input) => port(host.listOperations(input)),
  };
}
/** The code a failed exit ends with, or `Cancelled` when it was only interrupted. */
const exitCode = (cause: Cause.Cause<WorkspaceFailure>) => {
  if (Cause.hasInterruptsOnly(cause)) return 'Cancelled' as const;
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure) && isWorkspaceError(failure.value)
    ? getErrorCode(failure.value)
    : 'Unavailable';
};

/**
 * The editor's workspace: file operations go to the file host, while this client keeps the
 * recovery (drafts, editor state), the intents for what it has sent, and the feed cursor. A
 * save or operation is recorded durably before it is sent, and a lost reply is resolved through
 * the host's status queries, never sent again as new work.
 */
export const makeClientWorkspace = ({
  store,
  host,
  hostWaitMs,
}: {
  store: ClientStore;
  host: WorkspaceHostServiceShape;
  hostWaitMs: number;
}) =>
  Effect.gen(function* () {
    const installationId = store.installationId;
    // Every command runs here, so closing the client stops each and waits for it to end before
    // the store closes.
    const operations = yield* FiberSet.make<unknown, WorkspaceError>();
    const context = new RecoveryContext({
      store,
      host: makePorts(host, installationId, true),
      installationId,
    });
    /** The same recovery, asking the host questions a cancelled caller cannot stop. */
    const settled = context.withHost(makePorts(host, installationId, false));
    /** Calls under a stored request ID that are in flight, so a concurrent duplicate shares one. */
    const requests = new Map<string, Deferred.Deferred<unknown, WorkspaceFailure>>();
    const run = <A>(work: Effect.Effect<A, WorkspaceFailure>, persistence = false) =>
      runOwned(operations, withWorkspaceErrors(work, persistence));
    const fromHost = <A>(call: Effect.Effect<A, WorkspaceHostError>) =>
      run(Effect.interruptible(call));

    /**
     * Sends a host operation under a request ID kept durably before it is sent, so a repeat of
     * the same call after a lost reply or a crash asks for the first outcome instead of starting
     * a second one. The ID is kept only while the outcome is unknown (`Uncertain`, or cancelled
     * after sending); an answer, including a refusal, ends it, since the host replays a refusal
     * for the same ID and a retry then has to be a new request. A repeat that is `Uncertain`
     * again (the host reports the first request interrupted) ends it too, so the next call is a
     * new request. A duplicate made while the call is in flight shares it.
     */
    const withRequestId = <A>(
      operation: string,
      input: unknown,
      send: (requestId: string) => Effect.Effect<A, WorkspaceFailure>,
    ): Effect.Effect<A, WorkspaceFailure> =>
      Effect.gen(function* () {
        const name = hash(canonical([operation, input]));
        const running = requests.get(name);
        if (running) return (yield* Effect.interruptible(Deferred.await(running))) as A;
        const outcome = Deferred.makeUnsafe<unknown, WorkspaceFailure>();
        requests.set(name, outcome);
        // Lets a duplicate sent at the same time find this one in flight and share it.
        yield* Effect.yieldNow;
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const kept = (yield* attempt(() => store.get<{ requestId: string }>('requests', name)))
              ?.requestId;
            const requestId = kept ?? randomUUID();
            if (!kept) yield* attempt(() => store.put('requests', name, { requestId }));
            const sent = yield* Effect.exit(send(requestId));
            const code = Exit.isFailure(sent) ? exitCode(sent.cause) : undefined;
            const unknown = code === 'Cancelled' || (code === 'Uncertain' && !kept);
            if (!unknown) yield* attempt(() => store.delete('requests', name));
            return yield* sent;
          }),
        );
        requests.delete(name);
        Deferred.doneUnsafe(outcome, exit);
        return yield* exit;
      });

    const initializeRepository = (target: CheckoutTarget) =>
      Effect.gen(function* () {
        if ((yield* attempt(() => context.getPendingSaves(target))).length)
          return yield* new InvalidRequestError({ problem: 'save-pending' });
        if ((yield* attempt(() => context.getUnsettledCheckoutOperations(target))).length)
          return yield* new InvalidRequestError({ problem: 'operation-pending' });
        return yield* withRequestId('initializeRepository', target, (requestId) =>
          Effect.interruptible(
            host.initializeRepository({ installationId, requestId, checkout: target }),
          ),
        );
      });

    const saveFile = (
      input: CommandInput<'saveFile'>,
    ): Effect.Effect<SaveResult, WorkspaceFailure> =>
      Effect.gen(function* () {
        yield* attempt(() => path(input.target.path));
        const proposed = { text: input.text, version: hash(input.text) };
        const publication = yield* attempt(() => store.publication(input.clientId));
        const id = key(input.clientId, input.requestId),
          previous = yield* attempt(() => store.readSave(id));
        if (previous) return yield* replaySave(context, id, input, previous);
        yield* context.assertSettled(input.target.checkout, [input.target.path], input.clientId);
        const baseline = yield* getBaseline(context, input);
        yield* cancellationPoint;
        const record: SaveRecord = {
          state: 'sent',
          input,
          baseline,
          recoveryPublication: publication,
        };
        const occupied = yield* store.reserveSave(id, record);
        if (occupied) return yield* replaySave(context, id, input, occupied);
        context.activeSaves.set(id, input.target.checkout.checkoutId);
        return yield* Effect.gen(function* () {
          const sent = yield* Effect.exit(
            Effect.interruptible(host.saveFile({ installationId, ...input })).pipe(
              Effect.filterOrFail(
                (reply) => reply.kind !== 'saved' || reply.version === proposed.version,
                () => new UnexpectedHostReplyError(),
              ),
            ),
          );
          if (Exit.isFailure(sent)) {
            // A request the host refused before admitting (invalid or unauthorized) leaves
            // nothing to resolve. After a cancellation, a malformed reply or a host-side
            // cancellation only the host can say whether it was admitted. Anything else is kept
            // with its text until the next load asks for its status.
            const code = exitCode(sent.cause);
            const refused = code === 'InvalidInput' || code === 'Unauthorized';
            let admitted = !refused;
            if (code === 'Cancelled' || code === 'Incompatible')
              admitted = yield* settled.host
                .saveStatus({ clientId: input.clientId, requestId: input.requestId })
                .pipe(
                  Effect.map((status) => status.kind !== 'not-started'),
                  Effect.orElseSucceed(() => true),
                );
            if (!admitted) yield* store.deleteSave(id);
            return yield* Effect.failCause(sent.cause);
          }
          const reply = sent.value;
          record.result =
            reply.kind === 'saved'
              ? {
                  kind: 'saved',
                  disk: { text: input.text, version: reply.version },
                  recoveryChanges: [],
                  ...(reply.persistencePending ? { persistencePending: true } : {}),
                  ...(reply.message === undefined ? {} : { message: reply.message }),
                }
              : reply;
          const published = yield* Effect.exit(publishSaves(context, [record]));
          if (Exit.isFailure(published)) {
            // The intent stays as sent: a repeat or the next load asks the host for this outcome.
            if (record.result.kind !== 'saved') return record.result;
            return {
              ...record.result,
              persistencePending: true,
              message:
                'Saved to disk; durable request publication failed: ' +
                errorText(Cause.squash(published.cause)),
            };
          }
          yield* acknowledgeSaves(settled, [record]);
          return record.result;
        }).pipe(Effect.ensuring(Effect.sync(() => context.activeSaves.delete(id))));
      });

    /** A move or copy onto a path that holds recovery drafts is refused, so they are not orphaned. */
    const assertDestinationAvailable = (input: WorkspaceOperation, recoveries: Recoveries) => {
      if (input.kind === 'trash' || input.destination === undefined) return Effect.void;
      const create = input.kind.startsWith('create-');
      const sources = input.sources.map((s) => s.target.path);
      // Imports name no source paths, so the destination itself stands in for each item's target.
      // A multi-item native import is checked at folder granularity (opaque tokens, no basenames).
      const destinations =
        sources.length > 1
          ? sources.map((p) => join(input.destination!, basename(p)))
          : [input.destination];
      const conflicts = (draftPath: string) =>
        destinations.some(
          (destination, i) =>
            isPathAtOrInside(folded(draftPath), folded(destination)) &&
            (create || input.kind === 'import' || !isPathAtOrInside(draftPath, sources[i] ?? '')),
        );
      // An unreadable recovery may hold a draft here.
      if (recoveries.unreadable.length)
        return Effect.fail(
          new UnreadableRecoveryError({ client: recoveries.unreadable[0].client }),
        );
      for (const { state } of recoveries.readable)
        if (
          state.drafts.some(
            (d) =>
              d.target.checkout.checkoutId === input.checkout.checkoutId &&
              conflicts(d.target.path),
          )
        )
          return Effect.fail(new InvalidRecoveryRequestError({ problem: 'destination-drafts' }));
      return Effect.void;
    };

    /**
     * Answers a repeated operation from its intent. One the host never saw did not run, and asking
     * about it retired its ID there, so the intent is discarded and the caller repeats it as a new
     * operation; it is never sent again under the same ID.
     */
    const replayOwnOperation = (id: string, input: WorkspaceOperation, record: OperationRecord) =>
      Effect.gen(function* () {
        const replay = yield* replayOperation(context, id, input, record);
        if (!replay.missing) return replay.result;
        yield* attempt(() => store.delete('operations', id));
        return yield* new RecoveryConflictError({ conflict: 'operation-not-sent' });
      });

    const mutate = (input: WorkspaceOperation) =>
      Effect.gen(function* () {
        const id = key(input.clientId, input.id),
          previous = yield* attempt(() => store.get<OperationRecord>('operations', id));
        if (previous) return yield* replayOwnOperation(id, input, previous);
        yield* context.assertSettled(input.checkout, getOperationPaths(input), input.clientId);
        const recoveries = yield* attempt(() => store.readRecoveries());
        yield* assertDestinationAvailable(input, recoveries);
        const revisions: Record<string, number> = {
          [input.clientId]:
            recoveries.readable.find((r) => r.client === input.clientId)?.revision ?? 0,
        };
        // Another client's unreadable recovery is reported when that client loads.
        for (const { client, revision, state } of recoveries.readable)
          if (state.checkouts.some((c) => same(c, input.checkout))) revisions[client] = revision;
        const record: OperationRecord = {
          open: true,
          input,
          publicationRevisions: revisions,
          acknowledgedBy: [],
          result: {
            id: input.id,
            clientId: input.clientId,
            recoveryChanges: [],
            checkout: input.checkout,
            kind: input.kind,
            outcome: 'uncertain',
            items: [],
            message:
              'Admitted operation. Interrupted items must be inspected, never repeated automatically.',
          },
        };
        yield* cancellationPoint;
        const occupied = yield* attempt(() => store.reserve('operations', id, record));
        if (occupied) return yield* replayOwnOperation(id, input, occupied);
        context.activeOperations.set(id, input.checkout.checkoutId);
        return yield* Effect.gen(function* () {
          const sent = yield* Effect.exit(
            Effect.interruptible(host.mutate({ installationId, ...input })),
          );
          let reply;
          if (Exit.isSuccess(sent)) reply = sent.value;
          else {
            // The host answers for anything it admitted; a request it never saw leaves no intent.
            const status = yield* Effect.option(
              settled.host.operationStatus({ clientId: input.clientId, id: input.id }),
            );
            if (Option.isSome(status) && status.value === null)
              yield* attempt(() => store.delete('operations', id));
            if (Option.isNone(status) || !status.value) return yield* Effect.failCause(sent.cause);
            reply = status.value;
          }
          adoptHostResult(record, reply);
          yield* publishOperation(context, id, record);
          return record.result;
        }).pipe(Effect.ensuring(Effect.sync(() => context.activeOperations.delete(id))));
      });

    const call =
      <K extends WorkspaceCommand>(
        work: (input: CommandInput<K>) => Effect.Effect<CommandOutput<K>, WorkspaceFailure>,
        persistence = false,
      ) =>
      (input: CommandInput<K>) =>
        run(work(input), persistence);
    const service: WorkspaceServiceShape = {
      openCheckout: (input) => fromHost(host.openCheckout(input)),
      readFile: (input) => fromHost(host.readFile(input)),
      listDirectory: (input) => fromHost(host.listDirectory(input)),
      getIgnoredPaths: (input) => fromHost(host.getIgnoredPaths(input)),
      gitStatus: (input) => fromHost(host.gitStatus(input)),
      listWorktrees: (input) => fromHost(host.listWorktrees(input)),
      readComparison: (input) => fromHost(host.readComparison(input)),
      lookupFiles: (input) => fromHost(host.lookupFiles(input)),
      searchText: (input) => fromHost(host.searchText(input)),
      inspectEntries: (input) => fromHost(host.inspectEntries(input)),
      createWorktree: call<'createWorktree'>((input) =>
        withRequestId('createWorktree', input, (requestId) =>
          Effect.interruptible(host.createWorktree({ installationId, requestId, ...input })),
        ),
      ),
      initializeRepository: call<'initializeRepository'>((input) =>
        initializeRepository(input.checkout),
      ),
      saveFile: call<'saveFile'>(saveFile),
      mutate: call<'mutate'>(mutate),
      operationStatus: call<'operationStatus'>((input) => getOperationStatus(context, input), true),
      acknowledgeOperation: call<'acknowledgeOperation'>(
        (input) =>
          Effect.gen(function* () {
            if (!(yield* acknowledgeOperation(context, input))) return;
            yield* settled.host
              .acknowledgeOperation({ clientId: input.operationClientId, id: input.id })
              .pipe(
                Effect.andThen(
                  markOperationAcknowledged(context, key(input.operationClientId, input.id)),
                ),
                // The host keeps the entry; the next load acknowledges it again.
                Effect.ignore,
              );
          }),
        true,
      ),
      loadRecovery: call<'loadRecovery'>(
        (input) => loadRecovery(context, input.clientId, hostWaitMs),
        true,
      ),
      getRecoveryPublication: call<'getRecoveryPublication'>(
        (input) =>
          attempt(
            () => store.recoveryPublication(input.clientId, input.requestId)?.receipt ?? null,
          ),
        true,
      ),
      persistRecovery: call<'persistRecovery'>((input) => persistRecovery(context, input), true),
      watch: (input) =>
        host.watch(input).pipe(Stream.mapError((error) => asWorkspaceError(error, false))),
    };
    return service;
  });
