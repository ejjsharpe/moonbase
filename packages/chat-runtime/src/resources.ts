import { realpath, stat } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { Harness, type ConversationId, type Registry } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Cause, Effect, Exit, FiberSet, PubSub, Ref, Scope } from 'effect';
import { releaseResource } from './release-resource.ts';
import {
  ChatStoreMismatchError,
  ChatUnavailableError,
  type ChatError,
} from '@moonbase/contracts/chat-errors';
import { IncompatibleHostError } from '@moonbase/contracts/host-errors';
import { Host } from './commands/chat-host.ts';
import { makeChatFileIndex } from './files.ts';
import { safeError } from './commands/safe-error.ts';
import { Store, readOwnedMetadata, getSettings } from './documents.ts';
import type { LocalPiRuntimeConfiguration, RetainedWork } from './runtime-types.ts';
import { decodeStoreOwner } from './stored-records.ts';

// Abort requests and terminal cleanup failures remain observable after a caller's deadline.
function retainedWork(kind: 'abort' | 'waiter'): Effect.Effect<RetainedWork, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const work = yield* Scope.provide(scope)(FiberSet.make<unknown, ChatError>());
    const failures = yield* Ref.make<Cause.Cause<ChatError>>(Cause.empty);
    yield* Effect.addFinalizer(() =>
      FiberSet.clear(work).pipe(
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.ensuring(
          Ref.get(failures).pipe(
            Effect.flatMap((cause) =>
              cause.reasons.length
                ? Effect.failCause(
                    Cause.fromReasons<never>(
                      cause.reasons.map((reason) =>
                        Cause.isFailReason(reason) ? Cause.makeDieReason(reason.error) : reason,
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
        ),
      ),
    );
    return {
      run: <A>(effect: Effect.Effect<A, ChatError>) => {
        const observed = effect.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Ref.update(failures, (cause) => Cause.combine(cause, exit.cause))
              : Effect.void,
          ),
        );
        // Capture abort failure before restoring interruption after the noncancelable SDK call.
        return FiberSet.run(work, kind === 'abort' ? Effect.uninterruptible(observed) : observed);
      },
    };
  });
}

// Bun is qualified exactly, so upgrading it is a deliberate change. Bun reports an older Node
// version than it implements, so it is never judged by that version.
function isQualifiedRuntime(versions: NodeJS.ProcessVersions) {
  if (versions.bun !== undefined) return versions.bun === '1.4.4';
  const [major = 0, minor = 0] = versions.node.split('.').map(Number);
  return major > 26 || (major === 26 && minor >= 13);
}

/** Opens the host on the tool registry its runtime resolved (the caller's, or Moonbase's tools). */
export function openHost(config: LocalPiRuntimeConfiguration & { readonly registry: Registry }) {
  return Effect.gen(function* () {
    if (!isQualifiedRuntime(process.versions))
      return yield* Effect.fail(new IncompatibleHostError({ reason: 'runtime' }));
    const session = { host: config.host, actorId: config.actorId },
      identity = JSON.stringify({ ...session, mode: 'local' });
    const environments = new Map<string, NodeExecutionEnv>();
    yield* Effect.addFinalizer(() =>
      Effect.all(
        [...environments.values()].map((env) =>
          Effect.exit(releaseResource(() => env.cleanup(context))),
        ),
        { concurrency: 'unbounded' },
      ).pipe(
        Effect.flatMap((exits) => {
          const cause = exits.reduce(
            (cause, exit) => (Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause),
            Cause.empty,
          );
          return cause.reasons.length ? Effect.failCause(cause) : Effect.void;
        }),
      ),
    );
    const getToolEnvironment = async (target: { conversationId: ConversationId; cwd?: string }) => {
      const meta = await readOwnedMetadata(harness, identity, {
        ...session,
        conversationId: String(target.conversationId),
      });
      const cwd = getSettings(meta).cwd;
      if (target.cwd !== cwd || (await realpath(cwd)) !== cwd || !(await stat(cwd)).isDirectory())
        throw new ChatUnavailableError({ reason: 'saved-folder-missing' });
      let env = environments.get(cwd);
      if (!env) {
        env = new NodeExecutionEnv({ cwd });
        environments.set(cwd, env);
      }
      return env;
    };
    let databaseOwned = true,
      storageOwned = true;
    const database = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => openNodeSqliteDatabase(config.databasePath, { busyTimeoutMs: 30 }),
        catch: safeError,
      }),
      (database) => releaseResource(() => (databaseOwned ? database.close() : undefined)),
    );
    yield* Effect.tryPromise({
      try: async () => {
        await database.exec('PRAGMA locking_mode=EXCLUSIVE');
        await database.transaction(async (tx) => {
          await tx.exec(
            'CREATE TABLE IF NOT EXISTS moonbase_owner_lock (singleton INTEGER PRIMARY KEY)',
          );
          await tx.run('INSERT OR REPLACE INTO moonbase_owner_lock VALUES (1)');
        });
      },
      catch: safeError,
    });
    const storage = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: () => SqliteStorage.open(database), catch: safeError }),
      (storage) => releaseResource(() => (storageOwned ? storage.close(context) : undefined)),
    );
    databaseOwned = false;
    const aborts = yield* retainedWork('abort');
    const statuses = yield* Effect.acquireRelease(PubSub.unbounded<ConversationId>(), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    const harness = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          Harness.open(
            storage,
            {
              models: config.models,
              registry: config.registry,
              env: getToolEnvironment,
              settings: {
                retry: { enabled: false },
                compaction: { enabled: false },
                restartLimit: 5,
              },
              onReport: (_error, info) => {
                if (info.type === 'migration_failed' || info.type === 'task_parked')
                  PubSub.publishUnsafe(statuses, info.task.conversationId);
              },
            },
            context,
          ),
        catch: safeError,
      }),
      (harness) => releaseResource(() => harness.close(context)),
    );
    storageOwned = false;
    yield* Effect.tryPromise({
      try: async () => {
        const existing = await harness.snapshot(Store, 'identity', context);
        if (existing) decodeStoreOwner(existing);
        await harness.commit(async (tx) => {
          if (!existing && (await tx.scanConversations({}, 1)).items.length)
            throw new ChatStoreMismatchError({ mismatch: 'unowned' });
          const store = await tx.doc(Store, 'identity', identity);
          decodeStoreOwner(store);
          if (store.identity !== identity) throw new ChatStoreMismatchError({ mismatch: 'bound' });
        }, context);
      },
      catch: safeError,
    });
    const workScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      ),
      work = yield* Scope.provide(workScope)(FiberSet.make<unknown, ChatError>()),
      waiters = yield* retainedWork('waiter');
    // Closed first: its finalizer stops running listings and waits for their process groups.
    const files = yield* makeChatFileIndex({
      ripgrepExecutable: config.ripgrepExecutable,
      ...(config.fileListingTiming ? { timing: config.fileListingTiming } : {}),
    });
    const host = yield* Host.make({
      config,
      harness,
      identity,
      files,
      statuses,
      work,
      aborts,
      waiters,
    });
    harness.resume();
    return host;
  });
}
