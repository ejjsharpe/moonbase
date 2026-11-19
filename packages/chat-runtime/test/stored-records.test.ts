import type { ConversationId } from '@earendil-works/pi-durable';
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { ChatService } from '@moonbase/contracts/services';
import { Harness, defineDocFamily } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { session, until, fixture, runChat } from './runtime-fixture.ts';

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
    await runChat(f.runtime, (chat) =>
      chat.sendChat({ target, requestId: 'saved-send', text: 'Original' }),
    );
    await until(
      () => runChat(f.runtime, (chat) => chat.getChat({ target })),
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
        await assert.rejects(
          runChat(f.runtime, (chat) => chat.getChatHost({ host: session.host })),
          { _tag: 'ChatStoreError' },
        );
      else {
        await assert.rejects(
          runChat(f.runtime, (chat) =>
            chat.sendChat({ target, requestId: 'saved-send', text: 'Original' }),
          ),
          // A Send's own journal that fails to decode may hide an earlier attempt's commit.
          { _tag: kind === 'request' ? 'UncertainError' : 'ChatStoreError' },
        );
        await assert.rejects(
          runChat(f.runtime, (chat) => chat.getChatSend({ target, requestId: 'saved-send' })),
          { _tag: 'ChatStoreError' },
        );
      }
      assert.equal(commits, 0);
      assert.equal(JSON.stringify(await get()), before);
      assert.equal(f.faux.state.callCount, 1);
    } finally {
      off();
    }
    await f.restart();
    if (kind === 'store')
      await assert.rejects(f.runtime.runPromise(ChatService), { _tag: 'ChatStoreError' });
    else
      await assert.rejects(
        runChat(f.runtime, (chat) => chat.getChatSend({ target, requestId: 'saved-send' })),
        { _tag: 'ChatStoreError' },
      );
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
  await assert.rejects(f.runtime.runPromise(ChatService), { _tag: 'ChatStoreError' });
  await f.dispose();
  assert.deepEqual(await change(false), { value: original.value, version: 2 });
  assert.equal(f.faux.state.callCount, 0);
});
