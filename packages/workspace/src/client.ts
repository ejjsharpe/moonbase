import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Cause, Deferred, Effect, Exit, Scope, type FiberSet } from 'effect';
import { releaseResource } from '@moonbase/effect';
import { decodeWorkspaceInput, decodeWorkspaceOutput } from '@moonbase/contracts/workspace-schema';
import type {
  WorkspaceHostServiceShape,
  WorkspaceServiceShape,
} from '@moonbase/contracts/services';
import {
  ApplicationError,
  type CheckoutTarget,
  type CommandInput,
  type CommandOutput,
  type WorkspaceCommand,
  type WorkspaceOperation,
} from '@moonbase/contracts/workspace';
import { admit, applicationError, type AdmissionOwner } from './admission.ts';
import { ClientStore } from './client-store.ts';
import type { OperationRecord, SaveRecord } from './client-schema.ts';
import { WorkspaceRecovery, type HostPorts } from './recovery.ts';
import {
  affected,
  canonical,
  ensure,
  errorText,
  fail,
  folded,
  hash,
  identifier,
  key,
  path,
  textDocument,
} from './validation.ts';

export type ClientOwnership = {
  operations: FiberSet.FiberSet<unknown, ApplicationError>;
  operationScope: Scope.Closeable;
};

/** Runs a host effect for a Promise caller; cancelling the signal interrupts the host request. */
async function run<A>(effect: Effect.Effect<A, ApplicationError>, signal: AbortSignal) {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterrupts(exit.cause))
    throw new ApplicationError({ code: 'Cancelled', message: 'Workspace command cancelled.' });
  throw Cause.squash(exit.cause);
}
/** A settled question is asked on a fresh signal, so a cancelled caller still learns the answer. */
const settled = () => new AbortController().signal;

/**
 * The editor's workspace: file operations go to the file host, while this client keeps the
 * recovery (drafts, editor state), the intents for what it has sent, and the feed cursor. A
 * save or operation is recorded durably before it is sent, and a lost reply is resolved through
 * the host's status queries, never sent again as new work.
 */
