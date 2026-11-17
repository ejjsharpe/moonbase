import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { ChatService } from '@moonbase/contracts/services';
import { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { session, fixture, localPiRuntime } from '../runtime-fixture.ts';

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
test('store authority rejects actor/host retargeting without executing work', async (t) => {
  const f = await fixture(t);
  await f.create();
  await f.dispose();
  for (const change of [{ actorId: 'other' }, { host: { ...session.host, storeId: 'other' } }]) {
    const runtime = ManagedRuntime.make(
      localPiRuntime({
        ...session,
        databasePath: f.config.databasePath,
        models: f.config.models,
        ...change,
      }),
    );
    try {
      await assert.rejects(runtime.runPromise(ChatService), {
        _tag: 'ChatStoreMismatchError',
        mismatch: 'bound',
      });
    } finally {
      await runtime.dispose();
    }
  }
  await f.restart();
  assert.equal((await f.client.command('listChats', { session })).conversations.length, 1);
  assert.equal(f.faux.state.callCount, 0);
});
test('escaped identity components open and reopen without an extra serialized identity limit', async (t) => {
  const directory = await realpath(await mkdtemp('/tmp/moonbase-pi-identity-escaped-'));
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
    config = { ...session, databasePath: join(directory, 'chat.sqlite'), models };
  assert(Buffer.byteLength(JSON.stringify({ ...session, cwd, model })) > 8192);
  let runtime = ManagedRuntime.make(localPiRuntime(config));
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
    settings: { cwd, model },
  });
  await runtime.dispose();
  runtime = ManagedRuntime.make(localPiRuntime(config));
  assert.deepEqual(
    await makeChatClient(runtime).command('getChatHost', { host: session.host }),
    host,
  );
  assert.deepEqual(
    (await makeChatClient(runtime).command('listChats', { session })).conversations[0],
    // A listing adds the chat's activity: never run, so idle since it was created.
    {
      ...created.conversation,
      activity: { state: 'idle', at: created.conversation.createdAt },
    },
  );
  assert.equal(faux.state.callCount, 0);
});
