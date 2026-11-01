import { Effect, Stream, type ManagedRuntime } from 'effect';

import { ApplicationError, type EditorClient } from './client.ts';
import { workspaceCommand, workspaceWatch } from './handlers.ts';
import type { WorkspaceService } from './services.ts';

/** Accept the process root's runtime; never acquire a second service graph here. */
export function makeEditorClient(
  runtime: ManagedRuntime.ManagedRuntime<WorkspaceService, ApplicationError>,
): EditorClient {
  return {
    command: (operation, input, options) =>
      runtime.runPromise(workspaceCommand(operation, input), options),
    watch(input, receive, onError) {
      const abort = new AbortController();
      void runtime
        .runPromise(
          Stream.runForEach(workspaceWatch(input), (event) => Effect.sync(() => receive(event))),
          { signal: abort.signal },
        )
        .catch((error) => {
          if (!abort.signal.aborted)
            onError(
              error instanceof ApplicationError
                ? error
                : new ApplicationError({ code: 'Unavailable', message: String(error) }),
            );
        });
      return () => abort.abort();
    },
  };
}
