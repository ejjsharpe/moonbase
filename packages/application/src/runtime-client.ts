import { Cause, Effect, Exit, Stream, type ManagedRuntime } from "effect";
import { ApplicationError, type CommandOptions, type EditorClient } from "./client.ts";
import type { ConnectionClient } from "./connection-client.ts";
import type { ChatClient } from "./chat-client.ts";
import { chatCommand, chatWatch, connectionCommand, connectionWatch, workspaceCommand, workspaceWatch } from "./handlers.ts";
import type { ChatService, ConnectionService, WorkspaceService } from "./services.ts";

function applicationFailure(cause: Cause.Cause<ApplicationError>): ApplicationError {
  if (Cause.hasInterruptsOnly(cause)) return new ApplicationError({ code: "Cancelled", message: "Command cancelled" });
  const failures = cause.reasons.flatMap(reason => Cause.isFailReason(reason) ? [reason.error] : Cause.isDieReason(reason) ? [reason.defect] : []);
  if (failures.length === 1 && ApplicationError.is(failures[0])) return failures[0];
  const typed = failures.find(ApplicationError.is);
  return new ApplicationError({ code: typed?.code ?? "Unavailable", target: typed?.target,
    message: failures.map(value => ApplicationError.fromUnknown(value).message).join("; ") || "Application effect failed" });
}

async function invoke<A, R>(runtime: ManagedRuntime.ManagedRuntime<R, ApplicationError>, effect: Effect.Effect<A, ApplicationError, R>, options?: CommandOptions) {
  if (options?.signal?.aborted) throw new ApplicationError({ code: "Cancelled", message: "Command cancelled" });
  const exit = await runtime.runPromiseExit(effect, options);
  if (Exit.isFailure(exit)) throw applicationFailure(exit.cause);
  return exit.value;
}
function observe<A, R>(runtime: ManagedRuntime.ManagedRuntime<R, ApplicationError>, stream: Stream.Stream<A, ApplicationError, R>, receive: (event: A) => void, onError: (error: ApplicationError) => void) {
  const abort = new AbortController();
  void runtime.runPromiseExit(Stream.runForEach(stream, event => Effect.sync(() => receive(event))), { signal: abort.signal })
    .then(exit => { if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) onError(applicationFailure(exit.cause)); });
  return () => abort.abort();
}

/** Accept the process root's runtime; never acquire a second service graph here. */
export function makeEditorClient(runtime: ManagedRuntime.ManagedRuntime<WorkspaceService, ApplicationError>): EditorClient {
  return {
    command: (operation, input, options) => invoke(runtime, workspaceCommand(operation, input), options),
    watch: (input, receive, onError) => observe(runtime, workspaceWatch(input), receive, onError),
  };
}
export function makeConnectionClient(runtime: ManagedRuntime.ManagedRuntime<ConnectionService, ApplicationError>): ConnectionClient {
  return {
    command: (operation, input, options) => invoke(runtime, connectionCommand(operation, input), options),
    watch: (receive, onError) => observe(runtime, connectionWatch(), receive, onError),
  };
}
export function makeChatClient(runtime: ManagedRuntime.ManagedRuntime<ChatService, ApplicationError>): ChatClient {
  return {
    command: (operation, input, options) => invoke(runtime, chatCommand(operation, input), options),
    watch: (input, receive, onError) => observe(runtime, chatWatch(input), receive, onError),
  };
}
