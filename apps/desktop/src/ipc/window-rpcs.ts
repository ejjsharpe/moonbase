import * as Schema from 'effect/Schema';
import { Rpc, RpcGroup } from 'effect/rpc';
import { optional, struct } from '@moonbase/contracts/schema';
import { IpcAdmission } from './ipc-admission.ts';
import { WindowFailure } from './ipc-errors.ts';
import { exact, IpcRequestIdSchema } from './ipc-limits.ts';

/** What main asks of the window's document: to prepare Quit, to dispose, or to report a cleanup failure. */
export const WindowActionSchema = Schema.Union([
  struct({ action: Schema.Literals(['quit', 'dispose']), id: IpcRequestIdSchema }),
  struct({
    action: Schema.Literal('cleanup-error'),
    id: IpcRequestIdSchema,
    error: WindowFailure,
  }),
]);
export type WindowAction = typeof WindowActionSchema.Type;

/** The window's Quit handshake with its document. */
export class WindowRpcs extends RpcGroup.make(
  /** Main's requests of the document; watching them says the document is ready for them. */
  Rpc.make('watchWindowActions', { success: WindowActionSchema, stream: true }),
  /** The document's answer to a `quit` or `dispose` request. */
  Rpc.make('answerQuit', {
    payload: exact(
      Schema.Struct({
        id: IpcRequestIdSchema,
        consent: Schema.Boolean,
        cleanupError: optional(WindowFailure),
      }),
    ),
  }),
).middleware(IpcAdmission) {}
