import assert from 'node:assert/strict';
import { getErrorGroup } from '@moonbase/contracts/error-groups';
import { connect } from 'node:net';
import { test } from 'node:test';
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from 'effect';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { ChatService } from '@moonbase/contracts/services';
import {
  rpcLimits,
  workspaceRpcLimits,
  workspaceRpcPath,
  workspaceRpcProtocol,
} from '@moonbase/contracts/rpc-upgrade';
import type { WorkspaceEvent } from '@moonbase/contracts/workspace';
import {
  BranchTakenError,
  CheckoutAccessError,
  GitStatusFormatError,
  IncompleteCleanupError,
  InterruptedRequestError,
  InvalidBaseError,
  InvalidPatternError,
  RecordedRefusalError,
  WorkspaceStoreError,
  WorktreeGitError,
} from '@moonbase/contracts/workspace-host-errors';
import { UncertainError } from '@moonbase/contracts/errors';
import { WorkspaceRpcs } from '@moonbase/contracts/workspace-rpc';
import { chatHostCapabilities } from '@moonbase/contracts/host';
import { requestUpgradeNonce } from '../src/health.ts';
import { DaemonRpcLinkLive, EndpointConnectionLive, RemoteChatLive } from '../src/client/remote.ts';
import { streamLimits } from '../src/client/protocol.ts';
import { makeRpcLink } from '../src/client/rpc-link.ts';
import { upgradeProtocols } from '../src/upgrade-proof.ts';
import { nonce, snapshotOf, host, target } from './controlled-chat-fixture.ts';
import { until } from './runtime-fixture.ts';
import { encodeWebSocketFrame } from './websocket-frame-fixture.ts';
import { recordSockets } from './recorded-sockets-fixture.ts';
import {
  checkout,
  controlledWorkspace,
  fileTarget,
  foreign,
  identity,
  remoteWorkspace,
  saveInput,
  serveWorkspace,
} from './workspace-fixture.ts';

/** What a failed call failed with. */
const failure = <A, E>(
  run: <B, F>(effect: Effect.Effect<B, F>) => Promise<B>,
  effect: Effect.Effect<A, E>,
) => run(Effect.flip(effect)) as Promise<E & { _tag: string }>;
/** Moves `client`'s clock on until `promise` settles; pongs arrive between the steps. */
async function advanceUntil<A>(
  client: { advance(ms: number): Promise<void> },
  promise: Promise<A>,
) {
  let settled = false;
  void promise.finally(() => (settled = true));
  await until(async () => {
    await client.advance(4000);
    return settled;
  }, Boolean);
  return promise;
}
/** Asserts `error` has `expected`'s fields. */
const assertError = (error: unknown, expected: Record<string, unknown>) =>
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((key) => [key, (error as never)[key]])),
    expected,
  );
/** A JSON input of about `bytes` that `getIgnoredPaths` takes, holding its input while it runs. */
const holding = (bytes: number) => ({
  checkout,
  path: '',
  paths: Array.from({ length: Math.ceil(bytes / 4000) }, () => 'x'.repeat(4000)),
});

