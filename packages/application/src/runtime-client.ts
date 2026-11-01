import { Cause, Effect, Exit, Stream, type ManagedRuntime } from "effect";
import { ApplicationError, type EditorClient } from "./client.ts";
import { workspaceCommand, workspaceWatch } from "./handlers.ts";
import type { WorkspaceService } from "./services.ts";

function describeFailure(value: unknown): string {
  try { return String(value); } catch { return "Unprintable application failure"; }
}

function applicationFailure(cause: Cause.Cause<ApplicationError>): ApplicationError {
  if (Cause.hasInterruptsOnly(cause)) return new ApplicationError({ code: "Cancelled", message: "Command cancelled" });
  const failures = cause.reasons.filter(reason => !Cause.isInterruptReason(reason));
  if (failures.length === 1 && Cause.isFailReason(failures[0])) return failures[0].error;
  const typed = failures.find(Cause.isFailReason)?.error;
  return new ApplicationError({ code: typed?.code ?? "Unavailable", target: typed?.target,
    message: failures.map(reason => describeFailure(Cause.isFailReason(reason) ? reason.error : reason.defect)).join("; ") || "Application effect failed" });
}

/** Accept the process root's runtime; never acquire a second service graph here. */
export function makeEditorClient(runtime: ManagedRuntime.ManagedRuntime<WorkspaceService, ApplicationError>): EditorClient {
  return {
    command: async (operation, input, options) => {
      if (options?.signal?.aborted) throw new ApplicationError({ code: "Cancelled", message: "Command cancelled" });
      const exit = await runtime.runPromiseExit(workspaceCommand(operation, input), options);
      if (Exit.isFailure(exit)) throw applicationFailure(exit.cause);
      return exit.value;
    },
    watch(input, receive, onError) {
      const abort = new AbortController();
      void runtime.runPromiseExit(Stream.runForEach(workspaceWatch(input), event => Effect.sync(() => receive(event))), { signal: abort.signal })
        .then(exit => {
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) onError(applicationFailure(exit.cause));
        });
      return () => abort.abort();
    },
  };
}
