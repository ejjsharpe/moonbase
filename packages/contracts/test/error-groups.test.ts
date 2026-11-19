import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Schema from 'effect/Schema';
import { ChatBusyError } from '@moonbase/contracts/chat-errors';
import { ConnectionError, HostVerificationError } from '@moonbase/contracts/connection-errors';
import { CancelledError, UncertainError } from '@moonbase/contracts/errors';
import { getErrorGroup, isKnownError } from '@moonbase/contracts/error-groups';
import { HostUnavailableError } from '@moonbase/contracts/host-errors';
import { IpcClosedError } from '@moonbase/contracts/ipc-errors';
import { chatProjectErrors } from '@moonbase/contracts/workspace-rpc';
import {
  InterruptedRequestError,
  InvalidPathError,
  RecordedRefusalError,
} from '@moonbase/contracts/workspace-host-errors';

test('a failure is grouped by its tag, or by its reason where one class covers several', () => {
  for (const [error, group] of [
    [new InvalidPathError({ problem: 'not-relative' }), 'refusal'],
    [new ChatBusyError(), 'conflict'],
    [new HostUnavailableError({ reason: 'closed' }), 'unavailable'],
    [new UncertainError({ operation: 'Save' }), 'uncertain'],
    [new InterruptedRequestError({ operation: 'createWorktree' }), 'uncertain'],
    [new CancelledError({ operation: 'Save' }), 'cancelled'],
    [new ConnectionError({ reason: 'stale-generation' }), 'conflict'],
    [new ConnectionError({ reason: 'closed' }), 'unavailable'],
    [new HostVerificationError({ reason: 'rejected' }), 'access'],
    [new RecordedRefusalError({ refusal: 'unauthorized', text: 'Refused.' }), 'access'],
    [new IpcClosedError({ sent: true }), 'uncertain'],
    [new IpcClosedError({ sent: false }), 'unavailable'],
  ] as const)
    assert.equal(getErrorGroup(error), group, error._tag);
});

test('a decoded error keeps its group, and anything contracts does not define has none', () => {
  const schema = Schema.Union(chatProjectErrors);
  const decoded = Schema.decodeUnknownSync(schema)(
    Schema.encodeSync(schema)(new UncertainError({ operation: 'Save' })),
  );
  assert.equal(getErrorGroup(decoded), 'uncertain');
  for (const value of [new Error('Uncertain'), { _tag: 'UncertainError' }, 'UncertainError'])
    assert.equal(isKnownError(value), false);
});