test('a 2 MiB file saves and reads back; a reply past its bound is refused, as Uncertain for a mutation, and a request past its bound or to a host without files is never sent', async (t) => {
  const files = controlledWorkspace(),
    stored = new Map<string, string>();
  files.handlers.saveFile = async (input: ReturnType<typeof saveInput>) => {
    stored.set(input.target.path, input.text);
    return { kind: 'saved', version: 'v1' };
  };
  files.handlers.readFile = async (input: { path: string }) => ({
    text: stored.get(input.path)!,
    version: 'v1',
  });
  // A reply only a misbehaving host would make: past the reply bound.
  const huge = Array.from({ length: 4300 }, () => 'y'.repeat(4000));
  files.handlers.getIgnoredPaths = async () => ({ paths: huge });
  files.handlers.mutate = async () => ({
    id: 'op',
    clientId: identity.clientId,
    checkout,
    kind: 'create-file',
    outcome: 'completed',
    items: [],
    message: 'm'.repeat(17 * 1024 * 1024),
  });
  const daemon = await serveWorkspace(t, files.service);
  const client = await remoteWorkspace(t, daemon);
  const { workspace, run } = client;
  const text = 'line "quoted"\n'.repeat(Math.floor((2 * 1024 * 1024) / 14));
  assert.equal((await run(workspace.saveFile(saveInput(text)))).kind, 'saved');
  assert.equal((await run(workspace.readFile(fileTarget))).text, text);
  assertError(await failure(run, workspace.getIgnoredPaths({ checkout, path: '', paths: [] })), {
    _tag: 'InvalidRequestError',
    problem: 'reply-too-large',
  });
  const lost = await failure(
    run,
    workspace.mutate({
      ...identity,
      id: 'op',
      checkout,
      kind: 'create-file',
      sources: [],
      destination: 'new.txt',
      text: '',
    }),
  );
  assert.equal(lost._tag, 'UncertainError');
  // The connection carries on.
  assert.equal((await run(workspace.readFile(fileTarget))).text, text);
  const sent = files.calls.length;
  assertError(
    await failure(run, workspace.getIgnoredPaths(holding(workspaceRpcLimits.payloadBytes + 1))),
    { _tag: 'InvalidRequestError', problem: 'request-too-large' },
  );
  assert.equal(files.calls.length, sent);

  // A daemon that composes no file host advertises none; its clients send nothing to it.
  const bare = await serveWorkspace(t);
  const plain = await remoteWorkspace(t, bare);
  assertError(await failure(plain.run, plain.workspace.readFile(fileTarget)), {
    _tag: 'IncompatibleHostError',
    reason: 'not-served',
  });
  assert.equal(
    getErrorGroup(
      await failure(plain.run, Stream.runDrain(plain.workspace.watch({ checkout, paths: [''] }))),
    ),
    'incompatible',
  );
});

test('a call or watch for another host is refused before it is sent and by the daemon, and a reply naming another host’s checkout is refused', async (t) => {
  const files = controlledWorkspace();
  files.handlers.openCheckout = async () => foreign;
  files.handlers.createWorktree = async () => foreign;
  const daemon = await serveWorkspace(t, files.service);
  const { workspace, run } = await remoteWorkspace(t, daemon);
  assert.equal(
    (await failure(run, workspace.readFile({ checkout: foreign, path: 'a.txt' })))._tag,
    'UnauthorizedError',
  );
  assert.equal(
    (await failure(run, Stream.runDrain(workspace.watch({ checkout: foreign, paths: [''] }))))._tag,
    'UnauthorizedError',
  );
  assert.deepEqual(files.calls, []);
  // A client that skips those checks is refused by the daemon, and no handler runs.
  const linkRuntime = ManagedRuntime.make(EndpointConnectionLive(daemon.endpoint));
  t.after(() => linkRuntime.dispose());
  const refused = await linkRuntime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const direct = yield* makeRpcLink({
          host,
          group: WorkspaceRpcs,
          path: workspaceRpcPath,
          protocol: workspaceRpcProtocol,
          inboundBytes: workspaceRpcLimits.messageBytes,
        });
        const options = {
          capability: chatHostCapabilities.workspace,
          present: <E>(error: E) => error,
        };
        const tags: string[] = [];
        const attempt = (effect: Effect.Effect<unknown, unknown>) =>
          Effect.flatMap(Effect.flip(effect), (error) =>
            Effect.sync(() => void tags.push((error as { _tag: string })._tag)),
          );
        yield* attempt(
          direct.call(
            'readFile',
            (client) => client.readFile({ host, input: { checkout: foreign, path: 'a.txt' } }),
            options,
          ),
        );
        yield* attempt(
          direct.call(
            'readFile',
            (client) =>
              client.readFile({ host: { ...host, hostId: 'other-host' }, input: fileTarget }),
            options,
          ),
        );
        yield* attempt(
          direct.call(
            'turnChatIntoProject',
            (client) =>
              client.turnChatIntoProject({
                host,
                input: {
                  ...identity,
                  requestId: 'turn',
                  target: { ...target, host: { ...host, hostId: 'other-host' } },
                },
              }),
            options,
          ),
        );
        yield* attempt(
          Stream.runDrain(
            direct.follow(
              'watchWorkspace',
              (client) => client.watchWorkspace({ host, checkout: foreign }),
              { ...options, next: (_, value) => Effect.succeed(value) },
            ),
          ),
        );
        return tags;
      }),
    ),
  );
  assert.deepEqual(refused, [
    'UnauthorizedError',
    'UnauthorizedError',
    'UnauthorizedError',
    'UnauthorizedError',
  ]);
  assert.deepEqual(files.calls, []);
  // The daemon answers an open with a checkout of another host: refused, or Uncertain for a
  // mutation, which may have applied.
  assertError(await failure(run, workspace.openCheckout({ root: '/work' })), {
    _tag: 'IncompatibleHostError',
    reason: 'invalid-reply',
  });
  const made = await failure(
    run,
    workspace.createWorktree({
      installationId: identity.installationId,
      requestId: 'w',
      checkout: { ...checkout, vcs: 'git', branch: 'main', worktree: 'main' },
      branch: 'b',
      base: 'main',
      location: '/work-b',
    } as never),
  );
  assert.equal(made._tag, 'UncertainError');
  assert.deepEqual(files.calls, ['openCheckout', 'createWorktree']);
});

