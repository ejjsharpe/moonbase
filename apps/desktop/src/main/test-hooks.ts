import { Cause, Effect, Exit } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import { toLegacyApplicationError, type DesktopIpcError } from '../ipc/ipc-errors.ts';
import type { WindowAction } from '../ipc/window-rpcs.ts';
import type { DaemonCommand } from './daemon/daemon-command.ts';
import type { IpcInterception } from './ipc/admission.ts';

/** A request's outcome as an unpackaged test entry sees and replaces it. */
type TestIpcReply =
  | { ok: true; value: unknown }
  | { ok: false; error: ApplicationError; interrupted?: boolean };
/** An unpackaged test entry's view of each IPC request: it may observe, hold or replace it. */
type TestIpcHook = (
  request: { tag: string; payload: unknown },
  proceed: () => Promise<TestIpcReply>,
) => Promise<TestIpcReply>;
/** An unpackaged test entry's view of each action main sends the document. */
type TestWindowAction = (action: WindowAction, send: (action: WindowAction) => void) => void;

/** What an unpackaged test entry set on `globalThis` before importing main; nothing when packaged. */
export type TestHooks = {
  interception?: IpcInterception;
  windowAction?: TestWindowAction;
  daemonCommand?: (directory: string) => DaemonCommand;
};

/** The test entry's hook as the IPC admission's interception; a reply it keeps keeps its exit. */
function toInterception(hook: TestIpcHook): IpcInterception {
  const exits = new WeakMap<TestIpcReply, Exit.Exit<unknown, unknown>>();
  const toReply = (exit: Exit.Exit<unknown, unknown>): TestIpcReply => {
    let reply: TestIpcReply;
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
    if (Exit.isSuccess(exit)) reply = { ok: true, value: exit.value };
    else if (failure?._tag === 'Some')
      reply = { ok: false, error: toLegacyApplicationError(failure.value as DesktopIpcError) };
    else
      reply = {
        ok: false,
        error: new ApplicationError({ code: 'Cancelled', message: 'Command cancelled' }),
        interrupted: true,
      };
    exits.set(reply, exit);
    return reply;
  };
  // The test entry's hook is Promise code, so the request it proceeds with runs on this fiber's
  // services from there.
  return (request, handler) =>
    Effect.flatMap(Effect.context<never>(), (context) =>
      Effect.tryPromise({
        try: (signal) =>
          hook(request, () =>
            Effect.runPromiseExitWith(context)(handler, { signal }).then(toReply),
          ),
        catch: (error) =>
          ApplicationError.is(error)
            ? error
            : new ApplicationError({ code: 'Unavailable', message: 'Test hook failed.' }),
      }),
    ).pipe(
      Effect.flatMap((reply) => {
        const exit = exits.get(reply);
        if (exit) return exit;
        return reply.ok
          ? Effect.succeed(reply.value)
          : Effect.fail(new ApplicationError(reply.error));
      }),
    );
}

/** The test entry's hooks, read once at start-up of an unpackaged app. */
export function readTestHooks(packaged: boolean): TestHooks {
  if (packaged) return {};
  const hooks = globalThis as {
    moonbaseTestIpc?: TestIpcHook;
    moonbaseTestWindowAction?: TestWindowAction;
    moonbaseTestDaemonCommand?: (directory: string) => DaemonCommand;
  };
  return {
    ...(hooks.moonbaseTestIpc ? { interception: toInterception(hooks.moonbaseTestIpc) } : {}),
    // Read on each action, since a test installs it while the app runs.
    windowAction: (action, send) =>
      hooks.moonbaseTestWindowAction ? hooks.moonbaseTestWindowAction(action, send) : send(action),
    ...(hooks.moonbaseTestDaemonCommand ? { daemonCommand: hooks.moonbaseTestDaemonCommand } : {}),
  };
}
