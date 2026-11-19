import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as SchemaAST from 'effect/SchemaAST';
import { ChatRpcs } from '../src/chat-rpc.ts';
import { LocalHostRpcs, ProviderSetupRpcs } from '../src/daemon-rpc.ts';
import { isMutationRpc, isStatusRpc } from '../src/rpc-annotations.ts';
import { WorkspaceRpcs } from '../src/workspace-rpc.ts';

/** Whether a payload carries a `requestId`, at its top level or in its `input`. */
const takesRequestId = (ast: SchemaAST.AST, depth = 0): boolean => {
  if (depth > 2) return false;
  if (ast._tag === 'Union') return ast.types.some((type) => takesRequestId(type, depth));
  if (ast._tag !== 'Objects') return false;
  return ast.propertySignatures.some(
    (property) => property.name === 'requestId' || takesRequestId(property.type, depth + 1),
  );
};

test('every procedure that takes a request ID is a mutation or the status call that resolves one', () => {
  for (const group of [ChatRpcs, LocalHostRpcs, ProviderSetupRpcs, WorkspaceRpcs])
    for (const [tag, rpc] of group.requests)
      if (takesRequestId(rpc.payloadSchema.ast))
        assert(isMutationRpc(rpc) !== isStatusRpc(rpc), tag);
});
