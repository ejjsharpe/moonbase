import * as Schema from 'effect/Schema';
import { RpcMiddleware } from 'effect/rpc';
import { IpcApplicationErrorSchema, IpcBusyError, IpcInputError } from './ipc-errors.ts';

/**
 * Admits each request a document makes: held to its kind's input bounds and limit of requests and
 * watches at once, and a handler's defect answered as `Unavailable` with no diagnostics. Main
 * implements it.
 */
export class IpcAdmission extends RpcMiddleware.Service<IpcAdmission>()('moonbase/IpcAdmission', {
  error: Schema.Union([IpcBusyError, IpcInputError, IpcApplicationErrorSchema]),
}) {}