test('an upgrade the daemon refuses, or a host that does not prove the key, is not the one expected or does not serve the socket, fails calls and watches and is not retried unasked; the next call proves a fresh socket', async (t) => {
  const files = controlledWorkspace();
  files.handlers.readFile = async () => ({ text: 'ok', version: 'v1' });
  const daemon = await serveWorkspace(t, files.service);
  const sockets = recordSockets(t);
  sockets.refuse = true;
  const client = await remoteWorkspace(t, daemon, true);
  const { workspace, run } = client;
  const watched = () => failure(run, Stream.runDrain(workspace.watch({ checkout, paths: [''] })));
  assertError(await failure(run, workspace.readFile(fileTarget)), {
    _tag: 'HostUnavailableError',
    reason: 'refused',
  });
  assertError(await watched(), { _tag: 'HostUnavailableError', reason: 'refused' });
  // Each tried one socket; long past every reconnect delay, none was tried again.
  await client.advance(60_000);
  assert.equal(sockets.opened.length, 2);
  sockets.refuse = false;
  assert.equal((await run(workspace.readFile(fileTarget))).text, 'ok');
  assert.equal(sockets.opened.length, 3);
  assert.equal(new Set(sockets.opened.map(({ protocols }) => protocols[1])).size, 3);
  // A host that doesn't prove the key or isn't the one expected fails its health check, and one
  // that doesn't serve files is refused after it: no socket opens, and none is retried. A watch waits through reconnects, so its
  // failing shows the connection was given up on.
  const bare = await serveWorkspace(t);
  for (const [endpoint, group] of [
    [{ ...daemon.endpoint, token: nonce() }, 'access'],
    [{ ...daemon.endpoint, expected: { ...host, storeId: 'another-store' } }, 'incompatible'],
    [bare.endpoint, 'incompatible'],
  ] as const) {
    const refused = await remoteWorkspace(t, { endpoint }, true);
    for (const error of [
      await failure(refused.run, refused.workspace.readFile(fileTarget)),
      await failure(
        refused.run,
        Stream.runDrain(refused.workspace.watch({ checkout, paths: [''] })),
      ),
    ])
      assert.equal(getErrorGroup(error), group);
    await refused.advance(60_000);
    assert.equal(sockets.opened.length, 3);
  }
  assert.deepEqual(files.calls, ['readFile']);
});