export class ClientWorkspace implements AdmissionOwner {
  readonly ownership: ClientOwnership;
  readonly store: ClientStore;
  readonly service: WorkspaceServiceShape;
  readonly recovery: WorkspaceRecovery;
  readonly signals = new Set<AbortController>();
  readonly closeCompletion = Deferred.makeUnsafe<void>();
  closing = false;
  closed = false;
  private readonly installationId: string;
  get operations() {
    return this.ownership.operations;
  }
  constructor(
    config: {
      dataDirectory: string;
      installationId: string;
      legacyHostIds?: string[];
      hostWaitMs?: number;
    },
    ownership: ClientOwnership,
    host: WorkspaceHostServiceShape,
  ) {
    this.ownership = ownership;
    this.installationId = config.installationId;
    this.store = new ClientStore(config.dataDirectory, config.installationId);
    const installationId = this.installationId;
    const ports: HostPorts = {
      openCheckout: (root, signal) => run(host.openCheckout({ root }), signal),
      readFile: (target, signal) => run(host.readFile(target), signal),
      verifyCheckout: (checkout, signal) => run(host.verifyCheckout({ checkout }), signal),
      saveStatus: (input, signal) => run(host.saveStatus({ installationId, ...input }), signal),
      acknowledgeSave: (input, signal) =>
        run(host.acknowledgeSave({ installationId, ...input }), signal),
      operationStatus: (input, signal) =>
        run(host.operationStatus({ installationId, ...input }), signal),
      acknowledgeOperation: (input, signal) =>
        run(host.acknowledgeOperation({ installationId, ...input }), signal),
      listOperations: (input, signal) => run(host.listOperations(input), signal),
    };
    this.recovery = new WorkspaceRecovery(
      this.store,
      ports,
      installationId,
      config.legacyHostIds,
      config.hostWaitMs,
    );
    const call =
      <K extends WorkspaceCommand>(
        operation: K,
        fn: (input: CommandInput<K>, signal: AbortSignal) => Promise<CommandOutput<K>>,
        persistence = false,
      ) =>
      (input: CommandInput<K>) =>
        Effect.flatMap(
          Effect.try({
            try: () => decodeWorkspaceInput(operation, input),
            catch: applicationError,
          }),
          (captured) =>
            this.effect(
              async (signal) => decodeWorkspaceOutput(operation, await fn(captured, signal)),
              persistence,
            ),
        );
    this.service = {
      openCheckout: call<'openCheckout'>('openCheckout', (input, signal) =>
        run(host.openCheckout(input), signal),
      ),
      readFile: call<'readFile'>('readFile', (input, signal) => run(host.readFile(input), signal)),
      listDirectory: call<'listDirectory'>('listDirectory', (input, signal) =>
        run(host.listDirectory(input), signal),
      ),
      getIgnoredPaths: call<'getIgnoredPaths'>('getIgnoredPaths', (input, signal) =>
        run(host.getIgnoredPaths(input), signal),
      ),
      gitStatus: call<'gitStatus'>('gitStatus', (input, signal) =>
        run(host.gitStatus(input), signal),
      ),
      listWorktrees: call<'listWorktrees'>('listWorktrees', (input, signal) =>
        run(host.listWorktrees(input), signal),
      ),
      readComparison: call<'readComparison'>('readComparison', (input, signal) =>
        run(host.readComparison(input), signal),
      ),
      lookupFiles: call<'lookupFiles'>('lookupFiles', (input, signal) =>
        run(host.lookupFiles(input), signal),
      ),
      searchText: call<'searchText'>('searchText', (input, signal) =>
        run(host.searchText(input), signal),
      ),
      inspectEntries: call<'inspectEntries'>('inspectEntries', (input, signal) =>
        run(host.inspectEntries(input), signal),
      ),
      createWorktree: call<'createWorktree'>('createWorktree', (input, signal) =>
        this.withRequestId('createWorktree', input, (requestId) =>
          run(host.createWorktree({ installationId, requestId, ...input }), signal),
        ),
      ),
      initializeRepository: call<'initializeRepository'>('initializeRepository', (input, signal) =>
        this.initializeRepository(input.checkout, signal, host),
      ),
      saveFile: call<'saveFile'>('saveFile', (input, signal) => this.saveFile(input, signal, host)),
      mutate: call<'mutate'>('mutate', (input, signal) => this.mutate(input, signal, host)),
      operationStatus: call<'operationStatus'>(
        'operationStatus',
        async (input, signal) => {
          await this.recovery.recoverEvidence(signal);
          return this.recovery.getOperation(key(input.clientId, input.id))?.result ?? null;
        },
        true,
      ),
      acknowledgeOperation: call<'acknowledgeOperation'>(
        'acknowledgeOperation',
        async (input) => {
          if (!this.recovery.acknowledgeOperation(input)) return;
          try {
            await run(
              host.acknowledgeOperation({
                installationId,
                clientId: input.operationClientId,
                id: input.id,
              }),
              settled(),
            );
            this.recovery.markOperationAcknowledged(key(input.operationClientId, input.id));
          } catch {
            /* The host keeps the entry; the next load acknowledges it again. */
          }
        },
        true,
      ),
      loadRecovery: call<'loadRecovery'>(
        'loadRecovery',
        (input, signal) => this.recovery.loadRecovery(input.clientId, signal),
        true,
      ),
      getRecoveryPublication: call<'getRecoveryPublication'>(
        'getRecoveryPublication',
        async (input) => this.recovery.getRecoveryPublication(input),
        true,
      ),
      persistRecovery: call<'persistRecovery'>(
        'persistRecovery',
        (input, signal) => this.recovery.persistRecovery(input, signal),
        true,
      ),
      watch: (input) => host.watch(input),
    };
  }
  effect<A>(fn: (signal: AbortSignal) => Promise<A>, persistence = false) {
    return admit(this, fn, persistence);
  }

