import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from 'effect';
import * as SchemaAST from 'effect/SchemaAST';
import { ChatRpcs } from '../src/chat-rpc.ts';
import { LocalHostRpcs, ProviderSetupRpcs } from '../src/daemon-rpc.ts';
import { isMutationRpc, isStatusRpc, takesRequestId } from '../src/rpc-annotations.ts';
import { WorkspaceRpcs } from '../src/workspace-rpc.ts';

/** Whether every decoded variant of `ast` has a required `name` field that `holds`. */
const requires = (
  ast: SchemaAST.AST,
  name: string,
  holds: (field: SchemaAST.AST) => boolean,
): boolean => {
  const decoded = SchemaAST.toType(ast);
  if (SchemaAST.isUnion(decoded))
    return decoded.types.every((variant) => requires(variant, name, holds));
  if (!SchemaAST.isObjects(decoded)) return false;
  const field = decoded.propertySignatures.find((property) => property.name === name);
  return field !== undefined && !SchemaAST.isOptional(field.type) && holds(field.type);
};
/** Whether a payload has the required string `input.requestId` the daemon keys a mutation by. */
const keysByRequestId = (payload: SchemaAST.AST) =>
  requires(payload, 'input', (input) =>
    requires(input, 'requestId', (id) => SchemaAST.isString(SchemaAST.toType(id))),
  );

test('every procedure that takes a request ID is a mutation or the status call that resolves one', () => {
  for (const group of [ChatRpcs, WorkspaceRpcs])
    for (const [tag, rpc] of group.requests)
      if (takesRequestId(rpc)) assert(isMutationRpc(rpc) !== isStatusRpc(rpc), tag);
});

test('a daemon procedure is a mutation exactly when it takes a request ID, which keys its outcome', () => {
  // The daemon keys a mutation's outcome by its owner and `input.requestId`, so a mutation without
  // a required one there would read a later distinct request as a reuse of the first.
  for (const group of [LocalHostRpcs, ProviderSetupRpcs])
    for (const [tag, rpc] of group.requests) {
      assert.equal(isMutationRpc(rpc), takesRequestId(rpc), tag);
      if (isMutationRpc(rpc)) assert(keysByRequestId(rpc.payloadSchema.ast), tag);
    }
});

test('the daemon key check refuses a request ID that is optional, nested or in only one variant', () => {
  const payload = (input: Schema.Top) => Schema.Struct({ input }).ast;
  const id = { requestId: Schema.String };
  assert(keysByRequestId(payload(Schema.Struct({ ...id, path: Schema.String }))));
  for (const input of [
    Schema.Struct({ requestId: Schema.optionalKey(Schema.String) }),
    Schema.Struct({ requestId: Schema.NullOr(Schema.String) }),
    Schema.Struct({ metadata: Schema.Struct(id) }),
    Schema.Union([Schema.Struct(id), Schema.Struct({ path: Schema.String })]),
  ])
    assert(!keysByRequestId(payload(input)));
});
