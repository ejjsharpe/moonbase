import { Cause, Effect, Exit } from 'effect';
import * as Schema from 'effect/Schema';
import { CancelledError } from '@moonbase/contracts/errors';
import { IpcFailedError } from '@moonbase/contracts/ipc-errors';
import { DesktopRpcs } from '../ipc/desktop-rpcs.ts';
import type { WindowAction } from '../ipc/window-rpcs.ts';
import type { DaemonCommand } from './daemon/daemon-command.ts';
import type { IpcInterception } from './ipc/admission.ts';

/**
 * A request's outcome as an unpackaged test entry sees and replaces it. A failure is one of the
 * errors its procedure declares; one the entry writes itself is that error encoded, which main
 * decodes with the procedure's schema.
 */
type TestIpcReply =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown; interrupted?: boolean };
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
    else if (failure?._tag === 'Some') reply = { ok: false, error: failure.value };
    else
      reply = {
        ok: false,
        error: new CancelledError({ operation: 'Command' }),
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
        catch: () => new IpcFailedError(),
      }),
    ).pipe(
      Effect.flatMap((reply) => {
        const exit = exits.get(reply);
        if (exit) return exit;
        if (reply.ok) return Effect.succeed(reply.value);
        const schema = DesktopRpcs.requests.get(request.tag)!.errorSchema as Schema.Top;
        const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(schema)) as (
          value: unknown,
        ) => Effect.Effect<unknown, Schema.SchemaError>;
        return Effect.flatMap(Effect.orDie(decode(reply.error)), Effect.fail);
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
