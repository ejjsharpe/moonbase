import { Effect } from 'effect';
import * as Schema from 'effect/Schema';

/** A Pi resource's release failed; what it reported stays private. */
export class ResourceReleaseError extends Schema.TaggedError<ResourceReleaseError>()(
  'ResourceReleaseError',
  {},
) {
  override get message() {
    return 'A chat resource could not be released.';
  }
}

/**
 * Releases a resource of a Promise API. Its failure dies as `ResourceReleaseError`, so whatever the
 * API reported never reaches a client, a log or another process when Effect combines it with a
 * command's cause.
 */
export const releaseResource = (release: () => void | Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await release();
    },
    catch: () => new ResourceReleaseError(),
  }).pipe(Effect.orDie);
