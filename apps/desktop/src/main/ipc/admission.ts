import { Effect } from 'effect';
import { RpcSchema } from 'effect/rpc';
import { ApplicationError } from '@moonbase/contracts/errors';
import { DesktopChatRpcs } from '../../ipc/chat-rpcs.ts';
import { EditorRpcs } from '../../ipc/editor-rpcs.ts';
import { IpcAdmission } from '../../ipc/ipc-admission.ts';
import { boundApplicationError, IpcBusyError, IpcInputError } from '../../ipc/ipc-errors.ts';
import { findInputBoundBreach, ipcLimits, isWithinChatRequestBytes } from '../../ipc/ipc-limits.ts';

/** One request as a test entry may see it: its procedure and decoded payload. */
export type IpcRequestView = { tag: string; payload: unknown };
/** Lets an unpackaged test entry observe, delay or replace a request's outcome. */
export type IpcInterception = (
  request: IpcRequestView,
  handler: Effect.Effect<unknown, unknown>,
) => Effect.Effect<unknown, unknown>;

const workspaceWatch = 'watchWorkspace';
const editorCommands = new Set(
  [...EditorRpcs.requests.keys()].filter(
    (tag) =>
      tag !== workspaceWatch &&
      ![
        'chooseCheckout',
        'chooseImports',
        'pasteImports',
        'dropImports',
        'copyPaths',
        'revealPath',
      ].includes(tag),
  ),
);
const failed = () =>
  new ApplicationError({ code: 'Unavailable', message: 'Application effect failed' });

/**
 * The admission of one document's requests. Each kind (the editor, each chat target, the window)
 * runs at most its limit of requests and of watches at once, refusing more rather than queueing
 * them; an editor command and every chat request are held to their input bounds first.
 */
export function makeIpcAdmission(intercept?: IpcInterception) {
  const running = new Map<string, number>();
  return IpcAdmission.of((effect, { rpc, payload }) =>
    // Counted and given its release in one step, so an interruption between them leaks no place.
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const tag = rpc._tag;
        const watch = RpcSchema.isStreamSchema(rpc.successSchema);
        let kind = 'window',
          limit: number = ipcLimits.windowRequests;
        if (EditorRpcs.requests.has(tag)) {
          kind = 'editor';
          limit = ipcLimits.editorRequests;
          const breach =
            editorCommands.has(tag) || tag === workspaceWatch
              ? findInputBoundBreach(
                  payload,
                  tag === 'getIgnoredPaths' ? ipcLimits.ignoredPathsLength : ipcLimits.arrayLength,
                )
              : undefined;
          if (breach) return Effect.fail(new IpcInputError({ problem: breach }));
        } else if (DesktopChatRpcs.requests.has(tag)) {
          kind = `chat:${(payload as { backendId?: string } | undefined)?.backendId ?? 'remote'}`;
          limit = ipcLimits.chatRequests;
          if (!isWithinChatRequestBytes(payload ?? null))
            return Effect.fail(new IpcInputError({ problem: 'chat-request' }));
        }
        const key = `${kind}:${watch ? 'watches' : 'requests'}`;
        const count = running.get(key) ?? 0;
        if (count >= limit)
          return Effect.fail(new IpcBusyError({ limit: watch ? 'watches' : 'requests' }));
        running.set(key, count + 1);
        const handler = intercept ? (intercept({ tag, payload }, effect) as typeof effect) : effect;
        return restore(
          handler.pipe(
            Effect.mapError((error) =>
              ApplicationError.is(error) ? boundApplicationError(error) : error,
            ),
            Effect.catchDefect(() => Effect.fail(failed())),
          ),
        ).pipe(Effect.ensuring(Effect.sync(() => running.set(key, running.get(key)! - 1))));
      }),
    ),
  );
}
