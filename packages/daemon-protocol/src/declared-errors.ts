import { RpcSchema, type Rpc } from 'effect/rpc';
import * as Schema from 'effect/Schema';

/** A procedure as both sides read it: its tag, annotations and the schemas of its outcomes. */
export type Procedure = Rpc.Any & Pick<Rpc.AnyWithProps, 'successSchema' | 'errorSchema'>;

/**
 * The error union a procedure declares (D14): a watch declares its union on the stream it
 * succeeds with, so its own `errorSchema` is `Never`.
 */
export const declaredErrorsOf = (rpc: Procedure): Schema.Top =>
  RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema.error : rpc.errorSchema;

/** Whether a value is an error of one of `unions`: an instance of a class one of them names. */
export const isDeclaredBy = (...unions: readonly Schema.Top[]): ((error: unknown) => boolean) =>
  Schema.is(Schema.Union(unions));
