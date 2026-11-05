import type { CommitPublication, ConversationId } from '@earendil-works/pi-durable';
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/workspace';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import {
  Harness,
  LiveDoc,
  NestedCallDoc,
  createRegistry,
  defineDocFamily,
} from '@earendil-works/pi-durable';
import { NodeSqliteDatabase, openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { readFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { PiRuntimeLive } from '../src/index.ts';
import { classifyPublication } from '../src/commands.ts';
import { Metadata, Store } from '../src/documents.ts';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { session, until, fixture } from './runtime-fixture.ts';

test('atomic creation retries and actor/request immutable binding survive restart', async (t) => {
  const f = await fixture(t);
  const target = await f.create();
  assert.deepEqual(await f.create(), target);
  await assert.rejects(
    f.client.command('createChat', { session, requestId: 'create', title: 'Changed' }),
    { code: 'InvalidInput' },
  );
  const list = await f.client.command('listChats', { session });
  assert.equal(list.conversations.length, 1);
  await f.restart();
  assert.deepEqual(await f.create(), target);
  assert.equal(f.faux.state.callCount, 0);
  await assert.rejects(
    f.client.command('listChats', { session: { ...session, actorId: 'other' } }),
    { code: 'Unauthorized' },
  );
});

test('duplicate/lost Send, read-only lookup, restart and cross-operation reuse never resend', async (t) => {
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage('Hello')]);
  const input = { target, requestId: 'send', text: 'Question' };
  const receipts = await Promise.all([
    f.client.command('sendChat', input),
    f.client.command('sendChat', input),
  ]);
  assert.deepEqual(receipts[0], receipts[1]);
  await until(
    () => f.client.command('getChat', { target }),
    (s) => s.run === null && s.entries.some((e) => e.text === 'Hello'),
  );
  assert.equal(f.faux.state.callCount, 1);
  await assert.rejects(f.client.command('sendChat', { ...input, text: 'changed' }), {
    code: 'InvalidInput',
  });
  await assert.rejects(f.client.command('sendChat', { ...input, requestId: 'create' }), {
    code: 'InvalidInput',
  });
  assert.equal(await f.client.command('getChatSend', { target, requestId: 'unknown' }), null);
  await f.restart();
  assert.deepEqual(
    await f.client.command('getChatSend', { target, requestId: 'send' }),
    receipts[0],
  );
  assert.deepEqual(await f.client.command('sendChat', input), receipts[0]);
  assert.equal(f.faux.state.callCount, 1);
});

for (const admitted of [false, true])
  test(`interrupted ${admitted ? 'admitted binding' : 'reservation'} recovers without implicit resubmission`, async (t) => {
    const original = Harness.open;
    let fail = true;
    mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
      const harness = await original(...args),
        get = harness.conversation.bind(harness);
      harness.conversation = async (...values: Parameters<typeof get>) => {
        const conversation = await get(...values);
        if (conversation) {
          const submit = conversation.submit.bind(conversation);
          conversation.submit = async (...input: Parameters<typeof submit>) => {
            if (fail) {
              fail = false;
              if (admitted) await submit(...input);
              throw Error('Controlled lost admission response');
            }
            return submit(...input);
          };
        }
        return conversation;
      };
      return harness;
    });
    t.after(async () => mock.restoreAll());
    const f = await fixture(t),
      target = await f.create();
    f.faux.setResponses([fauxAssistantMessage('Once')]);
    const input = { target, requestId: 'lost', text: 'Retained' };
    await assert.rejects(f.client.command('sendChat', input), { code: 'Uncertain' });
    await f.restart();
    const receipt = await f.client.command('getChatSend', { target, requestId: 'lost' });
    assert.equal(receipt?.admission, admitted ? 'admitted' : 'reserved');
    const before = f.faux.state.callCount;
    await f.client.command('getChat', { target });
    await f.client.command('listChats', { session });
    assert.equal(f.faux.state.callCount, before);
    if (!admitted) {
      assert.equal(before, 0);
      assert.equal((await f.client.command('getChat', { target })).state, 'uncertain');
    }
    assert.equal((await f.client.command('sendChat', input)).admission, 'admitted');
    await until(
      () => f.client.command('getChat', { target }),
      (s) => s.run === null && s.entries.some((e) => e.text === 'Once'),
    );
    assert.equal(f.faux.state.callCount, 1);
  });

