import { Context } from 'effect';
import type * as SchemaAST from 'effect/SchemaAST';

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
type WithPayload = { readonly payloadSchema: { readonly ast: SchemaAST.AST } };
type Group = { readonly requests: ReadonlyMap<string, Annotated> };

export const isMutationRpc = (rpc: Annotated) => Context.get(rpc.annotations, Mutation);
export const isStatusRpc = (rpc: Annotated) => Context.get(rpc.annotations, StatusCall);
/** The tags of a group's procedures `marked` holds for. */
export const findMarkedProcedures = (
  group: Group,
  marked: (rpc: Annotated) => boolean,
): ReadonlySet<string> =>
  new Set([...group.requests].filter(([, rpc]) => marked(rpc)).map(([tag]) => tag));

/** Whether an AST is an object with a `requestId`, at its top level or in a field like `input`. */
const carriesRequestId = (ast: SchemaAST.AST, depth: number): boolean => {
  if (depth > 2) return false;
  if (ast._tag === 'Union') return ast.types.some((type) => carriesRequestId(type, depth));
  if (ast._tag !== 'Objects') return false;
  return ast.propertySignatures.some(
    (property) => property.name === 'requestId' || carriesRequestId(property.type, depth + 1),
  );
};
/** Whether a procedure's payload carries a request ID, at its top level or in its `input`. */
export const takesRequestId = (rpc: WithPayload) => carriesRequestId(rpc.payloadSchema.ast, 0);