test('a host’s errors reach the client with their codes and the client’s own text, never the host’s', async (t) => {
  const secret = '/private/host-secret';
  const raised = [
    new WorktreeGitError({ detail: secret }),
    new InvalidPatternError({ reason: secret }),
    new InvalidBaseError({ base: secret }),
    new GitStatusFormatError({ record: secret }),
    new IncompleteCleanupError({ remains: secret, inspect: secret, failure: secret }),
    new RecordedRefusalError({ refusal: 'conflict', text: secret }),
    new WorkspaceStoreError({ failure: 'publication', detail: secret }),
    new InterruptedRequestError({ operation: secret }),
    new UncertainError({ operation: secret, target: { ...fileTarget, path: secret } }),
    new CheckoutAccessError({ refusal: 'not-approved' }),
    new BranchTakenError({ branch: secret, inside: true }),
    new Error(secret),
  ];
  const files = controlledWorkspace();
  let next = 0;
  files.handlers.readFile = async () => {
    throw raised[next++];
  };
  const daemon = await serveWorkspace(t, files.service);
  const { workspace, run } = await remoteWorkspace(t, daemon);
  const codes: string[] = [];
  for (const _ of raised) {
    const error = await failure(run, workspace.readFile(fileTarget));
    assert(!JSON.stringify(error).includes(secret) && !error.message.includes(secret), error._tag);
    codes.push(getErrorGroup(error)!);
  }
  assert.deepEqual(codes, [
    'unavailable',
    'refusal',
    'refusal',
    'unavailable',
    'uncertain',
    'conflict',
    'storage',
    'uncertain',
    'uncertain',
    'access',
    'conflict',
    'unavailable',
  ]);
  // A branch `createWorktree` found taken is named as the client asked for it.
  files.handlers.createWorktree = async () => {
    throw new BranchTakenError({ branch: secret, inside: false });
  };
  const taken = await failure(
    run,
    workspace.createWorktree({
      installationId: identity.installationId,
      requestId: 'w',
      checkout: { ...checkout, vcs: 'git', branch: 'main', worktree: 'main' },
      branch: 'feature',
      base: 'main',
      location: '/work-b',
    }),
  );
  assert(taken.message.includes('feature') && !taken.message.includes(secret));
});

const operation = {
  ...identity,
  id: 'op-1',
  checkout,
  kind: 'create-file' as const,
  sources: [],
  destination: 'new.txt',
  text: 'x',
};
const completed = {
  id: 'op-1',
  clientId: identity.clientId,
  checkout,
  kind: 'create-file',
  outcome: 'completed',
  items: [],
};

test('a mutation whose connection drops or whose reply is late is Uncertain, is never sent again and runs to completion, and operationStatus reads its outcome back', async (t) => {
  const files = controlledWorkspace(),
    outcomes = new Map<string, unknown>(),
    gates: PromiseWithResolvers<void>[] = [];
  files.handlers.mutate = async (input: { id: string }) => {
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    await gate.promise;
    outcomes.set(input.id, { ...completed, id: input.id });
    return { ...completed, id: input.id };
  };
  files.handlers.operationStatus = async (input: { id: string }) => outcomes.get(input.id) ?? null;
  // The daemon waits for running mutations when it stops, up to its close deadline.
  t.after(() => gates.forEach((gate) => gate.resolve()));
  let closeTimedOut = false;
  const daemon = await serveWorkspace(t, files.service, {
    closeMs: 5_000,
    onCloseTimeout: Effect.sync(() => void (closeTimedOut = true)),
  });
  const sockets = recordSockets(t);
  const client = await remoteWorkspace(t, daemon, true);
  const { workspace, run } = client;
  // The socket drops while the daemon applies it, and runs a read. The client opens another, with
  // a proof of its own, which carries later requests; neither is sent on it again.
  files.handlers.readFile = () => new Promise(() => {});
  const lost = run(Effect.flip(workspace.mutate({ ...operation, id: 'op-0' })));
  const lostRead = run(Effect.flip(workspace.readFile(fileTarget)));
  await until(
    async () => gates.length + files.calls.filter((call) => call === 'readFile').length,
    (count) => count === 2,
  );
  sockets.opened[0]!.socket.close();
  assert.equal(((await lost) as { _tag: string })._tag, 'UncertainError');
  assertError(await lostRead, { _tag: 'HostUnavailableError', reason: 'reply-lost' });
  await client.advance(streamLimits.reconnectMs[0]);
  assert.equal(await run(workspace.operationStatus({ ...identity, id: 'none' })), null);
  assert.equal(sockets.opened.length, 2);
  // The connection drops while the daemon applies it.
  const dropped = run(Effect.flip(workspace.mutate(operation)));
  await until(
    async () => gates.length,
    (count) => count === 2,
  );
  // A new generation's first request closes the old connection.
  client.replace();
  assert.equal(await run(workspace.operationStatus({ ...identity, id: 'none' })), null);
  assert.equal(((await dropped) as { _tag: string })._tag, 'UncertainError');
  // No reply comes within the mutation deadline.
  const late = run(Effect.flip(workspace.mutate({ ...operation, id: 'op-2' })));
  await until(
    async () => gates.length,
    (count) => count === 3,
  );
  assert.equal(((await advanceUntil(client, late)) as { _tag: string })._tag, 'UncertainError');
  // No mutation was cancelled on the daemon (the read ended with its connection), nor was any
  // request sent again; each mutation runs to completion there.
  for (const gate of gates) gate.resolve();
  for (const id of ['op-0', 'op-1', 'op-2']) {
    const status = await until(() => run(workspace.operationStatus({ ...identity, id })), Boolean);
    assert.equal(status!.outcome, 'completed');
  }
  assert.deepEqual(files.interrupted, ['readFile']);
  assert.equal(files.calls.filter((call) => call === 'mutate').length, 3);
  assert.equal(files.calls.filter((call) => call === 'readFile').length, 1);
  // Each socket proved itself with a proof of its own.
  assert.equal(sockets.opened.length, 3);
  assert.equal(new Set(sockets.opened.map(({ protocols }) => protocols[1])).size, 3);
  // Stopping waits for a mutation still running only up to its close deadline, then goes on.
  void run(Effect.flip(workspace.mutate({ ...operation, id: 'op-3' })));
  await until(
    async () => gates.length,
    (count) => count === 4,
  );
  await advanceUntil(daemon, daemon.stop());
  assert(closeTimedOut);
});

