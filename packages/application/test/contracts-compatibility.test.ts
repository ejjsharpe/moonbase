import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '@moonbase/contracts/errors';
import { ChatService, ConnectionService, WorkspaceService } from '@moonbase/contracts/services';
import { ApplicationError as PreviousError } from '@moonbase/application/client';
import {
  ChatService as PreviousChat,
  ConnectionService as PreviousConnection,
  WorkspaceService as PreviousWorkspace,
} from '@moonbase/application/services';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import { decodeChatInput as previousDecode } from '@moonbase/application/chat-schema';
import * as handlers from '@moonbase/application/runtime/handlers';
import * as previousHandlers from '@moonbase/application/handlers';
import * as clients from '@moonbase/application/runtime/clients';
import * as previousClients from '@moonbase/application/runtime-client';
import * as invocation from '@moonbase/application/runtime/effect-client';
import * as previousInvocation from '@moonbase/application/effect-client';

test('temporary exports share canonical error, schema and service identities', () => {
  assert.strictEqual(PreviousError, ApplicationError);
  assert.strictEqual(PreviousChat, ChatService);
  assert.strictEqual(PreviousConnection, ConnectionService);
  assert.strictEqual(PreviousWorkspace, WorkspaceService);
  assert.strictEqual(previousDecode, decodeChatInput);
  assert(
    ApplicationError.is(new PreviousError({ code: 'Uncertain', message: 'Known safe error' })),
  );
});

test('temporary runtime entry points reexport the same canonical functions', () => {
  assert.deepEqual(previousHandlers, handlers);
  assert.deepEqual(previousClients, clients);
  assert.deepEqual(previousInvocation, invocation);
});
