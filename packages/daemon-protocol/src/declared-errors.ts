import { RpcSchema, type Rpc } from 'effect/rpc';

/** An error class a procedure's union names. */
export type ErrorClass = abstract new (...args: never) => unknown;
/** A procedure as both sides read it: its tag, annotations and the schemas of its outcomes. */
export type Procedure = Rpc.Any & Pick<Rpc.AnyWithProps, 'successSchema' | 'errorSchema'>;

/**
 * The error classes a procedure declares (D14): a watch declares its union on the stream it
 * succeeds with, so its own `errorSchema` is `Never`.
 */
export const declaredErrorsOf = (rpc: Procedure): readonly ErrorClass[] => {
  const schema = RpcSchema.isStreamSchema(rpc.successSchema)
    ? rpc.successSchema.error
    : rpc.errorSchema;
  return ((schema as { members?: readonly ErrorClass[] }).members ?? [schema]) as ErrorClass[];
};

/** Whether `error` is an instance of one of `errors`. */
export const isOneOf = (errors: readonly ErrorClass[], error: unknown) => {
  try {
    return errors.some((member) => error instanceof member);
  } catch {
    // A value whose prototype can't be read is no error of ours.
    return false;
  }
};