test('requests past the input a connection may hold in flight wait unsent on the client and are refused busy by the daemon, while status calls and watches still run', async (t) => {
  const files = controlledWorkspace(),
    holds: PromiseWithResolvers<{ paths: string[] }>[] = [];
  t.after(() => holds.forEach((hold) => hold.resolve({ paths: [] })));
  files.handlers.getIgnoredPaths = () => {
    const hold = Promise.withResolvers<{ paths: string[] }>();
    holds.push(hold);
    return hold.promise;
  };
  files.handlers.readFile = async () => ({ text: 'ok', version: 'v1' });
  files.handlers.saveStatus = async () => ({ kind: 'not-started' });
  files.handlers.saveFile = async () => ({ kind: 'saved', version: 'v1' });
  const daemon = await serveWorkspace(t, files.service);
  const client = await remoteWorkspace(t, daemon);
  const { workspace, run } = client;
  // Two requests of nearly a request's bound each hold their input while the host runs them.
  const input = holding(workspaceRpcLimits.payloadBytes - 64 * 1024);
  const reads = [0, 1].map(() => run(Effect.flip(workspace.getIgnoredPaths(input))));
  await until(
    async () => files.calls.length,
    (count) => count === 2,
  );
  // A small read still fits; a save that would pass the bound waits on the client, unsent.
  assert.equal((await run(workspace.readFile(fileTarget))).text, 'ok');
  const save = run(Effect.flip(workspace.saveFile(saveInput('x'.repeat(1024 * 1024)))));
  // The bound is for plain requests' input: a status call and a watch still have their places.
  assert.deepEqual(await run(workspace.saveStatus({ ...identity, requestId: 'save-1' })), {
    kind: 'not-started',
  });
  const watched = await run(Stream.runHead(workspace.watch({ checkout, paths: [''] })));
  assert.equal(watched._tag, 'Some');
  assert(!files.calls.includes('saveFile'));
  // A client that skips that bound is refused by the daemon (per connection) before it runs: busy,
  // so a mutation it refused was never applied.
  const linkRuntime = ManagedRuntime.make(EndpointConnectionLive(daemon.endpoint));
  t.after(() => linkRuntime.dispose());
  const refused = await linkRuntime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const direct = yield* makeRpcLink({
          host,
          group: WorkspaceRpcs,
          path: workspaceRpcPath,
          protocol: workspaceRpcProtocol,
          inboundBytes: workspaceRpcLimits.messageBytes,
        });
        const options = {
          capability: chatHostCapabilities.workspace,
          present: <E>(error: E) => error,
        };
        const read = direct.call(
          'getIgnoredPaths',
          (client) => client.getIgnoredPaths({ host, input }),
          options,
        );
        for (let index = 0; index < 2; index++) yield* Effect.forkScoped(Effect.ignore(read));
        yield* Effect.promise(() =>
          until(
            async () => files.calls.filter((call) => call === 'getIgnoredPaths').length,
            (count) => count === 4,
          ),
        );
        return yield* Effect.flip(
          direct.call(
            'saveFile',
            (client) =>
              client.saveFile({ host, input: saveInput('x'.repeat(1024 * 1024), 'save-2') }),
            options,
          ),
        );
      }),
    ),
  );
  assertError(refused, { _tag: 'HostUnavailableError', reason: 'busy' });
  // The connection closes while the save waits for its bytes: it was never sent, so it is busy,
  // not Uncertain, and the reads it carried lost their replies to the generation change.
  client.replace();
  assert.deepEqual(await run(workspace.saveStatus({ ...identity, requestId: 'save-1' })), {
    kind: 'not-started',
  });
  assertError(await save, { _tag: 'HostUnavailableError', reason: 'busy' });
  for (const read of reads)
    assertError(await read, {
      _tag: 'HostUnavailableError',
      reason: 'generation-changed',
    });
  assert(!files.calls.includes('saveFile'));
  // Nothing it held is kept: requests filling the whole bound again go through.
  files.handlers.getIgnoredPaths = async () => ({ paths: [] });
  const again = await Promise.all([
    run(workspace.getIgnoredPaths(input)),
    run(workspace.getIgnoredPaths(input)),
    run(workspace.saveFile(saveInput('x'.repeat(1024 * 1024), 'save-3'))),
  ]);
  assert.equal((again[2] as { kind: string }).kind, 'saved');
});

