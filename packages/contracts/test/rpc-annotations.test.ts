import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatRpcs } from '../src/chat-rpc.ts';
import { LocalHostRpcs, ProviderSetupRpcs } from '../src/daemon-rpc.ts';
import { isMutationRpc, isStatusRpc, takesRequestId } from '../src/rpc-annotations.ts';
import { WorkspaceRpcs } from '../src/workspace-rpc.ts';

test('every procedure that takes a request ID is a mutation or the status call that resolves one', () => {
  for (const group of [ChatRpcs, WorkspaceRpcs])
    for (const [tag, rpc] of group.requests)
      if (takesRequestId(rpc)) assert(isMutationRpc(rpc) !== isStatusRpc(rpc), tag);
});

test('a daemon procedure is a mutation exactly when it takes a request ID', () => {
  // The daemon keys a mutation's outcome by its owner and request ID, so a mutation without one
  // would read a later distinct request as a reuse of the first.
  for (const group of [LocalHostRpcs, ProviderSetupRpcs])
    for (const [tag, rpc] of group.requests)
      assert.equal(isMutationRpc(rpc), takesRequestId(rpc), tag);
});
