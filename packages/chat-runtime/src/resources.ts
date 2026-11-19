import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { Harness, type ConversationId, type Registry } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { Cause, Effect, Exit, FiberSet, FileSystem, PubSub, Scope } from 'effect';
import { releaseResource } from './release-resource.ts';
import {
  ChatStoreMismatchError,
  ChatUnavailableError,
  type ChatError,
} from '@moonbase/contracts/chat-errors';
import { IncompatibleHostError } from '@moonbase/contracts/host-errors';
import { ProcessGroups } from '@moonbase/process-group';
import { checkCanonicalFolder } from './canonical-folder.ts';
import { makeHost } from './commands/chat-host.ts';
import { callHarness } from './commands/harness-call.ts';
import { makeChatFileIndex } from './files.ts';
import { runCheck } from './commands/safe-error.ts';
import { Store, readOwnedMetadata, getSettings } from './documents.ts';
import type { LocalPiRuntimeConfiguration, RetainedWork } from './runtime-types.ts';
import { decodeStoreOwner } from './stored-records.ts';
import { makeEntryTranscriptCache } from './transcript/entry-transcript.ts';
import { makeFindSubtreeCache } from './transcript/find-transcript.ts';

/**
 * Work that outlives a caller's deadline: abort requests, and terminal waits whose cleanup may
 * fail. Each failure is kept as a finalizer of `failures`, which fails with it as a defect, so
 * closing the host reports every one, after it has interrupted the work still running.
 */
function retainedWork(kind: 'abort' | 'waiter'): Effect.Effect<RetainedWork, never, Scope.Scope> {
  return Effect.gen(function* () {
    const failures = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
      Scope.close(scope, exit),
    );
    // Closed before `failures`, so the failures of work it interrupts are kept too.
    const work = yield* FiberSet.make<unknown, ChatError>();
    const keep = (cause: Cause.Cause<ChatError>) =>
      Scope.addFinalizer(
        failures,
        Effect.failCause(
          Cause.fromReasons<never>(
            cause.reasons.map((reason) =>
              Cause.isFailReason(reason) ? Cause.makeDieReason(reason.error) : reason,
            ),
          ),
        ),
      );
    return {
      run: <A>(effect: Effect.Effect<A, ChatError>) => {
        const kept = effect.pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? keep(exit.cause)
              : Effect.void,
          ),
        );
        // An abort can't be interrupted once sent, so its failure is always kept.
        return FiberSet.run(work, kind === 'abort' ? Effect.uninterruptible(kept) : kept);
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
    const fileSystem = yield* FileSystem.FileSystem;
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
    // Pi asks for a chat's tool environment through a callback, which gets a Promise from here.
    const runForPi = yield* FiberSet.makeRuntimePromise<FileSystem.FileSystem>();
    const getToolEnvironment = (target: {
      conversationId: ConversationId;
      cwd?: string;
    }): Promise<NodeExecutionEnv> =>
      runForPi(
        Effect.gen(function* () {
          const meta = yield* readOwnedMetadata(harness, identity, {
            ...session,
            conversationId: String(target.conversationId),
          });
          const cwd = yield* runCheck(() => getSettings(meta).cwd);
          if (target.cwd !== cwd || (yield* checkCanonicalFolder(cwd)) !== 'canonical')
            return yield* new ChatUnavailableError({ reason: 'saved-folder-missing' });
          let env = environments.get(cwd);
          if (!env) {
            env = new NodeExecutionEnv({ cwd });
            environments.set(cwd, env);
          }
          return env;
        }),
      );
    // Storage takes the database over once it opens, and Pi the storage: each is released by what
    // took it over, or by itself if the next step fails.
    const openStorage = Effect.gen(function* () {
      const database = yield* callHarness(() =>
        openNodeSqliteDatabase(config.databasePath, { busyTimeoutMs: 30 }),
      );
      return yield* Effect.gen(function* () {
        yield* callHarness(() => database.exec('PRAGMA locking_mode=EXCLUSIVE'));
        yield* callHarness(() =>
          database.transaction(async (tx) => {
            await tx.exec(
              'CREATE TABLE IF NOT EXISTS moonbase_owner_lock (singleton INTEGER PRIMARY KEY)',
            );
            await tx.run('INSERT OR REPLACE INTO moonbase_owner_lock VALUES (1)');
          }),
        );
        return yield* callHarness(() => SqliteStorage.open(database));
      }).pipe(Effect.onError(() => releaseResource(() => database.close())));
    });
    const aborts = yield* retainedWork('abort');
    const statuses = yield* Effect.acquireRelease(PubSub.unbounded<ConversationId>(), (pubsub) =>
      PubSub.shutdown(pubsub),
    );
    const harness: Harness = yield* Effect.acquireRelease(
      Effect.flatMap(openStorage, (storage) =>
        callHarness(() =>
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
        ).pipe(Effect.onError(() => releaseResource(() => storage.close(context)))),
      ),
      (harness) => releaseResource(() => harness.close(context)),
    );
    const existing = yield* callHarness(() => harness.snapshot(Store, 'identity', context));
    if (existing) yield* runCheck(() => decodeStoreOwner(existing));
    yield* callHarness(() =>
      harness.commit(async (tx) => {
        if (!existing && (await tx.scanConversations({}, 1)).items.length)
          throw new ChatStoreMismatchError({ mismatch: 'unowned' });
        const store = await tx.doc(Store, 'identity', identity);
        decodeStoreOwner(store);
        if (store.identity !== identity) throw new ChatStoreMismatchError({ mismatch: 'bound' });
      }, context),
    );
    const work = yield* FiberSet.make<unknown, ChatError>(),
      waiters = yield* retainedWork('waiter');
    // Closed first: its finalizer stops running listings and waits for their process groups.
    const files = yield* makeChatFileIndex({
      ripgrepExecutable: config.ripgrepExecutable,
      ...(config.fileListingTiming ? { timing: config.fileListingTiming } : {}),
    }).pipe(Effect.provide(ProcessGroups.layer));
    const host = yield* makeHost({
      config,
      harness,
      identity,
      files,
      fileSystem,
      statuses,
      work,
      aborts,
      waiters,
      entryTranscripts: makeEntryTranscriptCache(),
      findSubtrees: makeFindSubtreeCache(),
    });
    harness.resume();
    return host;
  });
}