test('a request keeps its place until the daemon answers it, status calls keep places of their own, a wait for a place ends unsent at its deadline, and a cancelled read frees its place at once', async (t) => {
  const files = controlledWorkspace(),
    answers: (() => void)[] = [];
  files.handlers.acknowledgeSave = () =>
    new Promise<never>((resolve) => answers.push(() => resolve(undefined as never)));
  files.handlers.saveStatus = async () => ({ kind: 'not-started' });
  // The host ignores the cancel: these reads never end by themselves.
  files.handlers.readFile = () => new Promise(() => {});
  // The daemon waits for running mutations when it stops.
  t.after(() => answers.forEach((answer) => answer()));
  const daemon = await serveWorkspace(t, files.service);
  const client = await remoteWorkspace(t, daemon, true);
  const { workspace, run } = client;
  const limit = workspaceRpcLimits.requests;
  const acknowledge = (requestId: string) =>
    run(Effect.flip(workspace.acknowledgeSave({ ...identity, requestId })));
  const hung = Array.from({ length: limit }, (_, i) => acknowledge(`hung-${i}`));
  await until(
    async () => answers.length,
    (count) => count === limit,
  );
  const waitingRead = run(Effect.flip(workspace.readFile(fileTarget)));
  // A status call runs although every other place is held.
  assert.deepEqual(await run(workspace.saveStatus({ ...identity, requestId: 'hung-0' })), {
    kind: 'not-started',
  });
  // Past their deadline the mutations are Uncertain; the read never got a place, so was never sent.
  assert.deepEqual(
    (await advanceUntil(client, Promise.all(hung))).map(
      (error) => (error as { _tag: string })._tag,
    ),
    Array(limit).fill('UncertainError'),
  );
  assertError(await waitingRead, { _tag: 'HostUnavailableError', reason: 'busy' });
  assert(!files.calls.includes('readFile'));
  // The places stay held until the daemon answers, although every caller gave up: a read waits
  // for one, and a late answer frees it.
  const read = client.fork(workspace.readFile(fileTarget));
  assert(!files.calls.includes('readFile'));
  answers.shift()!();
  const readsSent = async () => files.calls.filter((call) => call === 'readFile').length;
  await until(readsSent, (count) => count === 1);
  // A cancelled read is interrupted on the daemon at once and frees its place.
  await run(Fiber.interrupt(read));
  await until(async () => files.interrupted.includes('readFile'), Boolean);
  const next = client.fork(workspace.readFile(fileTarget));
  await until(readsSent, (count) => count === 2);
  // Closing the connection fails what it carried, a read still waiting for a place on it too, and
  // frees every place: a new generation's first request closes the old one.
  const waiting = client.fork(Effect.flip(workspace.readFile(fileTarget)));
  client.replace();
  files.handlers.readFile = async () => ({ text: 'freed', version: 'v1' });
  assert.deepEqual(await run(workspace.saveStatus({ ...identity, requestId: 'hung-1' })), {
    kind: 'not-started',
  });
  // Closing waits at most a second for each cancel it sends.
  for (const fiber of [Effect.flip(Fiber.join(next)), Fiber.join(waiting)])
    assert.equal(
      ((await advanceUntil(client, run(fiber))) as { _tag: string })._tag,
      'HostUnavailableError',
    );
  assert.equal((await advanceUntil(client, run(workspace.readFile(fileTarget)))).text, 'freed');
});