test('real SQLite full failure is visible and old committed chats survive reopen', async (t) => {
  const original = NodeSqliteDatabase.prototype.transaction;
  let database: NodeSqliteDatabase | undefined;
  mock.method(NodeSqliteDatabase.prototype, 'transaction', function <
    T,
  >(this: NodeSqliteDatabase, callback: Parameters<typeof original>[0]) {
    // oxlint-disable-next-line no-this-alias -- Capture the actual database used by this intercepted native transaction.
    database = this;
    return original.call(this, callback) as Promise<T>;
  });
  const f = await fixture(t),
    target = await f.create();
  mock.restoreAll();
  const pages = await database!.get<{ page_count: number }>('PRAGMA page_count');
  await database!.exec('PRAGMA max_page_count=' + pages!.page_count);
  await assert.rejects(
    f.client.command('sendChat', { target, requestId: 'full', text: 'x'.repeat(32768) }),
    (e) =>
      !!e &&
      typeof e === 'object' &&
      'code' in e &&
      ['Persistence', 'Uncertain'].includes(String(e.code)),
  );
  await assert.rejects(f.client.command('getChatHost', { host: session.host }), {
    code: 'Persistence',
  });
  assert.equal(f.faux.state.callCount, 0);
  await f.restart();
  assert.deepEqual(
    (await f.client.command('listChats', { session })).conversations[0].target,
    target,
  );
  assert.equal(await f.client.command('getChatSend', { target, requestId: 'full' }), null);
});

test('fixed store authority rejects model/cwd/actor/host retargeting without executing work', async (t) => {
  const f = await fixture(t);
  await f.create();
  await f.dispose();
  const alternate = fauxProvider({ provider: 'alternate', models: [{ id: 'alternate' }] });
  f.config.models.setProvider(alternate.provider);
  for (const change of [
    { model: { provider: 'alternate', modelId: 'alternate' } },
    { actorId: 'other' },
    { host: { ...session.host, storeId: 'other' } },
    { cwd: tmpdir() },
  ]) {
    const runtime = ManagedRuntime.make(PiRuntimeLive({ ...f.config, ...change }));
    try {
      await assert.rejects(
        makeChatClient(runtime).command('getChatHost', { host: change.host ?? session.host }),
        { code: 'Incompatible' },
      );
    } finally {
      await runtime.dispose();
    }
  }
  await f.restart();
  assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
  assert.equal(f.faux.state.callCount, 0);
});

test('selected Pi coding-tool runtime executes in the fixed cwd once and retained Send does not rerun native work after reopen', async (t) => {
  const registry = createRegistry();
  registry.install(CodingTools);
  const f = await fixture(t, registry, { tokenSize: { min: 65536, max: 65536 } }),
    target = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('bash', { command: 'printf x >> counted.txt; printf "%s" "$$" > native.pid' }),
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Native complete'),
  ]);
  const input = { target, requestId: 'native', text: 'One controlled native effect' };
  const receipt = await f.client.command('sendChat', input);
  await until(
    () => f.client.command('getChat', { target }),
    (s) => !s.run && s.entries.some((e) => e.text === 'Native complete'),
  );
  assert.equal(await readFile(join(f.config.cwd, 'counted.txt'), 'utf8'), 'x');
  const pid = Number(await readFile(join(f.config.cwd, 'native.pid'), 'utf8'));
  assert.throws(
    () => process.kill(pid, 0),
    (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'ESRCH',
  );
  await f.restart();
  assert.deepEqual(await f.client.command('sendChat', input), receipt);
  assert.equal(await readFile(join(f.config.cwd, 'counted.txt'), 'utf8'), 'x');
  assert.equal(f.faux.state.callCount, 2);
});

