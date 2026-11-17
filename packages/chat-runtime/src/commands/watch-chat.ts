import type { CommitPublication } from '@earendil-works/pi-durable';
import { Effect, Option, Semaphore, Stream } from 'effect';
import type { ChatSnapshot, ChatTarget } from '@moonbase/contracts/chat';
import { ChatUnavailableError, type ChatError } from '@moonbase/contracts/chat-errors';
import { cid } from '../documents.ts';
import type { SnapshotCache } from '../history/chat-snapshot.ts';
import { isNestedSourceEnded } from '../transcript/nested-calls.ts';
import type { Host } from './chat-host.ts';
import { readSnapshot } from './chat-reads.ts';
import { followChanges, listenToPi, listenToPubSub } from './harness-changes.ts';
import { classifyPublication } from './publications.ts';
import { safeError, watchError } from './safe-error.ts';

/**
 * A chat's snapshot, read again after each change that may alter it: its commits, a status Pi
 * reports without one, a change of tool definitions, or the store closing. Each watch holds one
 * of the host's observer permits, and the cache it reads through is its own.
 */
export function watchChat(host: Host, target: ChatTarget): Stream.Stream<ChatSnapshot, ChatError> {
  return Stream.suspend(() => followChat(host, target));
}
function followChat(host: Host, target: ChatTarget): Stream.Stream<ChatSnapshot, ChatError> {
  const conversationId = cid(target.conversationId);
  // Bumped when a change invalidates a capture already in flight; that read's result is dropped.
  let revision = 0,
    ended = false;
  const cache: SnapshotCache = { statusVersion: 0 };
  const invalidateStatus = () => {
    cache.statusVersion++;
    cache.status = undefined;
  };
  const invalidate = (publication: CommitPublication) => {
    const effect = classifyPublication(publication, conversationId);
    if (effect.resetsHistory) {
      cache.boundary = undefined;
      cache.history = undefined;
    }
    if (effect.resetsStatus) invalidateStatus();
    if (effect.liveRetired !== undefined) cache.retired = effect.liveRetired;
    if (effect.invalidatesCapture) revision++;
    return effect.relevant;
  };
  const changes = followChanges((changed) =>
    Effect.gen(function* () {
      yield* Effect.mapError(host.checkSession(target), watchError);
      yield* Effect.acquireRelease(
        Effect.flatMap(Semaphore.takeIfAvailable(host.observers, 1), (taken) =>
          taken ? Effect.void : Effect.fail(new ChatUnavailableError({ reason: 'observers' })),
        ),
        () => Semaphore.release(host.observers, 1),
      );
      yield* listenToPi(() =>
        host.harness.subscribeCommits((publication) => {
          if (invalidate(publication)) changed();
        }),
      );
      yield* listenToPi(() =>
        host.harness.subscribeClose(() => {
          ended = true;
          revision++;
          changed();
        }),
      );
      yield* listenToPi(() =>
        host.config.registry!.subscribe(() => {
          invalidateStatus();
          revision++;
          changed();
        }),
      );
      yield* listenToPubSub(host.statuses, (reported) => {
        if (reported !== conversationId) return;
        invalidateStatus();
        revision++;
        changed();
      });
    }),
  );
  return changes.pipe(
    Stream.mapEffect(() => {
      const version = revision;
      if (ended) return Effect.fail(safeError(null));
      return host.own(readSnapshot(host, target, cache)).pipe(
        Effect.map((snapshot) => (version === revision ? Option.some(snapshot) : Option.none())),
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
}