test('a watch follows changes, is bounded per connection, ends retryably when the host’s watch finishes, and after a reconnect starts from a fresh value', async (t) => {
  const files = controlledWorkspace();
  const daemon = await serveWorkspace(t, files.service);
  const client = await remoteWorkspace(t, daemon);
  const events: WorkspaceEvent[] = [],
    ended: string[] = [];
  const follow = (record = false) =>
    client.fork(
      Stream.runForEach(client.workspace.watch({ checkout, paths: ['a'] }), (event) =>
        Effect.sync(() => void (record && events.push(event))),
      ).pipe(Effect.catch((error) => Effect.sync(() => void ended.push(getErrorGroup(error)!)))),
    );
  follow(true);
  await until(async () => events.length, Boolean);
  assert.deepEqual(events[0], { checkout, paths: [''], ready: true });
  files.change();
  await until(
    async () => events.length,
    (count) => count === 2,
  );
  assert.deepEqual(events[1], { checkout, paths: [''] });
  // A connection holds 64 watches; the next is refused.
  for (let index = 1; index < workspaceRpcLimits.watches; index++) follow();
  await until(
    async () => files.watchers.size,
    (count) => count === workspaceRpcLimits.watches,
  );
  follow();
  await until(async () => ended.length, Boolean);
  assert.deepEqual(ended, ['unavailable']);
  // After the daemon restarts, a watch starts again from a fresh value: an event to read again from.
  // So it does when the daemon's RPC server closes before its sockets, ending each watch with an
  // interrupted exit (#404).
  await daemon.stop();
  await daemon.start({ closeRpcFirst: true });
  await until(
    async () => events.length,
    (count) => count === 3,
  );
  assert.deepEqual(events[2], { checkout, paths: [''] });
  await daemon.stop();
  await daemon.start();
  await until(
    async () => events.length,
    (count) => count === 4,
  );
  assert.deepEqual(events[3], { checkout, paths: [''] });
  // A host watch that finishes ends its watches as Unavailable, which a client retries.
  await until(async () => files.watchers.size, Boolean);
  ended.length = 0;
  const open = files.watchers.size;
  files.end();
  await until(
    async () => ended.length,
    (count) => count === open,
  );
  assert(ended.every((group) => group === 'unavailable'));
});

/**
 * A workspace connection on a bare TCP socket that sends `requests` for `getIgnoredPaths` and then
 * reads nothing until the test resumes it.
 */
