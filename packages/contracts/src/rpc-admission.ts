import { RpcMiddleware } from 'effect/rpc';
import { ApplicationError } from './errors.ts';

/**
 * Admits each request a daemon serves over RPC: refused once it is stopping, held to a
 * connection's in-flight limits, and a handler's defect answered as `Unavailable` with no
 * diagnostics. The daemon protocol's server implements it; clients need nothing.
 */
export class RpcAdmission extends RpcMiddleware.Service<RpcAdmission>()('moonbase/RpcAdmission', {
  error: ApplicationError,
}) {}