  private async initializeRepository(
    target: CheckoutTarget,
    signal: AbortSignal,
    host: WorkspaceHostServiceShape,
  ) {
    ensure(
      !this.recovery.getPendingSaves(target).length,
      'A save awaits recovery. Resolve it before initializing Git.',
    );
    ensure(
      !this.recovery.getUnsettledCheckoutOperations(target).length,
      'A file operation awaits recovery publication or inspection. Resolve it before initializing Git.',
    );
    return this.withRequestId('initializeRepository', target, (requestId) =>
      run(
        host.initializeRepository({
          installationId: this.installationId,
          requestId,
          checkout: target,
        }),
        signal,
      ),
    );
  }

  /**
   * Sends a host operation under a request ID kept durably before it is sent, so a repeat of the
   * same call after a lost reply or a crash asks for the first outcome instead of starting a
   * second one. The ID is kept only while the outcome is unknown (`Uncertain`, or cancelled after
   * sending); an answer, including a refusal, ends it, since the host replays a refusal for the
   * same ID and a retry then has to be a new request.
   */
  private async withRequestId<A>(
    operation: string,
    input: unknown,
    send: (requestId: string) => Promise<A>,
  ) {
    const name = hash(canonical([operation, input]));
    const requestId =
      this.store.get<{ requestId: string }>('requests', name)?.requestId ?? randomUUID();
    this.store.put('requests', name, { requestId });
    try {
      const output = await send(requestId);
      this.store.delete('requests', name);
      return output;
    } catch (error) {
      if (!ApplicationError.is(error) || !['Uncertain', 'Cancelled'].includes(error.code))
        this.store.delete('requests', name);
      throw error;
    }
  }

  private async saveFile(
    input: CommandInput<'saveFile'>,
    signal: AbortSignal,
    host: WorkspaceHostServiceShape,
  ) {
    identifier(input.clientId);
    identifier(input.requestId);
    path(input.target.path);
    textDocument(input.text);
    ensure(
      typeof input.expectedVersion === 'string' && /^[a-f0-9]{64}$/.test(input.expectedVersion),
      'Invalid expected content version.',
    );
    const publication = this.recovery.getPublication(input.clientId);
    const id = key(input.clientId, input.requestId),
      previous = this.recovery.getSaveRecord(id);
    if (previous) return this.recovery.replaySave(id, input, previous);
    this.recovery.assertSettled(input.target.checkout, [input.target.path], input.clientId);
    const baseline = await this.recovery.getBaseline(input, signal);
    if (signal.aborted) fail('Cancelled', 'Save cancelled before admission.');
    const record: SaveRecord = { input, baseline, recoveryPublication: publication };
    const occupied = this.recovery.reserveSave(id, record);
    if (occupied)
      return this.recovery.replaySave(id, input, this.recovery.getSaveRecord(id) ?? occupied);
    this.recovery.startSave(id, input.target.checkout.checkoutId);
    try {
      let reply;
      try {
        reply = await run(host.saveFile({ installationId: this.installationId, ...input }), signal);
      } catch (error) {
        // A request the host refused before admitting (invalid or unauthorized) leaves nothing
        // to resolve. After a cancellation, a malformed reply or a host-side cancellation only the
        // host can say whether it was admitted. Anything else is kept
        // with its text until the next load asks for its status.
        const refused =
          !signal.aborted &&
          ApplicationError.is(error) &&
          ['InvalidInput', 'Unauthorized'].includes(error.code);
        let admitted = !refused;
        if (
          !refused &&
          (signal.aborted ||
            (ApplicationError.is(error) && ['Incompatible', 'Cancelled'].includes(error.code)))
        )
          admitted = await run(
            host.saveStatus({
              installationId: this.installationId,
              clientId: input.clientId,
              requestId: input.requestId,
            }),
            settled(),
          ).then(
            (status) => status.kind !== 'not-started',
            () => true,
          );
        if (!admitted) this.recovery.discardSave(id);
        throw error;
      }
      record.result =
        reply.kind === 'saved'
          ? {
              kind: 'saved',
              disk: reply.disk,
              recoveryChanges: [],
              ...(reply.persistencePending ? { persistencePending: true } : {}),
              ...(reply.message === undefined ? {} : { message: reply.message }),
            }
          : reply;
      try {
        this.recovery.publishSaves([record]);
      } catch (error) {
        if (record.result.kind === 'saved')
          record.result = {
            ...record.result,
            persistencePending: true,
            message: 'Saved to disk; durable request publication failed: ' + errorText(error),
          };
        this.recovery.retainSave(id, record);
      }
      await this.recovery.acknowledgeSaves([record], settled());
      return record.result;
    } finally {
      this.recovery.finishSave(id);
    }
  }