async function slowReader(
  t: { after(run: () => unknown): void },
  daemon: Awaited<ReturnType<typeof serveWorkspace>>,
  requests: number,
) {
  const { upgradeNonce } = await Effect.runPromise(requestUpgradeNonce(daemon.endpoint));
  const [protocol, proof] = upgradeProtocols(
    daemon.token,
    upgradeNonce,
    host,
    workspaceRpcProtocol,
  );
  const tcp = connect(daemon.port, '127.0.0.1');
  t.after(() => tcp.destroy());
  await new Promise((resolve, reject) => tcp.once('connect', resolve).once('error', reject));
  const state = { received: 0, closed: false };
  tcp.on('data', (bytes: Buffer) => void (state.received += bytes.length));
  tcp.on('close', () => void (state.closed = true));
  tcp.on('error', () => void (state.closed = true));
  tcp.write(
    [
      `GET ${workspaceRpcPath} HTTP/1.1`,
      `Host: 127.0.0.1:${daemon.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}`,
      `Sec-WebSocket-Protocol: ${protocol}, ${proof}`,
      '',
      '',
    ].join('\r\n'),
  );
  await until(async () => state.received, Boolean);
  tcp.pause();
  for (let id = 1; id <= requests; id++) {
    const request = {
      _tag: 'Request',
      id: String(id),
      tag: 'getIgnoredPaths',
      payload: { host, input: { checkout, path: '', paths: [] } },
      headers: [],
    };
    tcp.write(encodeWebSocketFrame(1, Buffer.from(JSON.stringify(request)), true));
  }
  return {
    state,
    resume: () => tcp.resume(),
    /** Sends an RPC ping, which counts as activity; it fails once the daemon has closed. */
    ping: () =>
      tcp.write(encodeWebSocketFrame(1, Buffer.from(JSON.stringify({ _tag: 'Ping' })), true)),
    /** What the client has written that the connection has not taken yet. */
    pending: () => tcp.writableLength,
    /** Sends a message of `bytes`, which the daemon reads only as far as its framing. */
    send: (bytes: number) => tcp.write(encodeWebSocketFrame(1, Buffer.alloc(bytes, 0x20), true)),
  };
}
/** About the bytes of one `getIgnoredPaths` reply these tests make. */
const reply = 15_000_000;

test('large workspace replies a client is slow to read never delay chat updates, are all written once it reads, hold back its reading meanwhile, and one that never reads is dropped', async (t) => {
  const files = controlledWorkspace(),
    paths = Array.from({ length: 3800 }, () => 'p'.repeat(4000));
  files.handlers.getIgnoredPaths = async () => ({ paths });
  const daemon = await serveWorkspace(t, files.service);
  // Two replies of about 15 MiB each wait to be written to a client that reads none of them.
  const slow = await slowReader(t, daemon, 2);
  await until(
    async () => files.calls.length,
    (count) => count === 2,
  );

  // Meanwhile a chat streams over the RPC socket.
  const chat = ManagedRuntime.make(
    RemoteChatLive.pipe(
      Layer.provide(DaemonRpcLinkLive({ host })),
      Layer.provide(EndpointConnectionLive(daemon.endpoint)),
    ),
  );
  t.after(() => chat.dispose());
  const seen: ChatSnapshot[] = [];
  const service = await chat.runPromise(ChatService);
  chat.runFork(
    Stream.runForEach(service.watch({ target }), (snapshot) =>
      Effect.sync(() => void seen.push(snapshot)),
    ),
  );
  await until(async () => seen.length, Boolean);
  for (let index = 1; index <= 20; index++) {
    daemon.chat.publish(snapshotOf('streamed '.repeat(index)));
    await until(
      async () => seen.at(-1)?.run?.text,
      (text) => text === 'streamed '.repeat(index).slice(-64),
    );
  }
  // Once the client reads, both replies arrive whole: neither write lost its wake-up.
  assert(slow.state.received < reply);
  slow.resume();
  await until(
    async () => slow.state.received,
    (bytes) => bytes > 2 * reply,
  );
  assert(!slow.state.closed);

  // A client that drains nothing of a reply for `drainMs` is disconnected, although it pings
  // within the idle bound.
  const stuck = await slowReader(t, daemon, 1);
  await until(
    async () => files.calls.length,
    (count) => count === 3,
  );
  await until(async () => {
    stuck.ping();
    await daemon.advance(rpcLimits.drainMs / 4);
    return stuck.state.closed;
  }, Boolean);

  // While replies past `queuedBytes` wait for it, the daemon stops reading the connection: what
  // the client keeps sending meanwhile backs up in its own buffers, not the daemon's, and it stays
  // connected until it reads, when both directions flow again.
  const busy = await slowReader(t, daemon, 6);
  await until(
    async () => files.calls.length,
    (count) => count === 9,
  );
  for (let index = 0; index < 6; index++) busy.send(workspaceRpcLimits.messageBytes - 1024);
  await until(
    async () => busy.pending(),
    (bytes) => bytes > 4 * workspaceRpcLimits.messageBytes,
  );
  const before = busy.state.received;
  busy.resume();
  await until(
    async () => busy.state.received - before,
    (bytes) => bytes > 5 * reply,
  );
  await until(
    async () => busy.pending(),
    (bytes) => bytes === 0,
  );
  assert(!busy.state.closed);
});