for (const typed of [false, true])
  test(`R1 create reply-read failure after real commit is uncertain (${typed ? 'typed' : 'unknown'}) and exact retry survives restart`, async (t) => {
    const original = Harness.open;
    let harness: Harness | undefined;
    mock.method(
      Harness,
      'open',
      async (...args: Parameters<typeof original>) => (harness = await original(...args)),
    );
    const f = await fixture(t);
    await f.client.command('getChatHost', { host: session.host });
    mock.restoreAll();
    const committed: string[] = [];
    const off = harness!.subscribeCommits((publication) => {
      for (const change of publication.changes)
        if (change.type === 'conversation') committed.push(String(change.value.id));
    });
    const snapshot = harness!.snapshot.bind(harness!);
    let reads = 0;
    mock.method(harness!, 'snapshot', async (...args: Parameters<typeof snapshot>) => {
      if (reads++ === 0)
        throw typed
          ? new ApplicationError({
              code: 'Persistence',
              message: 'Controlled post-commit read failure',
            })
          : Error('Controlled post-commit read failure');
      return snapshot(...args);
    });
    const input = { session, requestId: 'committed-create', title: 'Original saved chat' };
    let failure: unknown;
    try {
      await f.client.command('createChat', input).catch((error) => {
        failure = error;
      });
    } finally {
      mock.restoreAll();
      await off();
    }
    assert.equal(committed.length, 1);
    assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
    await f.restart();
    const recovered = await f.client.command('createChat', input);
    assert.equal(recovered.conversation.target.conversationId, committed[0]);
    assert.deepEqual(await f.client.command('createChat', input), recovered);
    await assert.rejects(f.client.command('createChat', { ...input, title: 'Changed' }), {
      code: 'InvalidInput',
    });
    assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(
      (failure as { code?: string })?.code,
      'Uncertain',
      'a real committed conversation appeared definitively rejected',
    );
  });

test('R1 lost typed commit acknowledgement stays uncertain while proven create validation stays definite', async (t) => {
  const original = Harness.open;
  let harness: Harness | undefined;
  mock.method(
    Harness,
    'open',
    async (...args: Parameters<typeof original>) => (harness = await original(...args)),
  );
  const f = await fixture(t);
  await f.client.command('getChatHost', { host: session.host });
  mock.restoreAll();
  const committed: string[] = [];
  const off = harness!.subscribeCommits((publication) => {
    for (const change of publication.changes)
      if (change.type === 'conversation') committed.push(String(change.value.id));
  });
  const commit = harness!.commit.bind(harness!);
  let calls = 0;
  mock.method(harness!, 'commit', async (...args: Parameters<typeof commit>) => {
    calls++;
    await commit(...args);
    throw new ApplicationError({
      code: 'Persistence',
      message: 'Controlled lost commit acknowledgement',
    });
  });
  const input = { session, requestId: 'lost-commit', title: 'Committed' };
  try {
    await assert.rejects(f.client.command('createChat', { ...input, title: '' }), {
      code: 'InvalidInput',
    });
    await assert.rejects(
      f.client.command('createChat', { ...input, session: { ...session, actorId: 'other' } }),
      { code: 'Unauthorized' },
    );
    assert.equal(calls, 0);
    await assert.rejects(f.client.command('createChat', input), { code: 'Uncertain' });
  } finally {
    mock.restoreAll();
    await off();
  }
  assert.equal(committed.length, 1);
  await f.restart();
  const recovered = await f.client.command('createChat', input);
  assert.equal(recovered.conversation.target.conversationId, committed[0]);
  await assert.rejects(f.client.command('createChat', { ...input, title: 'Changed' }), {
    code: 'InvalidInput',
  });
  assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
  assert.equal(f.faux.state.callCount, 0);
});

