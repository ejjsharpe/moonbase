import { Context } from 'effect';

// What a procedure is, declared once on its `Rpc` with `.annotate(...)` and read wherever a
// client or server needs it, so no list of procedure names is kept anywhere else.

/**
 * A procedure that changes state: one whose reply is lost may have run, so it is `Uncertain` and
 * never sent again, and a server runs it to completion once dispatched.
 */
export const Mutation = Context.Reference<boolean>('@moonbase/contracts/rpc-annotations/Mutation', {
  defaultValue: () => false,
});
/** A call that resolves an `Uncertain` result: it keeps places of its own beside other requests. */
export const StatusCall = Context.Reference<boolean>(
  '@moonbase/contracts/rpc-annotations/StatusCall',
  { defaultValue: () => false },
);

type Annotated = { readonly annotations: Context.Context<never> };
type Group = { readonly requests: ReadonlyMap<string, Annotated> };

export const isMutationRpc = (rpc: Annotated) => Context.get(rpc.annotations, Mutation);
export const isStatusRpc = (rpc: Annotated) => Context.get(rpc.annotations, StatusCall);
/** The tags of a group's procedures `marked` holds for. */
export const findMarkedProcedures = (
  group: Group,
  marked: (rpc: Annotated) => boolean,
): ReadonlySet<string> =>
  new Set([...group.requests].filter(([, rpc]) => marked(rpc)).map(([tag]) => tag));
