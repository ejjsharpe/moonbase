import { realpath, stat } from 'node:fs/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { Harness, createRegistry, type ConversationId } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Cause, Effect, Exit, FiberSet, Ref, Scope } from 'effect';
import { releaseResource } from '@moonbase/effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import { Host, safeError } from './commands.ts';
import { Store, readOwnedMetadata, getSettings } from './documents.ts';
import type { RuntimeConfiguration, RetainedWork } from './runtime-types.ts';
import * as V from './validation.ts';
import * as S from './private-schema.ts';

// Abort requests and terminal cleanup failures remain observable after a caller's deadline.
function retainedWork(kind: 'abort' | 'waiter'): Effect.Effect<RetainedWork, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const work = yield* Scope.provide(scope)(FiberSet.make<unknown, ApplicationError>());
    const failures = yield* Ref.make<Cause.Cause<ApplicationError>>(Cause.empty);
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
      run: <A>(effect: Effect.Effect<A, ApplicationError>) => {
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

export function openHost(config: RuntimeConfiguration) {
  return Effect.gen(function* () {
    const validated = yield* Effect.tryPromise({
      try: async () => {
        if (!isQualifiedRuntime(process.versions))
          V.fail(
            'Incompatible',
            'The Pi host requires Node 26.13 or newer, or exactly Bun 1.4.4. The remote client has its own runtime boundary.',
          );
        return S.localConfiguration(config);
      },
      catch: safeError,
    });
    const session = { host: validated.host, actorId: validated.actorId },
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
        V.fail(
          'Unavailable',
          'The saved local working folder is unavailable. Restore it before retrying.',
        );
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
        try: () => openNodeSqliteDatabase(validated.databasePath, { busyTimeoutMs: 30 }),
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
    const registry = validated.registry ?? createRegistry();
    let host: Host | undefined = undefined;
    const harness = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          Harness.open(
            storage,
            {
              models: validated.models,
              registry,
              env: getToolEnvironment,
              settings: {
                retry: { enabled: false },
                compaction: { enabled: false },
                restartLimit: 5,
              },
              onReport: (_error, info) => {
                if (info.type === 'migration_failed' || info.type === 'task_parked')
                  for (const notify of host?.statusListeners ?? [])
                    notify(info.task.conversationId);
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
        if (existing) S.savedStore(existing);
        await harness.commit(async (tx) => {
          if (!existing && (await tx.scanConversations({}, 1)).items.length)
            V.fail(
              'Incompatible',
              'This store contains data without Moonbase ownership metadata; no import is authorized.',
            );
          const store = await tx.doc(Store, 'identity', identity);
          S.savedStore(store);
          if (store.identity !== identity)
            V.fail(
              'Incompatible',
              'Store is already bound to another host, actor, working directory or model.',
            );
        }, context);
      },
      catch: safeError,
    });
    const workScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      ),
      work = yield* Scope.provide(workScope)(FiberSet.make<unknown, ApplicationError>()),
      waiters = yield* retainedWork('waiter'),
      observations = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
    host = new Host(
      { ...validated, registry },
      harness,
      identity,
      work,
      aborts,
      waiters,
      observations,
    );
    const acquired = host;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        acquired.closed = true;
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => acquired.files.close()));
    harness.resume();
    return acquired;
  });
}