for (const family of ['store', 'metadata', 'request', 'binding'] as const)
  test(`strict ${family} saved payload preserves its exact bytes and refuses admission/reconciliation`, async (t) => {
    const original = Harness.open;
    let harness!: Harness;
    mock.method(
      Harness,
      'open',
      async (...args: Parameters<typeof original>) => (harness = await original(...args)),
    );
    t.after(() => mock.restoreAll());
    const f = await fixture(t),
      target = await f.create();
    f.faux.setResponses([fauxAssistantMessage('Original completed')]);
    await f.client.command('sendChat', { target, requestId: 'saved-send', text: 'Original' });
    await until(
      () => f.client.command('getChat', { target }),
      (value) => !value.run,
    );
    const kind = family === 'binding' ? 'request' : family;
    const initial = () => ({ binding: '', future: null as { nested: boolean } | null });
    const sessionDoc = defineDocFamily({
      kind: 'moonbase.chat.' + kind,
      version: 1,
      scope: 'session',
      family: true,
      initial,
      checkpointWhen: () => true,
    });
    const metadataDoc = defineDocFamily({
      kind: 'moonbase.chat.metadata',
      version: 1,
      scope: 'conversation',
      family: true,
      history: 'latest',
      fork: 'current',
      initial,
      checkpointWhen: () => true,
    });
    let docKey = JSON.stringify([session.actorId, 'saved-send']);
    if (kind === 'store') docKey = 'identity';
    if (kind === 'metadata') docKey = 'metadata';
    // Fixture edits only Moonbase-owned payloads through the public document API.
    const get = () =>
      kind === 'metadata'
        ? harness.snapshot(
            metadataDoc,
            Number(target.conversationId) as ConversationId,
            docKey,
            BACKGROUND_CONTEXT,
          )
        : harness.snapshot(sessionDoc, docKey, BACKGROUND_CONTEXT);
    await harness.commit(async (tx) => {
      const value =
        kind === 'metadata'
          ? await tx.doc(metadataDoc, Number(target.conversationId) as ConversationId, docKey, null)
          : await tx.doc(sessionDoc, docKey, null);
      if (family === 'binding') {
        const bound = JSON.parse(value.binding);
        bound.target.host.future = { nested: true };
        value.binding = JSON.stringify(bound);
      } else value.future = { nested: true };
    }, BACKGROUND_CONTEXT);
    const before = JSON.stringify(await get());
    let commits = 0;
    const off = harness.subscribeCommits(() => {
      commits++;
    });
    try {
      if (kind === 'store')
        await assert.rejects(f.client.command('getChatHost', { host: session.host }), {
          code: 'Persistence',
        });
      else {
        await assert.rejects(
          f.client.command('sendChat', { target, requestId: 'saved-send', text: 'Original' }),
          { code: 'Persistence' },
        );
        await assert.rejects(f.client.command('getChatSend', { target, requestId: 'saved-send' }), {
          code: 'Persistence',
        });
      }
      assert.equal(commits, 0);
      assert.equal(JSON.stringify(await get()), before);
      assert.equal(f.faux.state.callCount, 1);
    } finally {
      off();
    }
    await f.restart();
    if (kind === 'store')
      await assert.rejects(f.client.command('getChatHost', { host: session.host }), {
        code: 'Persistence',
      });
    else
      await assert.rejects(f.client.command('getChatSend', { target, requestId: 'saved-send' }), {
        code: 'Persistence',
      });
    await f.dispose();
    const database = await openNodeSqliteDatabase(f.config.databasePath),
      storage = await SqliteStorage.open(database);
    try {
      const page = await storage.scanDocuments(
        {
          scope:
            kind === 'metadata'
              ? {
                  kind: 'conversation',
                  conversationId: Number(target.conversationId) as ConversationId,
                }
              : { kind: 'session' },
          at: 'current',
          kind: 'moonbase.chat.' + kind,
        },
        32,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const record = page.items.find((record) => record.key === docKey);
      assert(record);
      assert.equal(
        JSON.stringify((await storage.document(record.id, 'current', BACKGROUND_CONTEXT))!.value),
        before,
      );
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
    assert.equal(f.faux.state.callCount, 1);
  });

test('unsupported app-owned document version is rejected unchanged before resume or automatic publication', async (t) => {
  const f = await fixture(t);
  await f.create();
  await f.dispose();
  const change = async (write: boolean) => {
    const database = await openNodeSqliteDatabase(f.config.databasePath),
      storage = await SqliteStorage.open(database);
    try {
      const page = await storage.scanDocuments(
        { scope: { kind: 'session' }, kind: 'moonbase.chat.store', at: 'current' },
        1,
        undefined,
        BACKGROUND_CONTEXT,
      );
      const document = await storage.document(page.items[0].id, 'current', BACKGROUND_CONTEXT);
      assert(document);
      if (write)
        await storage.commit(
          [
            {
              type: 'document.change',
              id: document.record.id,
              content: { kind: 'base', version: 2, value: document.value },
            },
          ],
          BACKGROUND_CONTEXT,
        );
      return { value: JSON.stringify(document.value), version: document.version };
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  };
  const original = await change(true);
  await f.restart();
  await assert.rejects(f.client.command('getChatHost', { host: session.host }), {
    code: 'Persistence',
  });
  await f.dispose();
  assert.deepEqual(await change(false), { value: original.value, version: 2 });
  assert.equal(f.faux.state.callCount, 0);
});

test('strict programmatic configuration and cursor envelopes reject nested unfamiliar fields without diagnostics or execution', async (t) => {
  const f = await fixture(t),
    canary = 'private-config-field-canary';
  for (const change of [
    { future: canary },
    { host: { ...session.host, future: canary } },
    { model: { ...f.config.model, future: canary } },
    { cwd: canary },
    { databasePath: '/private/' + 'x'.repeat(4096) },
  ]) {
    const runtime = ManagedRuntime.make(PiRuntimeLive({ ...f.config, ...change }));
    try {
      await assert.rejects(
        makeChatClient(runtime).command('getChatHost', { host: session.host }),
        (error: unknown) => {
          assert(ApplicationError.is(error));
          assert.equal(error.code, 'InvalidInput');
          assert(!error.message.includes(canary));
          assert(!error.message.includes(f.config.cwd));
          return true;
        },
      );
    } finally {
      await runtime.dispose();
    }
  }
  const target = await f.create();
  for (const payload of [
    { kind: 'history', scan: null, future: canary },
    { kind: 'history', scan: { start: true, future: canary } },
    { kind: 'history', scan: [] },
    { kind: 'unknown', scan: null },
  ])
    await assert.rejects(
      f.client.command('getChatHistory', {
        target,
        cursor: Buffer.from(JSON.stringify(payload)).toString('base64url'),
      }),
      { code: 'InvalidInput' },
    );
  assert.equal(f.faux.state.callCount, 0);
});

test('maximum escaped Send text retains its original serialized binding across retry and restart', async (t) => {
  const f = await fixture(t),
    target = await f.create();
  f.faux.setResponses([fauxAssistantMessage('Escaped input completed')]);
  const input = { target, requestId: 'escaped-binding', text: '\u0001'.repeat(32768) };
  assert(Buffer.byteLength(JSON.stringify({ operation: 'sendChat', ...input })) > 64 * 1024);
  const receipt = await f.client.command('sendChat', input);
  await until(
    () => f.client.command('getChat', { target }),
    (value) =>
      !value.run && value.entries.some((entry) => entry.text === 'Escaped input completed'),
  );
  assert.deepEqual(await f.client.command('sendChat', input), receipt);
  await f.restart();
  assert.deepEqual(
    await f.client.command('getChatSend', { target, requestId: input.requestId }),
    receipt,
  );
  assert.deepEqual(await f.client.command('sendChat', input), receipt);
  assert.equal(f.faux.state.callCount, 1);
});

for (const state of ['admitted', 'pending', 'empty'] as const)
  test(`Send refuses to rewrite a saved ${state} request without its captured conversation`, async (t) => {
    const original = Harness.open;
    let harness!: Harness;
    mock.method(Harness, 'open', async (...args: Parameters<typeof original>) => {
      harness = await original(...args);
      if (state === 'pending') {
        const get = harness.conversation.bind(harness);
        harness.conversation = async (...args: Parameters<typeof get>) => {
          const conversation = await get(...args);
          if (conversation)
            conversation.submit = async () => {
              throw Error('Controlled reserved intent');
            };
          return conversation;
        };
      }
      return harness;
    });
    t.after(() => mock.restoreAll());
    const f = await fixture(t),
      target = await f.create(),
      input = { target, requestId: 'captured', text: 'Original' };
    f.faux.setResponses([fauxAssistantMessage('Original completed')]);
    if (state === 'pending')
      await assert.rejects(f.client.command('sendChat', input), { code: 'Uncertain' });
    else {
      await f.client.command('sendChat', input);
      await until(
        () => f.client.command('getChat', { target }),
        (value) => !value.run,
      );
    }
    const request = defineDocFamily({
        kind: 'moonbase.chat.request',
        version: 1,
        scope: 'session',
        family: true,
        initial: (binding: string) => ({
          binding,
          conversationId: null as string | null,
          submissionId: null as string | null,
          pending: false,
        }),
        checkpointWhen: () => true,
      }),
      requestKey = JSON.stringify([session.actorId, input.requestId]);
    await harness.commit(async (tx) => {
      const value = await tx.doc(request, requestKey, '');
      value.conversationId = null;
      if (state === 'empty') {
        value.submissionId = null;
        value.pending = false;
      }
    }, BACKGROUND_CONTEXT);
    const before = JSON.stringify(await harness.snapshot(request, requestKey, BACKGROUND_CONTEXT)),
      calls = f.faux.state.callCount;
    let commits = 0;
    const off = harness.subscribeCommits(() => {
      commits++;
    });
    try {
      await assert.rejects(f.client.command('sendChat', input), { code: 'Persistence' });
      await assert.rejects(
        f.client.command('getChatSend', { target, requestId: input.requestId }),
        { code: 'Persistence' },
      );
      assert.equal(commits, 0);
      assert.equal(
        JSON.stringify(await harness.snapshot(request, requestKey, BACKGROUND_CONTEXT)),
        before,
      );
      assert.equal(f.faux.state.callCount, calls);
    } finally {
      off();
    }
  });

test('escaped identity components open and reopen without an extra serialized identity limit', async (t) => {
  const directory = await mkdtemp('/tmp/moonbase-pi-identity-escaped-');
  let cwd = directory;
  while (Buffer.byteLength(cwd) < 979)
    cwd = join(cwd, String.fromCharCode(1).repeat(Math.min(230, 980 - Buffer.byteLength(cwd) - 1)));
  await mkdir(cwd, { recursive: true });
  const models = createModels(),
    faux = fauxProvider({ provider: 'p'.repeat(255), models: [{ id: '\u0002'.repeat(256) }] });
  models.setProvider(faux.provider);
  const session = {
      host: { hostId: 'h'.repeat(256), storeId: 's'.repeat(256) },
      actorId: 'a'.repeat(256),
    },
    model = { provider: faux.provider.id, modelId: faux.getModel().id },
    config = { ...session, cwd, databasePath: join(directory, 'chat.sqlite'), model, models };
  assert(Buffer.byteLength(JSON.stringify({ ...session, cwd, model })) > 8192);
  let runtime = ManagedRuntime.make(PiRuntimeLive(config));
  t.after(async () => {
    try {
      await runtime.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const host = await makeChatClient(runtime).command('getChatHost', { host: session.host });
  const created = await makeChatClient(runtime).command('createChat', {
    session,
    requestId: 'create',
    title: 'Escaped identity',
  });
  await runtime.dispose();
  runtime = ManagedRuntime.make(PiRuntimeLive(config));
  assert.deepEqual(
    await makeChatClient(runtime).command('getChatHost', { host: session.host }),
    host,
  );
  assert.deepEqual(
    (await makeChatClient(runtime).command('listChats', { session })).conversations[0],
    created.conversation,
  );
  assert.equal(faux.state.callCount, 0);
});

const watched = 1 as ConversationId,
  foreign = 2 as ConversationId;
const publication = (...changes: unknown[]) =>
  ({ seq: 1, changes }) as unknown as CommitPublication;
const document = (
  kind: string,
  conversationId: ConversationId | undefined,
  ops: unknown[],
  value: object | null = {},
  scope = 'conversation',
) => ({ type: 'document', record: { kind, scope: { kind: scope } }, conversationId, value, ops });
const live = (ops: unknown[], value: object | null = {}) =>
  document(LiveDoc.definition.kind, watched, ops, value);
const quiet = {
  relevant: false,
  invalidatesCapture: false,
  resetsHistory: false,
  resetsStatus: false,
  liveRetired: undefined,
};

test('publication classifier keeps streamed progress from invalidating a capture', () => {
  const progress = live([
    ['s', ['generation', 'message'], 'partial'],
    ['a', ['tools', 0, 'output'], 'line'],
    ['s', ['nestedTools', 1, 'droppedBytes'], 3],
  ]);
  assert.deepEqual(classifyPublication(publication(progress), watched), {
    ...quiet,
    relevant: true,
    liveRetired: false,
  });
  for (const ops of [
    [['s', ['run'], {}]],
    [['s', ['tools', 'name', 'output'], 'x']],
    [['s', ['tools', 0, 'state'], 'done']],
    [['r', {}]],
  ])
    assert.deepEqual(classifyPublication(publication(live(ops)), watched), {
      ...quiet,
      relevant: true,
      invalidatesCapture: true,
      liveRetired: false,
    });
});

test('publication classifier resets caches when a watched document is created, copied or retired', () => {
  const resets = {
    relevant: true,
    invalidatesCapture: true,
    resetsHistory: true,
    resetsStatus: true,
  };
  assert.deepEqual(classifyPublication(publication(live([], null)), watched), {
    ...resets,
    liveRetired: true,
  });
  // A replacement in the same commit leaves the live document present.
  assert.deepEqual(
    classifyPublication(publication(live([], null), live([['s', ['run'], {}]])), watched),
    { ...resets, liveRetired: false },
  );
  assert.deepEqual(
    classifyPublication(publication(document(Metadata.definition.kind, watched, [])), watched),
    { ...resets, liveRetired: undefined },
  );
  assert.deepEqual(
    classifyPublication(
      publication({
        type: 'document.copy',
        record: { kind: NestedCallDoc.definition.kind, scope: { kind: 'conversation' } },
        conversationId: watched,
        source: {},
      }),
      watched,
    ),
    { ...resets, liveRetired: undefined },
  );
  assert.deepEqual(
    classifyPublication(
      publication(
        document(Store.definition.kind, undefined, [['s', ['identity'], 'x']], {}, 'session'),
      ),
      watched,
    ),
    { ...resets, liveRetired: undefined },
  );
});

test('publication classifier scopes table changes and ignores unrelated documents', () => {
  const table = (type: string) =>
    type === 'conversation'
      ? { type, value: { id: watched } }
      : { type, value: { conversationId: watched } };
  const changed = { ...quiet, relevant: true, invalidatesCapture: true };
  assert.deepEqual(classifyPublication(publication(table('entry')), watched), {
    ...changed,
    resetsHistory: true,
  });
  assert.deepEqual(classifyPublication(publication(table('task')), watched), {
    ...changed,
    resetsStatus: true,
  });
  assert.deepEqual(classifyPublication(publication(table('conversation')), watched), {
    ...changed,
    resetsHistory: true,
    resetsStatus: true,
  });
  assert.deepEqual(classifyPublication(publication(table('submission')), watched), changed);
  assert.deepEqual(
    classifyPublication(
      publication(
        { type: 'entry', value: { conversationId: foreign } },
        { type: 'conversation', value: { id: foreign } },
        document(LiveDoc.definition.kind, foreign, [], null),
        document('another.kind', watched, []),
        document(Store.definition.kind, undefined, [], {}, 'conversation'),
      ),
      watched,
    ),
    quiet,
  );
  assert.deepEqual(classifyPublication(publication(), watched), quiet);
});