  private async mutate(
    input: WorkspaceOperation,
    signal: AbortSignal,
    host: WorkspaceHostServiceShape,
  ) {
    identifier(input.clientId);
    identifier(input.id);
    const id = key(input.clientId, input.id),
      previous = this.recovery.getOperation(id);
    let record: OperationRecord;
    if (previous) {
      const replay = await this.recovery.replayOperation(id, input, previous, signal);
      if (!replay.missing) return replay.result;
      record = previous;
    } else {
      this.recovery.assertSettled(input.checkout, this.footprint(input), input.clientId);
      this.assertDestinationAvailable(input);
      record = {
        input,
        publicationRevisions: this.recovery.getPublicationRevisions(input.checkout, input.clientId),
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
      if (signal.aborted) fail('Cancelled', 'Operation cancelled before admission.');
      const occupied = this.recovery.reserveOperation(id, record);
      if (occupied)
        return (
          await this.recovery.replayOperation(
            id,
            input,
            this.recovery.getOperation(id) ?? occupied,
            signal,
          )
        ).result;
    }
    this.recovery.startOperation(id, input.checkout.checkoutId);
    try {
      let reply;
      try {
        reply = await run(host.mutate({ installationId: this.installationId, ...input }), signal);
      } catch (error) {
        // The host answers for anything it admitted; a request it never saw leaves no intent.
        const status = await run(
          host.operationStatus({
            installationId: this.installationId,
            clientId: input.clientId,
            id: input.id,
          }),
          settled(),
        ).catch(() => undefined);
        if (status === null) this.recovery.discardOperation(id);
        if (!status) throw error;
        reply = status;
      }
      this.recovery.adoptHostResult(record, reply);
      try {
        this.recovery.publishOperation(id, record);
      } catch (error) {
        this.recovery.retainPublication(id, record, error);
      }
      return record.result;
    } finally {
      this.recovery.finishOperation(id);
    }
  }
  private footprint(input: WorkspaceOperation) {
    const sources = input.sources.map((s) => s.target.path);
    if (input.destination === undefined) return sources;
    return [
      ...sources,
      ...(sources.length > 1
        ? sources.map((p) => join(input.destination!, basename(p)))
        : [input.destination]),
    ];
  }
  /** A move or copy onto a path that holds recovery drafts is refused, so they are not orphaned. */
  private assertDestinationAvailable(input: WorkspaceOperation) {
    if (input.kind === 'trash' || input.destination === undefined) return;
    const create = input.kind.startsWith('create-');
    const sources = input.sources.map((s) => s.target.path);
    // Imports name no source paths, so the destination itself stands in for each item's target.
    const destinations =
      sources.length > 1
        ? sources.map((p) => join(input.destination!, basename(p)))
        : [input.destination];
    destinations.forEach((destination, i) =>
      this.recovery.assertDestinationAvailable(
        input.checkout,
        (draftPath) =>
          affected(folded(draftPath), folded(destination)) &&
          (create || input.kind === 'import' || !affected(draftPath, sources[i] ?? '')),
      ),
    );
  }

  close(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.closing) return Deferred.await(this.closeCompletion);
      this.closing = this.closed = true;
      for (const signal of this.signals) signal.abort();
      return Effect.gen({ self: this }, function* () {
        const outcomes = yield* Effect.forEach(
          [
            Scope.close(this.ownership.operationScope, Exit.void),
            releaseResource(() => this.store.close()),
          ],
          Effect.exit,
        );
        const failures = outcomes.flatMap((exit) => (Exit.isFailure(exit) ? [exit.cause] : []));
        if (failures.length)
          return yield* Effect.failCause(
            failures.reduce((combined, cause) => Cause.combine(combined, cause)),
          );
      }).pipe(Effect.onExit((exit) => Deferred.done(this.closeCompletion, exit)));
    }).pipe(Effect.uninterruptible);
  }
}
