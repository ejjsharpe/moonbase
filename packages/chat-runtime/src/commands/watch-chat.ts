import type { CommitPublication, ConversationId } from '@earendil-works/pi-durable';
import { Effect, Exit, Option, Queue, Scope, Stream } from 'effect';
import { releaseResource } from '@moonbase/effect';
import type { ChatTarget } from '@moonbase/contracts/chat';
import { ChatUnavailableError } from '@moonbase/contracts/chat-errors';
import { cid } from '../documents.ts';
import type { SnapshotCache } from '../history/chat-snapshot.ts';
import { isNestedSourceEnded } from '../transcript/nested-calls.ts';
import type { Host } from './chat-host.ts';
import { readSnapshot } from './chat-reads.ts';
import { classifyPublication } from './publications.ts';
import { safeError, watchError } from './safe-error.ts';

export function watchChat(host: Host, target: ChatTarget) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.sliding<void>(1);
      const cache: SnapshotCache = { statusVersion: 0 };
      let revision = 0,
        active = true,
        ended = false;
      const scope = yield* Effect.acquireRelease(Scope.fork(host.observations), (scope) =>
        Scope.close(scope, Exit.void),
      );
      yield* Scope.provide(scope)(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              active = false;
            }).pipe(Effect.andThen(Queue.shutdown(queue))),
          );
          yield* Effect.acquireRelease(
            Effect.try({
              try: () => {
                host.session(target);
                if (host.closed || host.observers >= 64)
                  throw new ChatUnavailableError({ reason: 'observers' });
                host.observers++;
              },
              catch: watchError,
            }),
            () =>
              Effect.sync(() => {
                host.observers--;
              }),
          );
          const refresh = (invalidatesCapture = true) => {
            if (invalidatesCapture) revision++;
            Queue.offerUnsafe(queue, undefined);
          };
          const invalidateStatus = () => {
            cache.statusVersion++;
            cache.status = undefined;
          };
          const invalidate = (publication: CommitPublication) => {
            const effect = classifyPublication(publication, cid(target.conversationId));
            if (effect.resetsHistory) {
              cache.boundary = undefined;
              cache.history = undefined;
            }
            if (effect.resetsStatus) invalidateStatus();
            if (effect.liveRetired !== undefined) cache.retired = effect.liveRetired;
            if (effect.relevant) refresh(effect.invalidatesCapture);
          };
          yield* Effect.acquireRelease(
            Effect.try({
              try: () => host.harness.subscribeCommits(invalidate),
              catch: watchError,
            }),
            (off) => releaseResource(off),
          );
          yield* Effect.acquireRelease(
            Effect.try({
              try: () =>
                host.harness.subscribeClose(() => {
                  ended = true;
                  refresh();
                }),
              catch: watchError,
            }),
            (off) => releaseResource(off),
          );
          yield* Effect.acquireRelease(
            Effect.try({
              try: () =>
                host.config.registry!.subscribe(() => {
                  invalidateStatus();
                  refresh();
                }),
              catch: watchError,
            }),
            (off) => releaseResource(off),
          );
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const notify = (conversationId: ConversationId) => {
                if (conversationId === cid(target.conversationId)) {
                  invalidateStatus();
                  refresh();
                }
              };
              host.statusListeners.add(notify);
              return () => {
                host.statusListeners.delete(notify);
              };
            }),
            (off) => releaseResource(off),
          );
          refresh();
        }),
      );
      return Stream.fromQueue(queue).pipe(
        Stream.mapEffect(() => {
          const version = revision;
          if (ended || host.closed) return Effect.fail(safeError(null));
          return host.own(host.read((signal) => readSnapshot(host, target, cache, signal))).pipe(
            Effect.map((snapshot) =>
              active && version === revision ? Option.some(snapshot) : Option.none(),
            ),
            Effect.catch((error) =>
              isNestedSourceEnded(error) && version !== revision
                ? Effect.succeed(Option.none())
                : Effect.fail(error),
            ),
          );
        }),
        Stream.filter(Option.isSome),
        Stream.map((snapshot) => snapshot.value),
      );
    }),
  );
}
