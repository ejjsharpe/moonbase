import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cause, Exit } from 'effect';
import { Rpc } from 'effect/rpc';
import * as Schema from 'effect/Schema';
import { CancelledError, UnauthorizedError, UncertainError } from '@moonbase/contracts/errors';
import { getErrorGroup } from '@moonbase/contracts/error-groups';
import {
  BranchTakenError,
  GitStatusFormatError,
  IncompleteCleanupError,
  InterruptedRequestError,
  InvalidBaseError,
  InvalidPatternError,
  RecordedRefusalError,
  WorkspaceStoreError,
  WorktreeGitError,
} from '@moonbase/contracts/workspace-host-errors';
import { WorkspaceRpcs } from '@moonbase/contracts/workspace-rpc';
import { DaemonRpcs } from '../../src/client/daemon-rpc-link.ts';
import { toClientError } from '../../src/client/rpc-link.ts';
import { fileTarget } from '../workspace-fixture.ts';

// The security boundary between a client and an untrusted daemon (D11): whatever text a daemon
// writes into an error it sends, the error the client fails with carries none of it. A daemon is
// not trusted to run Moonbase's server, so each case forges the reply on the wire.

const secret = '/private/host-secret';

/**
 * The client's error for `procedure` failing with `error`, sent by a daemon with `forged` fields
 * added on the wire: decoded by the procedure's exit schema as the RPC client decodes it, then
 * shown as the link shows it.
 */
const received = (
  group: typeof WorkspaceRpcs | typeof DaemonRpcs,
  procedure: string,
  error: Error & { _tag: string },
  forged: Record<string, unknown>,
) => {
  // The procedure's schemas need no services; its static type says only that they may.
  const codec = Schema.toCodecJson(
    Rpc.exitSchema(group.requests.get(procedure)! as Rpc.Any),
  ) as unknown as Schema.Codec<unknown, unknown>;
  const wire = JSON.stringify(Schema.encodeUnknownSync(codec)(Exit.fail(error))).replace(
    `"_tag":"${error._tag}"`,
    (tag) => `${tag},${JSON.stringify(forged).slice(1, -1)}`,
  );
  assert(wire.includes(secret), 'the forged fields are on the wire');
  const exit = Schema.decodeUnknownSync(codec)(JSON.parse(wire)) as Exit.Exit<unknown, unknown>;
  assert(Exit.isFailure(exit));
  return toClientError(Cause.squash(exit.cause), procedure) as Error;
};

test('an error a daemon sends reaches the client with its group and none of the text the daemon wrote', () => {
  // Each error class that once held, or still names, text a host writes, by the fields a daemon
  // fills with it.
  const cases = [
    [WorkspaceRpcs, 'createWorktree', new WorktreeGitError(), { detail: secret }, 'unavailable'],
    [WorkspaceRpcs, 'searchText', new InvalidPatternError(), { reason: secret }, 'refusal'],
    [WorkspaceRpcs, 'createWorktree', new InvalidBaseError(), { base: secret }, 'refusal'],
    [WorkspaceRpcs, 'gitStatus', new GitStatusFormatError(), { record: secret }, 'unavailable'],
    [
      WorkspaceRpcs,
      'createWorktree',
      new IncompleteCleanupError({ remains: 'location-exists' }),
      { inspect: secret, failure: secret },
      'uncertain',
    ],
    [
      WorkspaceRpcs,
      'createWorktree',
      new BranchTakenError({ inside: true }),
      { branch: secret },
      'conflict',
    ],
    [
      WorkspaceRpcs,
      'createWorktree',
      new RecordedRefusalError({ refusal: 'conflict' }),
      { text: secret },
      'conflict',
    ],
    [
      WorkspaceRpcs,
      'saveFile',
      new WorkspaceStoreError({ failure: 'publication' }),
      { detail: secret },
      'storage',
    ],
    [
      WorkspaceRpcs,
      'createWorktree',
      new InterruptedRequestError({ operation: 'createWorktree' }),
      { operation: secret },
      'uncertain',
    ],
    [
      WorkspaceRpcs,
      'saveFile',
      new UncertainError({ operation: 'saveFile' }),
      { operation: secret, target: { ...fileTarget, path: secret } },
      'uncertain',
    ],
    [
      WorkspaceRpcs,
      'readFile',
      new UnauthorizedError({ operation: 'readFile' }),
      { operation: secret },
      'access',
    ],
    [
      DaemonRpcs,
      'sendChat',
      new UncertainError({ operation: 'sendChat' }),
      { operation: secret },
      'uncertain',
    ],
    [
      DaemonRpcs,
      'getChat',
      new UnauthorizedError({ operation: 'getChat' }),
      { operation: secret },
      'access',
    ],
  ] as const;
  for (const [group, procedure, error, forged, expected] of cases) {
    const shown = received(group, procedure, error, forged);
    const tag = error._tag;
    assert.equal((shown as { _tag?: string })._tag, tag);
    assert.equal(getErrorGroup(shown), expected, tag);
    assert(!JSON.stringify(shown).includes(secret) && !shown.message.includes(secret), tag);
  }
  // A shared outcome names the operation the client asked for, never the daemon's.
  assert.equal(
    (
      received(WorkspaceRpcs, 'saveFile', new CancelledError({ operation: 'x' }), {
        operation: secret,
      }) as CancelledError
    ).operation,
    'saveFile',
  );
});
